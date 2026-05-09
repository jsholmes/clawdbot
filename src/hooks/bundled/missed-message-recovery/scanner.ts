export type DiscordMessage = {
  id: string;
  content: string;
  type?: number;
  attachments?: DiscordAttachment[];
  author: { id: string; bot?: boolean };
  timestamp: string;
  timestampMs: number;
};

export type DiscordAttachment = {
  id: string;
  url: string;
  filename?: string;
  content_type?: string;
};

export class RateLimitError extends Error {
  constructor(public retryAfter: number) {
    super("Discord rate limited");
    this.name = "RateLimitError";
  }
}

type DiscordApiMessage = Omit<DiscordMessage, "timestampMs">;

export async function fetchDiscordMessages(
  channelId: string,
  botToken: string,
  limit = 25,
): Promise<DiscordMessage[]> {
  const response = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages?limit=${limit}`,
    {
      headers: {
        Authorization: `Bot ${botToken}`,
      },
    },
  );

  if (response.status === 403 || response.status === 404) {
    return [];
  }

  if (response.status === 429) {
    const retryAfterHeader = response.headers.get("Retry-After");
    const retryAfter = Number.parseInt(retryAfterHeader ?? "0", 10);
    throw new RateLimitError(Number.isFinite(retryAfter) ? retryAfter : 0);
  }

  if (!response.ok) {
    throw new Error(
      `Failed to fetch Discord messages (status=${response.status}, channelId=${channelId})`,
    );
  }

  const payload = (await response.json()) as DiscordApiMessage[];
  return payload.map((message) =>
    Object.assign(message, {
      timestampMs: Date.parse(message.timestamp),
    }),
  );
}
