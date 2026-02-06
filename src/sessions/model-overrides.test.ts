import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { applyModelOverrideToSessionEntry } from "./model-overrides.js";

describe("applyModelOverrideToSessionEntry", () => {
  it("clears stale contextTokens when modelOverride changes", () => {
    const entry: SessionEntry = {
      sessionId: "test",
      updatedAt: 0,
      model: "gpt-5.2",
      modelProvider: "openai",
      contextTokens: 400_000,
    };
    applyModelOverrideToSessionEntry({
      entry,
      selection: { provider: "anthropic", model: "claude-opus-4-6" },
    });
    expect(entry.modelOverride).toBe("claude-opus-4-6");
    expect(entry.contextTokens).toBeUndefined();
  });

  it("clears stale contextTokens when resetting to default model", () => {
    const entry: SessionEntry = {
      sessionId: "test",
      updatedAt: 0,
      model: "gpt-5.2",
      modelProvider: "openai",
      modelOverride: "claude-opus-4-6",
      providerOverride: "anthropic",
      contextTokens: 400_000,
    };
    applyModelOverrideToSessionEntry({
      entry,
      selection: { provider: "anthropic", model: "claude-opus-4-6", isDefault: true },
    });
    expect(entry.modelOverride).toBeUndefined();
    expect(entry.contextTokens).toBeUndefined();
  });

  it("preserves contextTokens when modelOverride does not change", () => {
    const entry: SessionEntry = {
      sessionId: "test",
      updatedAt: 0,
      model: "claude-opus-4-6",
      modelProvider: "anthropic",
      modelOverride: "claude-opus-4-6",
      providerOverride: "anthropic",
      contextTokens: 200_000,
    };
    applyModelOverrideToSessionEntry({
      entry,
      selection: { provider: "anthropic", model: "claude-opus-4-6" },
    });
    expect(entry.contextTokens).toBe(200_000);
  });
});
