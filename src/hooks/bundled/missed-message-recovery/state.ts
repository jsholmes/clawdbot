import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type RecoveryState = { shutdownAt: number };

export const STATE_FILE = path.join(os.homedir(), ".openclaw/missed-message-recovery-state.json");

export function readShutdownState(): RecoveryState | null {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return null;
    }

    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as { shutdownAt?: unknown };

    if (typeof parsed.shutdownAt !== "number" || !Number.isFinite(parsed.shutdownAt)) {
      return null;
    }

    return { shutdownAt: parsed.shutdownAt };
  } catch {
    return null;
  }
}

export function writeShutdownState(ts: number): void {
  const tmpFile = `${STATE_FILE}.tmp`;

  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(tmpFile, JSON.stringify({ shutdownAt: ts }), "utf-8");
    fs.renameSync(tmpFile, STATE_FILE);
  } catch (err) {
    console.error("missed-message-recovery: failed to write shutdown state", err);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}
