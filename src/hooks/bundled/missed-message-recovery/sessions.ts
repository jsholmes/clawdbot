import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type DiscordSessionEntry = {
  key: string;
  channelId: string;
};

const DISCORD_CHANNEL_KEY_RE = /discord:channel:(\d+)$/;

export function loadAllDiscordSessions(
  agentsDir = path.join(os.homedir(), ".openclaw/agents"),
): DiscordSessionEntry[] {
  let agentDirs: fs.Dirent[] = [];

  try {
    agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const seenChannelIds = new Set<string>();
  const entries: DiscordSessionEntry[] = [];

  for (const agentDir of agentDirs) {
    if (!agentDir.isDirectory()) {
      continue;
    }

    const sessionsFile = path.join(agentsDir, agentDir.name, "sessions", "sessions.json");

    let raw = "";
    try {
      raw = fs.readFileSync(sessionsFile, "utf8");
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== "ENOENT") {
        console.warn(`[missed-message-recovery] unable to read ${sessionsFile}; skipping`);
      }
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn(`[missed-message-recovery] unable to parse ${sessionsFile}; skipping`);
      continue;
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }

    for (const key of Object.keys(parsed as Record<string, unknown>)) {
      const match = DISCORD_CHANNEL_KEY_RE.exec(key);
      if (!match) {
        continue;
      }

      const channelId = match[1];
      if (seenChannelIds.has(channelId)) {
        continue;
      }

      seenChannelIds.add(channelId);
      entries.push({ key, channelId });
    }
  }

  return entries;
}
