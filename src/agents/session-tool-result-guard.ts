import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import type {
  PluginHookBeforeMessageWriteEvent,
  PluginHookBeforeMessageWriteResult,
} from "../plugins/types.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { makeMissingToolResult, sanitizeToolCallInputs } from "./session-transcript-repair.js";
import { extractToolCallsFromAssistant, extractToolResultId } from "./tool-call-id.js";
import { writeToolOutputArtifactSync } from "./tool-output-artifacts.js";
import {
  hardTruncateText,
  makeHardLimitSuffix,
  TOOL_OUTPUT_HARD_MAX_BYTES,
  TOOL_OUTPUT_HARD_MAX_BYTES_EXEC,
  TOOL_OUTPUT_HARD_MAX_LINES,
  TOOL_OUTPUT_HARD_MAX_LINES_EXEC,
} from "./tool-output-hard-cap.js";

type ToolOutputCaps = { maxBytes: number; maxLines: number };

function resolveToolOutputCaps(toolName?: string | null): ToolOutputCaps {
  if (toolName === "exec") {
    return {
      maxBytes: TOOL_OUTPUT_HARD_MAX_BYTES_EXEC,
      maxLines: TOOL_OUTPUT_HARD_MAX_LINES_EXEC,
    };
  }
  return {
    maxBytes: TOOL_OUTPUT_HARD_MAX_BYTES,
    maxLines: TOOL_OUTPUT_HARD_MAX_LINES,
  };
}

const GUARD_TRUNCATION_SUFFIX = makeHardLimitSuffix({
  context: "Content truncated during persistence",
});

/**
 * Apply the system toolResult hard-cap policy before persisting to a session transcript.
 * Returns the original message reference when no changes are needed.
 */
function hardCapToolResultMessageForPersistence(
  msg: AgentMessage,
  meta?: { toolName?: string | null; toolCallId?: string | null },
): AgentMessage {
  const role = (msg as { role?: string }).role;
  if (role !== "toolResult") {
    return msg;
  }

  const caps = resolveToolOutputCaps(meta?.toolName);

  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return msg;
  }

  // Flatten text blocks so we can enforce a strict global cap (bytes + lines).
  // If we need to cap, we also drop non-text blocks to avoid persisting large
  // binary payloads (e.g. base64 images) into the session context.
  let combined = "";
  let nonTextBlocks = 0;
  for (const block of content) {
    if (!block || typeof block !== "object" || (block as { type?: string }).type !== "text") {
      nonTextBlocks += 1;
      continue;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text !== "string" || !text) {
      continue;
    }
    combined = combined ? `${combined}\n${text}` : text;
  }

  if (!combined) {
    // Even without text blocks, enforce a total byte cap on the serialized message
    // to prevent large non-text payloads (e.g. base64 images) from bloating the transcript.
    if (nonTextBlocks > 0) {
      try {
        const bytes = Buffer.byteLength(JSON.stringify(msg), "utf8");
        if (bytes > caps.maxBytes) {
          return {
            ...msg,
            content: [
              {
                type: "text" as const,
                text:
                  `⚠️ [Tool result contained ${nonTextBlocks} non-text block(s) totaling ${bytes} bytes — ` +
                  `exceeded hard limit (${caps.maxBytes} bytes). Content removed during persistence.]`,
              },
            ],
          } as AgentMessage;
        }
      } catch {
        // Serialization failed — cap it defensively
        return {
          ...msg,
          content: [
            {
              type: "text" as const,
              text: `⚠️ [Tool result contained non-serializable content — removed during persistence.]`,
            },
          ],
        } as AgentMessage;
      }
    }
    return msg;
  }

  let forceTextOnly = nonTextBlocks > 0;
  if (!forceTextOnly) {
    try {
      const bytes = Buffer.byteLength(JSON.stringify(msg), "utf8");
      forceTextOnly = bytes > caps.maxBytes;
    } catch {
      forceTextOnly = true;
    }
  }

  const prefix = forceTextOnly
    ? `${combined}\n⚠️ [Tool result normalized during persistence to enforce output caps.]`
    : combined;

  const capped = hardTruncateText(prefix, {
    maxBytes: caps.maxBytes,
    maxLines: caps.maxLines,
    suffix: GUARD_TRUNCATION_SUFFIX,
  });

  if (!forceTextOnly && !capped.truncated) {
    return msg;
  }

  let persistedText = capped.text;
  if (capped.truncated) {
    const outputFile = writeToolOutputArtifactSync({
      toolName: meta?.toolName || "toolResult",
      toolCallId: meta?.toolCallId || `${meta?.toolName || "toolResult"}-persist`,
      output: combined,
      extension: "log",
    });
    const pointer = outputFile
      ? `💾 [Full output saved to: ${outputFile}]`
      : "💾 [Full output failed to save to artifact file]";
    const cappedWithPointer = hardTruncateText(prefix, {
      maxBytes: caps.maxBytes,
      maxLines: caps.maxLines,
      suffix: (truncateMeta) => `${GUARD_TRUNCATION_SUFFIX(truncateMeta)}\n${pointer}`,
    });
    persistedText = cappedWithPointer.text;
  }

  return {
    ...msg,
    content: [{ type: "text", text: persistedText }],
  } as AgentMessage;
}

