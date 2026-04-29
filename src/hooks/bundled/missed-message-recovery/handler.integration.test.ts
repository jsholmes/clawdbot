import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { GatewayStartupHookEvent } from "../../../hooks/internal-hooks.js";

type DiscordApiMessage = {
  id: string;
  content: string;
  timestamp: string;
  author: {
    id: string;
    bot?: boolean;
  };
};

const DEFAULT_CHANNEL_ID = "1476635773175468113";
const DEFAULT_BOT_ID = "1468311381353959556";
const REQUIRED_ENV_PRESENT =
  Boolean(process.env.DISCORD_BOT_TOKEN) && Boolean(process.env.OPENCLAW_GATEWAY_TOKEN);

const describeLive = REQUIRED_ENV_PRESENT ? describe : describe.skip;

describeLive("missed-message-recovery gateway_start integration", () => {
  let handleGatewayStart: (event: GatewayStartupHookEvent) => Promise<void>;

  let tempHomeDir = "";
  let stateFile = "";
  let sourceMessageId = "";
  let sourceMessageTimestampMs = 0;
  let sourceAuthorId = "";

  const botToken = process.env.DISCORD_BOT_TOKEN ?? "";
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
  const channelId = process.env.OPENCLAW_MISSED_MESSAGE_CHANNEL_ID ?? DEFAULT_CHANNEL_ID;
  const botId = process.env.DISCORD_BOT_USER_ID ?? DEFAULT_BOT_ID;
  const port = Number.parseInt(process.env.OPENCLAW_GATEWAY_PORT ?? "3000", 10) || 3000;

  const originalEnv = {
    HOME: process.env.HOME,
    OPENCLAW_AUTHORIZED_SENDERS: process.env.OPENCLAW_AUTHORIZED_SENDERS,
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN,
    OPENCLAW_GATEWAY_PORT: process.env.OPENCLAW_GATEWAY_PORT,
  };

  beforeAll(async () => {
    tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-missed-recovery-integ-"));
    process.env.HOME = tempHomeDir;
    process.env.DISCORD_BOT_TOKEN = botToken;
    process.env.OPENCLAW_GATEWAY_TOKEN = gatewayToken;
    process.env.OPENCLAW_GATEWAY_PORT = String(port);

    const sessionKey =
      process.env.OPENCLAW_MISSED_MESSAGE_SESSION_KEY ?? `agent:main:discord:channel:${channelId}`;
    const sessionsFile = path.join(
      tempHomeDir,
      ".openclaw",
      "agents",
      "integration-test-agent",
      "sessions",
      "sessions.json",
    );
    await fs.mkdir(path.dirname(sessionsFile), { recursive: true });
    await fs.writeFile(
      sessionsFile,
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId: "integration-session",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const channelMessages = await fetchChannelMessages(channelId, botToken, 100);

    const requestedSourceMessageId = process.env.OPENCLAW_MISSED_MESSAGE_SOURCE_MESSAGE_ID;
    const sourceMessage = requestedSourceMessageId
      ? channelMessages.find((message) => message.id === requestedSourceMessageId)
      : findRecoverableMessage(channelMessages, botId);

    expect(sourceMessage).toBeDefined();

    sourceMessageId = sourceMessage!.id;
    sourceMessageTimestampMs = Date.parse(sourceMessage!.timestamp);
    sourceAuthorId = sourceMessage!.author.id;

    process.env.OPENCLAW_AUTHORIZED_SENDERS = sourceAuthorId;

    const shutdownAt = Math.min(Date.now() - 600_000, sourceMessageTimestampMs - 1);
    stateFile = path.join(tempHomeDir, ".openclaw", "missed-message-recovery-state.json");
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify({ shutdownAt }), "utf8");

    vi.resetModules();
    const mod = await import("./handler.js");
    handleGatewayStart = mod.default;
  }, 30_000);

  afterAll(async () => {
    if (originalEnv.HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalEnv.HOME;
    }

    if (originalEnv.OPENCLAW_AUTHORIZED_SENDERS === undefined) {
      delete process.env.OPENCLAW_AUTHORIZED_SENDERS;
    } else {
      process.env.OPENCLAW_AUTHORIZED_SENDERS = originalEnv.OPENCLAW_AUTHORIZED_SENDERS;
    }

    if (originalEnv.DISCORD_BOT_TOKEN === undefined) {
      delete process.env.DISCORD_BOT_TOKEN;
    } else {
      process.env.DISCORD_BOT_TOKEN = originalEnv.DISCORD_BOT_TOKEN;
    }

    if (originalEnv.OPENCLAW_GATEWAY_TOKEN === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = originalEnv.OPENCLAW_GATEWAY_TOKEN;
    }

    if (originalEnv.OPENCLAW_GATEWAY_PORT === undefined) {
      delete process.env.OPENCLAW_GATEWAY_PORT;
    } else {
      process.env.OPENCLAW_GATEWAY_PORT = originalEnv.OPENCLAW_GATEWAY_PORT;
    }

    if (tempHomeDir) {
      await fs.rm(tempHomeDir, { recursive: true, force: true });
    }
  });

  it("replays a missed message by posting a recovery note before bot reply", async () => {
    await handleGatewayStart({
      type: "gateway",
      action: "startup",
      context: {},
    } as GatewayStartupHookEvent);

    const { noteMessage, botReplyMessage } = await waitForRecovery({
      channelId,
      botToken,
      sourceMessageId,
      botId,
      timeoutMs: 60_000,
    });

    expect(Date.parse(noteMessage.timestamp)).toBeLessThanOrEqual(
      Date.parse(botReplyMessage.timestamp),
    );

    const stateRaw = await fs.readFile(stateFile, "utf8");
    const state = JSON.parse(stateRaw) as { shutdownAt?: unknown };
    expect(state.shutdownAt).toBe(0);
  }, 90_000);

  it("is idempotent when gateway_start runs a second time immediately", async () => {
    const beforeSecondRun = await fetchChannelMessages(channelId, botToken, 100);
    const beforeSecondRunNewer = newerThanSourceMessage(beforeSecondRun, sourceMessageId);

    await handleGatewayStart({
      type: "gateway",
      action: "startup",
      context: {},
    } as GatewayStartupHookEvent);
    await sleep(15_000);

    const afterSecondRun = await fetchChannelMessages(channelId, botToken, 100);
    const afterSecondRunNewer = newerThanSourceMessage(afterSecondRun, sourceMessageId);

    expect(afterSecondRunNewer.length).toBe(beforeSecondRunNewer.length);
  }, 30_000);

  async function waitForRecovery(params: {
    channelId: string;
    botToken: string;
    sourceMessageId: string;
    botId: string;
    timeoutMs: number;
  }): Promise<{ noteMessage: DiscordApiMessage; botReplyMessage: DiscordApiMessage }> {
    const { channelId, botToken, sourceMessageId, botId, timeoutMs } = params;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const messages = await fetchChannelMessages(channelId, botToken, 100);
      const newerMessages = newerThanSourceMessage(messages, sourceMessageId);

      const noteMessage = newerMessages.find((message) => message.content.includes("*(recovered"));
      const botReplyMessage = newerMessages.find(
        (message) => message.author.id === botId && !message.content.includes("*(recovered"),
      );

      if (noteMessage && botReplyMessage) {
        return { noteMessage, botReplyMessage };
      }

      await sleep(2_000);
    }

    throw new Error("Timed out waiting for recovery note + bot reply after running gateway_start");
  }

  function findRecoverableMessage(
    messages: DiscordApiMessage[],
    botId: string,
  ): DiscordApiMessage | undefined {
    let hasNewerBotReply = false;

    for (const message of messages) {
      if (message.author.id === botId) {
        hasNewerBotReply = true;
        continue;
      }

      if (hasNewerBotReply) {
        continue;
      }

      if (message.author.bot === true) {
        continue;
      }

      if (message.content.trim().length === 0) {
        continue;
      }

      const timestampMs = Date.parse(message.timestamp);
      if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
        continue;
      }

      return message;
    }

    return undefined;
  }

  function newerThanSourceMessage(
    messages: DiscordApiMessage[],
    sourceId: string,
  ): DiscordApiMessage[] {
    const sourceIndex = messages.findIndex((message) => message.id === sourceId);
    if (sourceIndex === -1) {
      throw new Error(`Source message ${sourceId} was not found in latest channel messages`);
    }

    return messages.slice(0, sourceIndex);
  }

  async function fetchChannelMessages(
    channelId: string,
    botToken: string,
    limit = 25,
  ): Promise<DiscordApiMessage[]> {
    const response = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages?limit=${limit}`,
      {
        headers: {
          Authorization: `Bot ${botToken}`,
        },
      },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Failed to fetch channel messages (status=${response.status}, channelId=${channelId}, body=${body})`,
      );
    }

    return (await response.json()) as DiscordApiMessage[];
  }

  async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
});
