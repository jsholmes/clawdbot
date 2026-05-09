import type { DiscordMessage } from "./scanner.js";

export type MissedMessage = {
  id: string;
  content: string;
  authorId: string;
  timestampMs: number;
};

// Discord's REST history includes system rows such as ThreadCreated (18) whose
// `content` is often just the thread title. Replaying those as user prompts
// routes parent-channel noise into agents during gateway restart recovery.
// Keep recovery intentionally narrow: ordinary messages plus Discord replies.
const REPLAYABLE_DISCORD_MESSAGE_TYPES = new Set([0, 19]);

function isReplayableDiscordMessageType(type: number | undefined): boolean {
  return type === undefined || REPLAYABLE_DISCORD_MESSAGE_TYPES.has(type);
}

export function detectMissedMessages(params: {
  messages: DiscordMessage[];
  shutdownAt: number;
  botId: string;
  authorizedSenders: string[];
}): MissedMessage[] {
  const { messages, shutdownAt, botId, authorizedSenders } = params;
  const authorizedSenderSet = new Set(authorizedSenders);
  const missedMessages: MissedMessage[] = [];

  let hasBotReplyAfter = false;

  for (const message of messages) {
    if (message.author.id === botId || (!botId && message.author.bot === true)) {
      hasBotReplyAfter = true;
      continue;
    }

    const isAfterShutdown = shutdownAt === 0 || message.timestampMs > shutdownAt;
    if (!isAfterShutdown) {
      continue;
    }

    // Only filter by sender when an allowlist is configured.
    // Empty list = open policy = allow all non-bot senders.
    if (authorizedSenders.length > 0 && !authorizedSenderSet.has(message.author.id)) {
      continue;
    }

    if (message.author.bot === true) {
      continue;
    }

    if (!isReplayableDiscordMessageType(message.type)) {
      continue;
    }

    if (hasBotReplyAfter) {
      continue;
    }

    const replayContent = buildReplayContent(message);
    if (!replayContent) {
      continue;
    }

    missedMessages.push({
      id: message.id,
      content: replayContent,
      authorId: message.author.id,
      timestampMs: message.timestampMs,
    });
  }

  return missedMessages.toReversed();
}

function buildReplayContent(message: DiscordMessage): string {
  const trimmedContent = message.content.trim();
  if (trimmedContent.length > 0) {
    return trimmedContent;
  }

  const attachmentLines = (message.attachments ?? [])
    .filter((attachment) => typeof attachment.url === "string" && attachment.url.trim().length > 0)
    .map((attachment) => {
      const label = attachment.filename?.trim() || attachment.id || "attachment";
      return `- ${label}: ${attachment.url.trim()}`;
    });

  if (attachmentLines.length === 0) {
    return "";
  }

  return [
    "[Recovered attachment-only Discord message sent during gateway restart]",
    "Attachments:",
    ...attachmentLines,
  ].join("\n");
}
