import { describe, expect, it } from "vitest";
import { detectMissedMessages } from "./detector.js";
import type { DiscordMessage } from "./scanner.js";

function makeMessage(params: {
  id: string;
  authorId: string;
  timestampMs: number;
  content?: string;
  authorBot?: boolean;
  type?: number;
  attachments?: Array<{
    id: string;
    url: string;
    filename?: string;
    content_type?: string;
  }>;
}): DiscordMessage {
  return {
    id: params.id,
    content: params.content ?? params.id,
    attachments: params.attachments,
    author: {
      id: params.authorId,
      ...(params.authorBot === undefined ? {} : { bot: params.authorBot }),
    },
    timestamp: new Date(params.timestampMs).toISOString(),
    timestampMs: params.timestampMs,
    ...(params.type === undefined ? {} : { type: params.type }),
  };
}

describe("detectMissedMessages", () => {
  const botId = "bot-1";
  const authorizedSenders = ["user-1", "user-2", "user-3"];

  it("returns a single user message after shutdownAt when no bot reply exists", () => {
    const messages = [
      makeMessage({ id: "m1", authorId: "user-1", timestampMs: 200, content: "hello" }),
    ];

    const result = detectMissedMessages({
      messages,
      shutdownAt: 100,
      botId,
      authorizedSenders,
    });

    expect(result).toEqual([
      {
        id: "m1",
        content: "hello",
        authorId: "user-1",
        timestampMs: 200,
      },
    ]);
  });

  it("does not return a user message when a bot reply appears after it", () => {
    const messages = [
      makeMessage({ id: "bot-reply", authorId: botId, timestampMs: 300, authorBot: true }),
      makeMessage({ id: "user-msg", authorId: "user-1", timestampMs: 200 }),
    ];

    const result = detectMissedMessages({
      messages,
      shutdownAt: 100,
      botId,
      authorizedSenders,
    });

    expect(result).toEqual([]);
  });

  it("excludes user messages that have a bot reply after them but includes newer ones", () => {
    // newest-first order (as Discord returns):
    // newer-user-msg (t=400) → no bot reply after it
    // bot-reply (t=300) → answers older-user-msg
    // older-user-msg (t=200) → bot replied after it
    const messages = [
      makeMessage({ id: "newer-user", authorId: "user-1", timestampMs: 400 }),
      makeMessage({ id: "bot-reply", authorId: botId, timestampMs: 300, authorBot: true }),
      makeMessage({ id: "older-user", authorId: "user-1", timestampMs: 200 }),
    ];

    const result = detectMissedMessages({
      messages,
      shutdownAt: 100,
      botId,
      authorizedSenders,
    });

    expect(result).toEqual([
      { id: "newer-user", content: "newer-user", authorId: "user-1", timestampMs: 400 },
    ]);
  });

  it("does not return messages at or before shutdownAt", () => {
    const messages = [
      makeMessage({ id: "m1", authorId: "user-1", timestampMs: 100 }),
      makeMessage({ id: "m0", authorId: "user-1", timestampMs: 50 }),
    ];

    const result = detectMissedMessages({
      messages,
      shutdownAt: 100,
      botId,
      authorizedSenders,
    });

    expect(result).toEqual([]);
  });

  it("does not return messages where author.bot is true", () => {
    const messages = [
      makeMessage({ id: "m1", authorId: "user-1", authorBot: true, timestampMs: 200 }),
    ];

    const result = detectMissedMessages({
      messages,
      shutdownAt: 100,
      botId,
      authorizedSenders,
    });

    expect(result).toEqual([]);
  });

  it("does not replay Discord thread-created system messages from parent channels", () => {
    const messages = [
      makeMessage({
        id: "thread-created-stub",
        authorId: "user-1",
        timestampMs: 200,
        content: "Screen / Avatar",
        type: 18,
      }),
    ];

    const result = detectMissedMessages({
      messages,
      shutdownAt: 100,
      botId,
      authorizedSenders,
    });

    expect(result).toEqual([]);
  });

  it("still replays ordinary Discord replies missed during restart", () => {
    const messages = [
      makeMessage({
        id: "reply-msg",
        authorId: "user-1",
        timestampMs: 200,
        content: "can you look at this?",
        type: 19,
      }),
    ];

    const result = detectMissedMessages({
      messages,
      shutdownAt: 100,
      botId,
      authorizedSenders,
    });

    expect(result).toEqual([
      {
        id: "reply-msg",
        content: "can you look at this?",
        authorId: "user-1",
        timestampMs: 200,
      },
    ]);
  });

  it("does not return messages from unauthorized senders", () => {
    const messages = [makeMessage({ id: "m1", authorId: "outsider", timestampMs: 200 })];

    const result = detectMissedMessages({
      messages,
      shutdownAt: 100,
      botId,
      authorizedSenders,
    });

    expect(result).toEqual([]);
  });

  it("empty authorizedSenders + unanswered non-bot message after shutdownAt → returned", () => {
    const messages = [
      makeMessage({ id: "m1", authorId: "any-user", timestampMs: 200, content: "open dm" }),
    ];

    const result = detectMissedMessages({
      messages,
      shutdownAt: 100,
      botId,
      authorizedSenders: [],
    });

    expect(result).toEqual([
      {
        id: "m1",
        content: "open dm",
        authorId: "any-user",
        timestampMs: 200,
      },
    ]);
  });

  it("returns unanswered user messages when shutdownAt is 0", () => {
    const messages = [makeMessage({ id: "m1", authorId: "user-2", timestampMs: 10 })];

    const result = detectMissedMessages({
      messages,
      shutdownAt: 0,
      botId,
      authorizedSenders,
    });

    expect(result).toEqual([
      {
        id: "m1",
        content: "m1",
        authorId: "user-2",
        timestampMs: 10,
      },
    ]);
  });

  it("returns multiple missed messages in chronological order", () => {
    const messages = [
      makeMessage({ id: "m3", authorId: "user-3", timestampMs: 300 }),
      makeMessage({ id: "m2", authorId: "user-2", timestampMs: 200 }),
      makeMessage({ id: "m1", authorId: "user-1", timestampMs: 100 }),
    ];

    const result = detectMissedMessages({
      messages,
      shutdownAt: 50,
      botId,
      authorizedSenders,
    });

    expect(result).toEqual([
      {
        id: "m1",
        content: "m1",
        authorId: "user-1",
        timestampMs: 100,
      },
      {
        id: "m2",
        content: "m2",
        authorId: "user-2",
        timestampMs: 200,
      },
      {
        id: "m3",
        content: "m3",
        authorId: "user-3",
        timestampMs: 300,
      },
    ]);
  });

  it("returns [] for empty messages array", () => {
    const result = detectMissedMessages({
      messages: [],
      shutdownAt: 0,
      botId,
      authorizedSenders,
    });

    expect(result).toEqual([]);
  });

  it("skips truly empty messages with no text or attachments", () => {
    const messages = [
      makeMessage({ id: "blank", authorId: "user-1", timestampMs: 200, content: "   " }),
    ];

    const result = detectMissedMessages({
      messages,
      shutdownAt: 100,
      botId,
      authorizedSenders,
    });

    expect(result).toEqual([]);
  });

  it("recovers attachment-only messages by synthesizing replay text from attachment URLs", () => {
    const messages = [
      makeMessage({
        id: "attachment-only",
        authorId: "user-1",
        timestampMs: 200,
        content: "   ",
        attachments: [
          {
            id: "att-1",
            filename: "example.png",
            url: "https://cdn.discordapp.com/example.png",
            content_type: "image/png",
          },
        ],
      }),
    ];

    const result = detectMissedMessages({
      messages,
      shutdownAt: 100,
      botId,
      authorizedSenders,
    });

    expect(result).toEqual([
      {
        id: "attachment-only",
        content: [
          "[Recovered attachment-only Discord message sent during gateway restart]",
          "Attachments:",
          "- example.png: https://cdn.discordapp.com/example.png",
        ].join("\n"),
        authorId: "user-1",
        timestampMs: 200,
      },
    ]);
  });

  it("skips a blank attachment-only message and still recovers the next older text message", () => {
    const messages = [
      makeMessage({
        id: "blank",
        authorId: "user-1",
        timestampMs: 300,
        content: "   ",
      }),
      makeMessage({
        id: "older-text",
        authorId: "user-1",
        timestampMs: 200,
        content: "please handle this",
      }),
    ];

    const result = detectMissedMessages({
      messages,
      shutdownAt: 100,
      botId,
      authorizedSenders,
    });

    expect(result).toEqual([
      {
        id: "older-text",
        content: "please handle this",
        authorId: "user-1",
        timestampMs: 200,
      },
    ]);
  });

  it("treats later bot-authored messages as replies when botId lookup failed", () => {
    const messages = [
      makeMessage({ id: "prue-reply", authorId: botId, timestampMs: 300, authorBot: true }),
      makeMessage({ id: "stale-user-msg", authorId: "user-1", timestampMs: 200 }),
    ];

    const result = detectMissedMessages({
      messages,
      shutdownAt: 0,
      botId: "",
      authorizedSenders,
    });

    expect(result).toEqual([]);
  });
});
