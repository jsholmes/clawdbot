import fs from "node:fs/promises";
import path from "node:path";
import { completeSimple } from "@mariozechner/pi-ai";
import { resolveOpenClawAgentDir } from "../../agents/agent-paths.js";
import { getApiKeyForModel } from "../../agents/model-auth.js";
import { resolveModel } from "../../agents/pi-embedded-runner/model.js";
import {
  DEFAULT_OVERFLOW_RECOVERY_CONFIG,
  loadSessionTranscriptMessages,
  performOverflowRecovery,
  rewriteSessionWithSummary,
} from "../../agents/pi-embedded-runner/overflow-recovery.js";
import { resolveSessionFilePath, resolveSessionFilePathOptions } from "../../config/sessions.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import type { CommandHandler } from "./commands-types.js";

// ---------------------------------------------------------------------------
// /distill command handler
// ---------------------------------------------------------------------------

export const handleDistillCommand: CommandHandler = async (params) => {
  const body = params.command.commandBodyNormalized;
  if (!body.startsWith("/distill")) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    return { shouldContinue: false };
  }

  // Parse mode arg: /distill [export|compact] — default export
  const arg = body.slice("/distill".length).trim().toLowerCase();
  const mode: "export" | "compact" = arg === "compact" ? "compact" : "export";

  if (!params.sessionEntry?.sessionId) {
    return {
      shouldContinue: false,
      reply: { text: "⚙️ /distill unavailable (missing session id)." },
    };
  }

  const sessionId = params.sessionEntry.sessionId;
  const sessionFilePath = resolveSessionFilePath(
    sessionId,
    params.sessionEntry,
    resolveSessionFilePathOptions({
      agentId: params.agentId,
      storePath: params.storePath,
    }),
  );

  // Load session
  const messages = await loadSessionTranscriptMessages(sessionFilePath);
  if (messages.length === 0) {
    return {
      shouldContinue: false,
      reply: { text: "⚙️ Nothing to distil — session is empty." },
    };
  }

  // Resolve distill config from overflowRecovery config (reuses same config surface)
  const rawCfg = (params.cfg as Record<string, unknown>)?.agents as
    | { defaults?: { contextPruning?: { overflowRecovery?: Record<string, unknown> } } }
    | undefined;
  const rawDistillCfg = rawCfg?.defaults?.contextPruning?.overflowRecovery;
  const distillCfg = {
    ...DEFAULT_OVERFLOW_RECOVERY_CONFIG,
    enabled: true, // always enabled when explicitly invoked via /distill
    model: (rawDistillCfg?.model as string | undefined) ?? DEFAULT_OVERFLOW_RECOVERY_CONFIG.model,
    pass1Model: rawDistillCfg?.pass1Model as string | undefined,
    pass2Model: rawDistillCfg?.pass2Model as string | undefined,
    keepLastTurns:
      (rawDistillCfg?.keepLastTurns as number | undefined) ??
      DEFAULT_OVERFLOW_RECOVERY_CONFIG.keepLastTurns,
    maxSummaryChars:
      (rawDistillCfg?.maxSummaryChars as number | undefined) ??
      DEFAULT_OVERFLOW_RECOVERY_CONFIG.maxSummaryChars,
    maxInputChars:
      (rawDistillCfg?.maxInputChars as number | undefined) ??
      DEFAULT_OVERFLOW_RECOVERY_CONFIG.maxInputChars,
    timeoutMs: (rawDistillCfg?.timeoutMs as number | undefined) ?? 90_000,
    minOutputWords:
      (rawDistillCfg?.minOutputWords as number | undefined) ??
      DEFAULT_OVERFLOW_RECOVERY_CONFIG.minOutputWords,
    twoPass: (rawDistillCfg?.twoPass as boolean | undefined) ?? true,
  };

  // callLargeContextModel adapter — same pattern as run.ts
  const agentDir = params.agentDir ?? resolveOpenClawAgentDir();
  const callLargeContextModel = async (
    prompt: string,
    modelStr: string,
    timeoutMs: number,
  ): Promise<string> => {
    const slashIdx = modelStr.indexOf("/");
    const provider = slashIdx > -1 ? modelStr.slice(0, slashIdx) : "google";
    const modelId = slashIdx > -1 ? modelStr.slice(slashIdx + 1) : modelStr;
    const { model, error } = resolveModel(provider, modelId, agentDir, params.cfg);
    if (!model) {
      throw new Error(`Cannot resolve distil model ${modelStr}: ${error}`);
    }
    const keyInfo = await getApiKeyForModel({ model, cfg: params.cfg, agentDir });
    const result = await completeSimple(
      model,
      { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
      { apiKey: keyInfo.apiKey ?? undefined, signal: AbortSignal.timeout(timeoutMs) },
    );
    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (!text.trim()) {
      throw new Error("Empty response from distil model");
    }
    return text;
  };

  const diagId = `distill-${sessionId.slice(0, 8)}`;
  const t0 = Date.now();

  const result = await performOverflowRecovery(
    {
      config: distillCfg,
      diagId,
      sessionKey: params.sessionKey,
      messages,
      // No termination context — manual invocation, not a crash recovery
    },
    callLargeContextModel,
  );

  if (!result.success) {
    return {
      shouldContinue: false,
      reply: {
        text: `⚠️ Distillation failed: ${result.error?.message ?? "unknown error"}`,
      },
    };
  }

  // Write to ~/.openclaw/tmp/distillations/
  const tmpDir = path.join(resolvePreferredOpenClawTmpDir(), "distillations");
  await fs.mkdir(tmpDir, { recursive: true });
  const now2 = new Date();
  const date = now2.toISOString().slice(0, 10);
  const time = now2.toISOString().slice(11, 19).replace(/:/g, "-");
  const filename = `session-distillation-${date}T${time}-${sessionId.slice(0, 8)}.md`;
  const filePath = path.join(tmpDir, filename);
  await fs.writeFile(filePath, result.summaryBlock!, "utf-8");

  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
  const chars = result.summaryChars?.toLocaleString() ?? "?";
  const passLabel = distillCfg.twoPass ? "2-pass" : "1-pass";
  const modeLabel = mode === "compact" ? " · context reset" : "";
  const caption = `📄 **${filename}**\n${filePath}\n${chars} chars · ${passLabel} · ${elapsedSec}s${modeLabel}`;

  if (mode === "compact") {
    await rewriteSessionWithSummary({ sessionFilePath, sessionId, summary: result.summaryBlock! });
  }

  return {
    shouldContinue: false,
    reply: { text: caption, mediaUrl: filePath },
  };
};
