import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDiscordMessages, RateLimitError } from "./scanner.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fetchDiscordMessages", () => {
  it("returns parsed messages with timestampMs on 200", async () => {
    const inputMessages = [
      {
        id: "m2",
        content: "newest",
        attachments: [
          {
            id: "a1",
            filename: "newest.png",
            url: "https://cdn.discordapp.com/newest.png",
            content_type: "image/png",
          },
        ],
        author: { id: "u1" },
        timestamp: "2026-03-06T18:00:00.000Z",
      },
      {
        id: "m1",
        content: "older",
        attachments: [],
        author: { id: "u2", bot: false },
        timestamp: "2026-03-06T17:00:00.000Z",
      },
    ];

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => inputMessages,
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await fetchDiscordMessages("123", "token-abc", 2);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/channels/123/messages?limit=2",
      {
        headers: {
          Authorization: "Bot token-abc",
        },
      },
    );

    expect(result).toEqual([
      {
        ...inputMessages[0],
        timestampMs: Date.parse(inputMessages[0].timestamp),
      },
      {
        ...inputMessages[1],
        timestampMs: Date.parse(inputMessages[1].timestamp),
      },
    ]);
  });

  it("returns [] on 403", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 403,
      headers: new Headers(),
      json: async () => {
        throw new Error("json should not be called");
      },
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(fetchDiscordMessages("456", "token")).resolves.toEqual([]);
  });

  it("returns [] on 404", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 404,
      headers: new Headers(),
      json: async () => {
        throw new Error("json should not be called");
      },
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(fetchDiscordMessages("789", "token")).resolves.toEqual([]);
  });

  it("throws RateLimitError on 429 using Retry-After header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 429,
        headers: new Headers({ "Retry-After": "5" }),
        json: async () => {
          throw new Error("should not be called");
        },
      })),
    );

    await expect(fetchDiscordMessages("321", "token")).rejects.toSatisfy(
      (e: unknown) => e instanceof RateLimitError && e.retryAfter === 5,
    );
  });

  it("throws Error with status and channelId for other non-2xx statuses", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      headers: new Headers(),
      json: async () => {
        throw new Error("json should not be called");
      },
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(fetchDiscordMessages("chan-500", "token")).rejects.toThrow(
      /status=500.*channelId=chan-500|channelId=chan-500.*status=500/,
    );
  });
});
