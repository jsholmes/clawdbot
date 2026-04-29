import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveGatewayAuth } from "../../../gateway/auth.js";
import type { GatewayStartupHookEvent } from "../../../hooks/internal-hooks.js";
import { detectMissedMessages } from "./detector.js";
import { postRecoveryNote, replayMessage } from "./replay.js";
import { RateLimitError, fetchDiscordMessages } from "./scanner.js";
import { loadAllDiscordSessions } from "./sessions.js";
import { readShutdownState, writeShutdownState } from "./state.js";

const LOG_PREFIX = "[missed-message-recovery]";

let shutdownHandlerRegistered = false;

function normalizeDiscordBotToken(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  const trimmed = raw.trim().replace(/^Bot\s+/i, "");
  return trimmed;
}

function resolveDefaultDiscordBotToken(cfg: OpenClawConfig): string {
  const discordCfg = cfg.channels?.discord;
  const defaultAccount =
    discordCfg?.accounts && typeof discordCfg.accounts === "object"
      ? ((discordCfg.accounts as Record<string, { token?: unknown }>).default ?? undefined)
      : undefined;
  const hasDefaultAccountToken = Boolean(
    defaultAccount && Object.prototype.hasOwnProperty.call(defaultAccount, "token"),
  );
  const defaultAccountToken = normalizeDiscordBotToken(defaultAccount?.token);
  if (defaultAccountToken) {
    return defaultAccountToken;
  }
  if (hasDefaultAccountToken) {
    return "";
  }

  const configToken = normalizeDiscordBotToken(discordCfg?.token);
  if (configToken) {
    return configToken;
  }

  return normalizeDiscordBotToken(process.env.DISCORD_BOT_TOKEN);
}

/**
 * Internal hook handler for gateway:startup.
 *
 * 1. Registers a one-time shutdown handler (SIGTERM/SIGUSR1) to record
 *    shutdownAt timestamp on graceful stop.
 * 2. Scans Discord sessions for messages sent after the last shutdown
 *    that have no bot reply, and replays them through the gateway.
 */
const handleGatewayStartup = async (event: GatewayStartupHookEvent): Promise<void> => {
  // Register shutdown handler once — writes shutdownAt on graceful stop
  if (!shutdownHandlerRegistered) {
    const onShutdown = () => {
      writeShutdownState(Date.now());
    };
    process.on("SIGTERM", onShutdown);
    process.on("SIGINT", onShutdown);
    process.on("SIGUSR1", onShutdown);
    shutdownHandlerRegistered = true;
  }

  const cfg = event.context?.cfg;
  if (!cfg) {
    console.warn(
      `${LOG_PREFIX} missing runtime config on gateway startup event; skipping recovery`,
    );
    return;
  }

  const botToken = resolveDefaultDiscordBotToken(cfg);
  if (!botToken) {
    console.warn(`${LOG_PREFIX} missing Discord bot token; skipping recovery`);
    return;
  }

  const gatewayToken = resolveGatewayAuth({
    authConfig: cfg.gateway?.auth,
    env: process.env,
  }).token;
  if (!gatewayToken) {
    console.warn(`${LOG_PREFIX} missing gateway auth token; skipping recovery`);
    return;
  }

  // The gateway port isn't directly in GatewayStartupHookContext,
  // so read it from the environment (set by the gateway at startup).
  const port = Number(process.env.OPENCLAW_GATEWAY_PORT) || 18789;

  const discordCfg = cfg.channels?.discord;
  const rawAllowFrom: unknown[] = [
    ...(Array.isArray(discordCfg?.dm?.allowFrom) ? discordCfg.dm.allowFrom : []),
    ...(Array.isArray((discordCfg as { allowFrom?: unknown })?.allowFrom)
      ? ((discordCfg as { allowFrom?: string[] }).allowFrom ?? [])
      : []),
  ];
  // Keep only entries that look like Discord snowflake IDs (numeric strings)
  const SNOWFLAKE_RE = /^\d{10,20}$/;
  const authorizedSenders = rawAllowFrom
    .filter((v): v is string => typeof v === "string" && SNOWFLAKE_RE.test(v.trim()))
    .map((v) => v.trim());

  if (authorizedSenders.length === 0) {
    console.info(
      `${LOG_PREFIX} no allowFrom configured — recovery will replay messages from any non-bot sender`,
    );
  }

  let botId = "";
  try {
    const meResp = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bot ${botToken}` },
    });
    if (meResp.ok) {
      const me = (await meResp.json()) as { id?: string };
      botId = typeof me.id === "string" ? me.id : "";
    } else {
      console.warn(
        `${LOG_PREFIX} could not fetch bot user ID (status=${meResp.status}); bot messages may not be filtered correctly`,
      );
    }
  } catch (err) {
    console.warn(
      `${LOG_PREFIX} could not fetch bot user ID: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Allow override for testing: MISSED_RECOVERY_FORCE_SCAN_SINCE=0 scans all history
  const forceOverride = process.env.MISSED_RECOVERY_FORCE_SCAN_SINCE;
  const storedState = readShutdownState();
  // If no state file exists or shutdownAt is 0 (e.g. written by a buggy path or missing due to
  // SIGKILL/OOM), default to "now" so we don't flood every session with old messages.
  // A shutdownAt of 0 means "no known shutdown time" — treat it as a fresh start.
  const shutdownAt =
    forceOverride !== undefined
      ? Number(forceOverride)
      : storedState !== null && storedState.shutdownAt > 0
        ? storedState.shutdownAt
        : Date.now();
  const sessions = loadAllDiscordSessions();

  console.info(`${LOG_PREFIX} recovery scan: shutdownAt=${shutdownAt}`);

  // Track whether all sessions were scanned without errors.
  // Only reset shutdownAt on full success — if any channel was skipped,
  // preserve the existing shutdownAt so the next startup can retry.
  let allSucceeded = true;

  for (const session of sessions) {
    let messages;
    try {
      messages = await fetchDiscordMessages(session.channelId, botToken);
    } catch (err) {
      allSucceeded = false;
      if (err instanceof RateLimitError) {
        console.warn(`${LOG_PREFIX} skipping channel ${session.channelId}: rate limited`);
      } else {
        const details = err instanceof Error ? err.message : String(err);
        console.warn(`${LOG_PREFIX} skipping channel ${session.channelId}: ${details}`);
      }
      continue;
    }

    const missedMessages = detectMissedMessages({
      messages,
      shutdownAt,
      botId,
      authorizedSenders,
    });

    for (const missedMessage of missedMessages) {
      try {
        // Replay first — only post the recovery note after the gateway has
        // accepted the message. This prevents orphaned "*(recovered...)*"
        // notes when the replay request itself fails.
        await replayMessage({
          port,
          gatewayToken,
          sessionKey: session.key,
          message: missedMessage.content,
          channelId: session.channelId,
          messageId: missedMessage.id,
        });
        await postRecoveryNote(session.channelId, botToken);
      } catch (err) {
        allSucceeded = false;
        const details = err instanceof Error ? err.message : String(err);
        console.warn(`${LOG_PREFIX} skipping channel ${session.channelId}: ${details}`);
        break;
      }
    }
  }

  if (allSucceeded) {
    // Write current time as the new baseline so the next restart only looks for messages
    // sent after this recovery scan completed — not "scan everything" (0).
    writeShutdownState(Date.now());
  } else {
    console.warn(
      `${LOG_PREFIX} some channels had errors; preserving shutdownAt for retry on next restart`,
    );
  }
};

export default handleGatewayStartup;
