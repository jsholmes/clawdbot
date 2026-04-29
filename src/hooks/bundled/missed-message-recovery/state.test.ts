import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-missed-message-recovery-"));
const originalHome = process.env.HOME;
process.env.HOME = testHomeDir;

const { STATE_FILE, readShutdownState, writeShutdownState } = await import("./state.js");

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  fs.rmSync(STATE_FILE, { force: true });
  fs.rmSync(`${STATE_FILE}.tmp`, { force: true });
});

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  fs.rmSync(testHomeDir, { recursive: true, force: true });
});

describe("missed-message-recovery state", () => {
  it("writeShutdownState(ts) then readShutdownState() returns shutdownAt", () => {
    const ts = Date.now();

    writeShutdownState(ts);
    const state = readShutdownState();

    expect(state).toEqual({ shutdownAt: ts });
  });

  it("readShutdownState() returns null when file is missing", () => {
    expect(() => readShutdownState()).not.toThrow();
    expect(readShutdownState()).toBeNull();
  });

  it("readShutdownState() returns null when file contains invalid JSON", () => {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, "{not-valid-json", "utf-8");

    expect(() => readShutdownState()).not.toThrow();
    expect(readShutdownState()).toBeNull();
  });

  it("writeShutdownState() writes to tmp file before rename", () => {
    const tmpFile = `${STATE_FILE}.tmp`;
    const events: string[] = [];
    let tmpExistedWhenRenameRan = false;

    const originalWriteFileSync = fs.writeFileSync;
    const originalRenameSync = fs.renameSync;

    vi.spyOn(fs, "writeFileSync").mockImplementation(((...args: unknown[]) => {
      if (String(args[0]) === tmpFile) {
        events.push("write-tmp");
      }
      return (originalWriteFileSync as (...inner: unknown[]) => unknown)(...args);
    }) as typeof fs.writeFileSync);

    vi.spyOn(fs, "renameSync").mockImplementation(((oldPath: unknown, newPath: unknown) => {
      if (String(oldPath) === tmpFile && String(newPath) === STATE_FILE) {
        events.push("rename");
        tmpExistedWhenRenameRan = fs.existsSync(tmpFile);
      }
      return (originalRenameSync as (from: unknown, to: unknown) => void)(oldPath, newPath);
    }) as typeof fs.renameSync);

    writeShutdownState(Date.now());

    expect(events).toEqual(["write-tmp", "rename"]);
    expect(tmpExistedWhenRenameRan).toBe(true);
  });
});