export function installSessionToolResultGuard(
  sessionManager: SessionManager,
  opts?: {
    /**
     * Optional transform applied to any message before persistence.
     */
    transformMessageForPersistence?: (message: AgentMessage) => AgentMessage;
    /**
     * Optional, synchronous transform applied to toolResult messages *before* they are
     * persisted to the session transcript.
     */
    transformToolResultForPersistence?: (
      message: AgentMessage,
      meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
    ) => AgentMessage;
    /**
     * Whether to synthesize missing tool results to satisfy strict providers.
     * Defaults to true.
     */
    allowSyntheticToolResults?: boolean;
    /**
     * Synchronous hook invoked before any message is written to the session JSONL.
     * If the hook returns { block: true }, the message is silently dropped.
     * If it returns { message }, the modified message is written instead.
     */
    beforeMessageWriteHook?: (
      event: PluginHookBeforeMessageWriteEvent,
    ) => PluginHookBeforeMessageWriteResult | undefined;
  },
): {
  flushPendingToolResults: () => void;
  getPendingIds: () => string[];
} {
  const originalAppend = sessionManager.appendMessage.bind(sessionManager);
  const pending = new Map<string, string | undefined>();
  const persistMessage = (message: AgentMessage) => {
    const transformer = opts?.transformMessageForPersistence;
    return transformer ? transformer(message) : message;
  };

  const persistToolResult = (
    message: AgentMessage,
    meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
  ) => {
    const transformer = opts?.transformToolResultForPersistence;
    return transformer ? transformer(message, meta) : message;
  };

  const allowSyntheticToolResults = opts?.allowSyntheticToolResults ?? true;
  const beforeWrite = opts?.beforeMessageWriteHook;

  /**
   * Run the before_message_write hook. Returns the (possibly modified) message,
   * or null if the message should be blocked.
   */
  const applyBeforeWriteHook = (msg: AgentMessage): AgentMessage | null => {
    if (!beforeWrite) {
      return msg;
    }
    const result = beforeWrite({ message: msg });
    if (result?.block) {
      return null;
    }
    if (result?.message) {
      return result.message;
    }
    return msg;
  };

  const flushPendingToolResults = () => {
    if (pending.size === 0) {
      return;
    }
    if (allowSyntheticToolResults) {
      for (const [id, name] of pending.entries()) {
        const synthetic = makeMissingToolResult({ toolCallId: id, toolName: name });
        const transformed = persistToolResult(persistMessage(synthetic), {
          toolCallId: id,
          toolName: name,
          isSynthetic: true,
        });
        const hooked = applyBeforeWriteHook(transformed);
        if (!hooked) {
          continue;
        }
        // Apply the hard cap *after* any hook transforms so plugins can't re-inflate tool results.
        const capped = hardCapToolResultMessageForPersistence(hooked, {
          toolName: name,
          toolCallId: id,
        });
        originalAppend(capped as never);
      }
    }
    pending.clear();
  };

  const guardedAppend = (message: AgentMessage) => {
    let nextMessage = message;
    const role = (message as { role?: unknown }).role;
    if (role === "assistant") {
      const sanitized = sanitizeToolCallInputs([message]);
      if (sanitized.length === 0) {
        if (allowSyntheticToolResults && pending.size > 0) {
          flushPendingToolResults();
        }
        return undefined;
      }
      nextMessage = sanitized[0];
    }
    const nextRole = (nextMessage as { role?: unknown }).role;

    if (nextRole === "toolResult") {
      const id = extractToolResultId(nextMessage as Extract<AgentMessage, { role: "toolResult" }>);
      const toolName = id ? pending.get(id) : undefined;
      if (id) {
        pending.delete(id);
      }
      // Apply the hard cap before + after hook transforms so persisted tool results
      // always conform to the system limits.
      const preCapped = hardCapToolResultMessageForPersistence(persistMessage(nextMessage), {
        toolName,
        toolCallId: id,
      });
      const transformed = persistToolResult(preCapped, {
        toolCallId: id ?? undefined,
        toolName,
        isSynthetic: false,
      });
      const hooked = applyBeforeWriteHook(transformed);
      if (!hooked) {
        return undefined;
      }
      const postCapped = hardCapToolResultMessageForPersistence(hooked, {
        toolName,
        toolCallId: id,
      });
      return originalAppend(postCapped as never);
    }

    const toolCalls =
      nextRole === "assistant"
        ? extractToolCallsFromAssistant(nextMessage as Extract<AgentMessage, { role: "assistant" }>)
        : [];

    if (allowSyntheticToolResults) {
      // If previous tool calls are still pending, flush before non-tool results.
      if (pending.size > 0 && (toolCalls.length === 0 || nextRole !== "assistant")) {
        flushPendingToolResults();
      }
      // If new tool calls arrive while older ones are pending, flush the old ones first.
      if (pending.size > 0 && toolCalls.length > 0) {
        flushPendingToolResults();
      }
    }

    const finalMessage = applyBeforeWriteHook(persistMessage(nextMessage));
    if (!finalMessage) {
      return undefined;
    }
    const result = originalAppend(finalMessage as never);

    const sessionFile = (
      sessionManager as { getSessionFile?: () => string | null }
    ).getSessionFile?.();
    if (sessionFile) {
      emitSessionTranscriptUpdate(sessionFile);
    }

    if (toolCalls.length > 0) {
      for (const call of toolCalls) {
        pending.set(call.id, call.name);
      }
    }

    return result;
  };

  // Monkey-patch appendMessage with our guarded version.
  sessionManager.appendMessage = guardedAppend as SessionManager["appendMessage"];

  return {
    flushPendingToolResults,
    getPendingIds: () => Array.from(pending.keys()),
  };
}
