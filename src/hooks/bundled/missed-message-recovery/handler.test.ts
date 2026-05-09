import { describe, expect, it } from "vitest";
import { resolveRecoveryScanStart } from "./handler.js";

describe("resolveRecoveryScanStart", () => {
  it("uses a recent stored shutdown timestamp", () => {
    expect(
      resolveRecoveryScanStart({
        forceOverride: undefined,
        storedShutdownAt: 10_000,
        nowMs: 20_000,
        maxLookbackMs: 15_000,
      }),
    ).toEqual({ shutdownAt: 10_000, reason: "stored" });
  });

  it("treats missing or zero state as now", () => {
    expect(
      resolveRecoveryScanStart({
        forceOverride: undefined,
        storedShutdownAt: 0,
        nowMs: 20_000,
        maxLookbackMs: 15_000,
      }),
    ).toEqual({ shutdownAt: 20_000, reason: "missing-state" });
  });

  it("caps stale stored shutdown timestamps to now to prevent replay floods", () => {
    expect(
      resolveRecoveryScanStart({
        forceOverride: undefined,
        storedShutdownAt: 1_000,
        nowMs: 20_000,
        maxLookbackMs: 15_000,
      }),
    ).toEqual({ shutdownAt: 20_000, reason: "stale-state" });
  });

  it("caps future stored shutdown timestamps to now", () => {
    expect(
      resolveRecoveryScanStart({
        forceOverride: undefined,
        storedShutdownAt: 30_000,
        nowMs: 20_000,
        maxLookbackMs: 15_000,
      }),
    ).toEqual({ shutdownAt: 20_000, reason: "future-state" });
  });

  it("preserves explicit force override for tests and manual recovery", () => {
    expect(
      resolveRecoveryScanStart({
        forceOverride: "0",
        storedShutdownAt: 1_000,
        nowMs: 20_000,
        maxLookbackMs: 15_000,
      }),
    ).toEqual({ shutdownAt: 0, reason: "force-override" });
  });
});
