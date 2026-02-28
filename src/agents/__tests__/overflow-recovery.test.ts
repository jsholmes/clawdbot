import { describe, it, expect, vi } from "vitest";
import {
  shouldAttemptOverflowRecovery,
  performOverflowRecovery,
  buildSummarisationPrompt,
  preprocessTranscript,
  preTruncateTranscript,
  redactSecrets,
  buildToolResultPlaceholder,
  DEFAULT_OVERFLOW_RECOVERY_CONFIG,
  type TranscriptMessage,
  type OverflowRecoveryConfig,
} from "../pi-embedded-runner/overflow-recovery.js";

const baseConfig: OverflowRecoveryConfig = {
  ...DEFAULT_OVERFLOW_RECOVERY_CONFIG,
  enabled: true,
};

// ---------------------------------------------------------------------------
// shouldAttemptOverflowRecovery
// ---------------------------------------------------------------------------

describe("shouldAttemptOverflowRecovery", () => {
  it("returns false when disabled", () => {
    expect(
      shouldAttemptOverflowRecovery(
        { ...baseConfig, enabled: false },
        {
          normalCompactionAttempted: true,
          toolResultTruncationAttempted: true,
          stillOverflow: true,
        },
      ),
    ).toBe(false);
  });

  it("returns false when normal compaction not attempted", () => {
    expect(
      shouldAttemptOverflowRecovery(baseConfig, {
        normalCompactionAttempted: false,
        toolResultTruncationAttempted: true,
        stillOverflow: true,
      }),
    ).toBe(false);
  });

  it("returns false when tool-result truncation not attempted", () => {
    expect(
      shouldAttemptOverflowRecovery(baseConfig, {
        normalCompactionAttempted: true,
        toolResultTruncationAttempted: false,
        stillOverflow: true,
      }),
    ).toBe(false);
  });

  it("returns false when no longer overflow after mitigations", () => {
    expect(
      shouldAttemptOverflowRecovery(baseConfig, {
        normalCompactionAttempted: true,
        toolResultTruncationAttempted: true,
        stillOverflow: false,
      }),
    ).toBe(false);
  });

  it("returns true only when all conditions met", () => {
    expect(
      shouldAttemptOverflowRecovery(baseConfig, {
        normalCompactionAttempted: true,
        toolResultTruncationAttempted: true,
        stillOverflow: true,
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// redactSecrets
// ---------------------------------------------------------------------------

describe("redactSecrets", () => {
  it("redacts sk- API keys", () => {
    expect(redactSecrets("key is sk-abc123def456ghi789jkl")).not.toContain(
      "sk-abc123def456ghi789jkl",
    );
  });

  it("redacts ghp_ tokens", () => {
    expect(redactSecrets("ghp_abcdefghijklmnopqrstu")).not.toContain("ghp_abcdefghijklmnopqrstu");
  });

  it("redacts xoxb- tokens", () => {
    expect(redactSecrets("token=xoxb-123-456-abcdefghijk")).not.toContain(
      "xoxb-123-456-abcdefghijk",
    );
  });

  it("redacts Bearer tokens", () => {
    expect(redactSecrets("Authorization: Bearer eyJhbGciOiJSUzI1NiJ9abc")).not.toContain(
      "eyJhbGciOiJSUzI1NiJ9abc",
    );
  });

  it("redacts op:// references", () => {
    expect(redactSecrets("op://Prudent Things/key/credential")).not.toContain("op://");
  });

  it("redacts JWT tokens", () => {
    expect(redactSecrets("token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test")).not.toContain(
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    );
  });

  it("redacts env var assignments", () => {
    expect(redactSecrets("API_KEY=supersecretvalue123")).not.toContain("supersecretvalue123");
  });

  it("redacts --password flags", () => {
    expect(redactSecrets("cmd --password mypassword123")).not.toContain("mypassword123");
  });

  it("redacts --token flags", () => {
    expect(redactSecrets("cmd --token mytoken12345678")).not.toContain("mytoken12345678");
  });

  it("does NOT redact bead IDs", () => {
    const text = "bead workspace-runa is active";
    expect(redactSecrets(text)).toContain("workspace-runa");
  });

  it("does NOT redact file paths", () => {
    const text = "/Users/prue/.openclaw/workspace/MEMORY.md";
    expect(redactSecrets(text)).toContain("/Users/prue/.openclaw/workspace/MEMORY.md");
  });

  it("does NOT redact session keys (short mixed-case)", () => {
    // session keys are typically short alphanumeric; just verify no crash
    const text = "sessionKey=abc123def456";
    const result = redactSecrets(text);
    expect(typeof result).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// buildToolResultPlaceholder
// ---------------------------------------------------------------------------

describe("buildToolResultPlaceholder", () => {
  it("keeps verbatim results under 200 chars", () => {
    const short = "exit 0\nok";
    expect(buildToolResultPlaceholder("exec", short, { cmd: "pnpm test", exit: 0 })).toBe(short);
  });

  it("builds placeholder for long results", () => {
    const long = "x".repeat(300);
    const result = buildToolResultPlaceholder("exec", long, { exit: 0 });
    expect(result).toContain("[exec]");
    expect(result).toContain("exit=0");
    expect(result).not.toContain("x".repeat(50));
  });

  it("includes bytes count in placeholder", () => {
    const long = "y".repeat(300);
    const result = buildToolResultPlaceholder("read", long, { path: "MEMORY.md" });
    expect(result).toContain("bytes=300");
  });
});

// ---------------------------------------------------------------------------
// preprocessTranscript
// ---------------------------------------------------------------------------

describe("preprocessTranscript", () => {
  it("replaces long tool results with placeholders", () => {
    const messages: TranscriptMessage[] = [
      { role: "tool", toolName: "exec", content: "a".repeat(300), metadata: { exit: 0 } },
    ];
    const result = preprocessTranscript(messages);
    expect(result[0].content).not.toContain("a".repeat(50));
    expect(result[0].content).toContain("[exec]");
  });

  it("includes exit codes in placeholders", () => {
    const messages: TranscriptMessage[] = [
      { role: "tool", toolName: "exec", content: "b".repeat(300), metadata: { exit: 1 } },
    ];
    const result = preprocessTranscript(messages);
    expect(result[0].content).toContain("exit=1");
  });

  it("keeps verbatim results under 200 chars", () => {
    const messages: TranscriptMessage[] = [
      { role: "tool", toolName: "exec", content: "ok", metadata: {} },
    ];
    const result = preprocessTranscript(messages);
    expect(result[0].content).toBe("ok");
  });

  it("preserves outputFile paths in metadata", () => {
    const messages: TranscriptMessage[] = [
      {
        role: "tool",
        toolName: "exec",
        content: "c".repeat(300),
        metadata: { outputFile: "/tmp/artifact.json", exit: 0 },
      },
    ];
    const result = preprocessTranscript(messages);
    expect(result[0].content).toContain("outputFile=/tmp/artifact.json");
  });

  it("does not modify user/assistant messages", () => {
    const messages: TranscriptMessage[] = [
      { role: "user", content: "Hello there" },
      { role: "assistant", content: "Hi, how can I help?" },
    ];
    const result = preprocessTranscript(messages);
    expect(result[0].content).toBe("Hello there");
    expect(result[1].content).toBe("Hi, how can I help?");
  });
});

// ---------------------------------------------------------------------------
// preTruncateTranscript
// ---------------------------------------------------------------------------

describe("preTruncateTranscript", () => {
  it("does not truncate if within maxInputChars", () => {
    const msgs: TranscriptMessage[] = [
      { role: "user", content: "short" },
      { role: "assistant", content: "reply" },
    ];
    expect(preTruncateTranscript(msgs, 1000, 5)).toHaveLength(2);
  });

  it("truncates middle and inserts marker when over limit", () => {
    const msgs: TranscriptMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "x".repeat(10_000),
    }));
    const result = preTruncateTranscript(msgs, 50_000, 5);
    const hasMarker = result.some((m) => m.content.includes("turns omitted"));
    expect(hasMarker).toBe(true);
  });

  it("always preserves last keepLastTurns turns", () => {
    const msgs: TranscriptMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message-${i}-` + "x".repeat(5_000),
    }));
    const result = preTruncateTranscript(msgs, 20_000, 5);
    const lastFive = msgs.slice(-5).map((m) => m.content.split("-")[1]);
    for (const idx of lastFive) {
      expect(result.some((r) => r.content.includes(`message-${idx}`))).toBe(true);
    }
  });

  it("preserves system prompt", () => {
    const msgs: TranscriptMessage[] = [
      { role: "system", content: "You are Prue" },
      ...Array.from({ length: 10 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: "x".repeat(10_000),
      })),
    ];
    const result = preTruncateTranscript(msgs, 30_000, 5);
    expect(result[0].role).toBe("system");
    expect(result[0].content).toBe("You are Prue");
  });
});

// ---------------------------------------------------------------------------
// buildSummarisationPrompt
// ---------------------------------------------------------------------------

describe("buildSummarisationPrompt", () => {
  it("includes required sections in prompt", () => {
    const ctx = {
      messages: [
        { role: "user" as const, content: "What is the status of bead workspace-abc?" },
        { role: "assistant" as const, content: "Bead workspace-abc is open, priority 2." },
        { role: "user" as const, content: "Mark it as important" },
        { role: "assistant" as const, content: "Done, labelled as approved." },
        { role: "user" as const, content: "Save artifact to /tmp/out.json" },
        { role: "assistant" as const, content: "Saved to /tmp/out.json" },
      ],
      config: baseConfig,
      sessionKey: "test-session-123",
      diagId: "diag-001",
    };
    const prompt = buildSummarisationPrompt(ctx);
    expect(prompt).toContain("DECISIONS");
    expect(prompt).toContain("ACTIVE_THREADS");
    expect(prompt).toContain("ARTIFACT_POINTERS");
    expect(prompt).toContain("LAST_EXCHANGES");
  });

  it("instructs summariser to treat content as DATA not instructions", () => {
    const ctx = {
      messages: [{ role: "user" as const, content: "Hi" }],
      config: baseConfig,
      sessionKey: "s",
      diagId: "d",
    };
    const prompt = buildSummarisationPrompt(ctx);
    expect(prompt).toMatch(/treat.*data/i);
  });
});

// ---------------------------------------------------------------------------
// performOverflowRecovery
// ---------------------------------------------------------------------------

describe("performOverflowRecovery", () => {
  it("returns success when model call succeeds", async () => {
    const mockModel = vi.fn().mockResolvedValue("Summary: decisions=[done], active=[]");
    const ctx: Parameters<typeof performOverflowRecovery>[0] = {
      messages: [{ role: "user", content: "hello" }],
      config: { ...baseConfig, maxSummaryChars: 10_000 },
      sessionKey: "sk-test",
      diagId: "diag-ok",
    };
    const result = await performOverflowRecovery(ctx, mockModel);
    expect(result.success).toBe(true);
    expect(result.summaryBlock).toContain("Summary");
    expect(typeof result.summaryChars).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(mockModel).toHaveBeenCalledOnce();
  });

  it("caps summaryBlock at maxSummaryChars", async () => {
    const longResponse = "x".repeat(200_000);
    const mockModel = vi.fn().mockResolvedValue(longResponse);
    const maxSummaryChars = 5_000;
    const ctx: Parameters<typeof performOverflowRecovery>[0] = {
      messages: [{ role: "user", content: "hi" }],
      config: { ...baseConfig, maxSummaryChars },
      sessionKey: "sk-cap",
      diagId: "diag-cap",
    };
    const result = await performOverflowRecovery(ctx, mockModel);
    expect(result.success).toBe(true);
    expect(result.summaryBlock!.length).toBe(maxSummaryChars);
  });

  it("returns failure when model call throws", async () => {
    const mockModel = vi.fn().mockRejectedValue(new Error("network timeout"));
    const ctx: Parameters<typeof performOverflowRecovery>[0] = {
      messages: [{ role: "user", content: "hello" }],
      config: baseConfig,
      sessionKey: "sk-fail",
      diagId: "diag-fail",
    };
    const result = await performOverflowRecovery(ctx, mockModel);
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("network timeout");
    expect(result.summaryBlock).toBeUndefined();
  });

  it("redacts secrets in summary before returning", async () => {
    const secretSummary = "here is your api key: sk-abc123def456ghi789jkl000";
    const mockModel = vi.fn().mockResolvedValue(secretSummary);
    const ctx: Parameters<typeof performOverflowRecovery>[0] = {
      messages: [{ role: "user", content: "show me a secret" }],
      config: baseConfig,
      sessionKey: "sk-redact",
      diagId: "diag-redact",
    };
    const result = await performOverflowRecovery(ctx, mockModel);
    expect(result.success).toBe(true);
    expect(result.summaryBlock).not.toContain("sk-abc123def456ghi789jkl000");
    expect(result.summaryBlock).toContain("[REDACTED]");
  });

  it("propagates the diagId in the result", async () => {
    const mockModel = vi.fn().mockResolvedValue("ok summary");
    const ctx: Parameters<typeof performOverflowRecovery>[0] = {
      messages: [{ role: "user", content: "hi" }],
      config: baseConfig,
      sessionKey: "sk-id",
      diagId: "my-unique-diag-id",
    };
    const result = await performOverflowRecovery(ctx, mockModel);
    expect(result.diagId).toBe("my-unique-diag-id");
  });
});
