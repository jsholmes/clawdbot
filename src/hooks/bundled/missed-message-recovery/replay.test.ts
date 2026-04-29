import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockSocket = {
  sent: string[];
  emit: (event: string, payload?: unknown) => void;
};

const sockets: MockSocket[] = [];

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class MockWebSocket extends EventEmitter {
    sent: string[] = [];

    constructor(_url: string) {
      super();
      sockets.push(this as unknown as MockSocket);
    }

    send(data: string) {
      this.sent.push(data);
    }

    close() {
      this.emit("close");
    }
  }

  return { WebSocket: MockWebSocket };
});

const loadRecoveryDeviceIdentityMock = vi.fn();
const loadRecoveryDeviceAuthTokenMock = vi.fn();
const storeRecoveryDeviceAuthTokenMock = vi.fn();
const buildDeviceAuthPayloadV3Mock = vi.fn();
const publicKeyRawBase64UrlFromPemMock = vi.fn();
const signDevicePayloadMock = vi.fn();

vi.mock("./auth.js", () => ({
  loadRecoveryDeviceIdentity: loadRecoveryDeviceIdentityMock,
  loadRecoveryDeviceAuthToken: loadRecoveryDeviceAuthTokenMock,
  storeRecoveryDeviceAuthToken: storeRecoveryDeviceAuthTokenMock,
}));

vi.mock("../../../gateway/device-auth.js", () => ({
  buildDeviceAuthPayloadV3: buildDeviceAuthPayloadV3Mock,
}));

vi.mock("../../../infra/device-identity.js", () => ({
  publicKeyRawBase64UrlFromPem: publicKeyRawBase64UrlFromPemMock,
  signDevicePayload: signDevicePayloadMock,
}));

describe("missed-message-recovery replay", () => {
  beforeEach(() => {
    sockets.length = 0;
    vi.clearAllMocks();
    loadRecoveryDeviceIdentityMock.mockReturnValue({
      deviceId: "dev-1",
      publicKeyPem: "PUBLIC-PEM",
      privateKeyPem: "PRIVATE-PEM",
    });
    loadRecoveryDeviceAuthTokenMock.mockReturnValue(null);
    buildDeviceAuthPayloadV3Mock.mockReturnValue("signed-payload-v3");
    publicKeyRawBase64UrlFromPemMock.mockReturnValue("public-key-b64");
    signDevicePayloadMock.mockReturnValue("signature-b64");
  });

  afterEach(() => {
    sockets.length = 0;
  });

  it("sends a signed backend device identity on connect and replays the message", async () => {
    const { replayMessage } = await import("./replay.js");

    const replayPromise = replayMessage({
      port: 18789,
      gatewayToken: "gateway-token",
      sessionKey: "agent:main:discord:channel:123",
      message: "hello from recovery",
      channelId: "123",
      messageId: "msg-1",
    });

    expect(sockets).toHaveLength(1);
    const socket = sockets[0];

    socket.emit(
      "message",
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "nonce-123" },
      }),
    );

    expect(socket.sent).toHaveLength(1);
    const connectReq = JSON.parse(socket.sent[0]);
    expect(connectReq.method).toBe("connect");
    expect(connectReq.params.auth).toEqual({
      token: "gateway-token",
      deviceToken: undefined,
    });
    expect(connectReq.params.scopes).toEqual(["operator.read", "operator.write"]);
    expect(connectReq.params.device).toMatchObject({
      id: "dev-1",
      publicKey: "public-key-b64",
      signature: "signature-b64",
      nonce: "nonce-123",
    });
    expect(buildDeviceAuthPayloadV3Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: "dev-1",
        clientId: "gateway-client",
        clientMode: "backend",
        role: "operator",
        scopes: ["operator.read", "operator.write"],
        token: "gateway-token",
        nonce: "nonce-123",
      }),
    );
    expect(signDevicePayloadMock).toHaveBeenCalledWith("PRIVATE-PEM", "signed-payload-v3");

    socket.emit(
      "message",
      JSON.stringify({
        type: "res",
        id: connectReq.id,
        ok: true,
        payload: {
          type: "hello-ok",
          auth: {
            deviceToken: "device-token-1",
            role: "operator",
            scopes: ["operator.read", "operator.write"],
          },
        },
      }),
    );

    expect(socket.sent).toHaveLength(2);
    const agentReq = JSON.parse(socket.sent[1]);
    expect(agentReq.method).toBe("agent");
    expect(agentReq.params).toMatchObject({
      sessionKey: "agent:main:discord:channel:123",
      message: "hello from recovery",
      channel: "discord",
      to: "channel:123",
      accountId: "default",
      deliver: true,
    });
    expect(storeRecoveryDeviceAuthTokenMock).toHaveBeenCalledWith({
      deviceId: "dev-1",
      role: "operator",
      token: "device-token-1",
      scopes: ["operator.read", "operator.write"],
    });

    socket.emit(
      "message",
      JSON.stringify({
        type: "res",
        id: agentReq.id,
        ok: true,
        payload: {},
      }),
    );

    await expect(replayPromise).resolves.toBeUndefined();
  });

  it("reuses a cached recovery device token when present", async () => {
    loadRecoveryDeviceAuthTokenMock.mockReturnValue({
      token: "cached-device-token",
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      updatedAtMs: Date.now(),
    });

    const { replayMessage } = await import("./replay.js");

    const replayPromise = replayMessage({
      port: 18789,
      gatewayToken: "gateway-token",
      sessionKey: "agent:main:discord:channel:456",
      message: "retry",
      channelId: "456",
      messageId: "msg-2",
    });

    const socket = sockets[0];
    socket.emit(
      "message",
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "nonce-456" },
      }),
    );

    const connectReq = JSON.parse(socket.sent[0]);
    expect(connectReq.params.auth).toEqual({
      token: "gateway-token",
      deviceToken: "cached-device-token",
    });

    socket.emit(
      "message",
      JSON.stringify({ type: "res", id: connectReq.id, ok: true, payload: { type: "hello-ok" } }),
    );
    const agentReq = JSON.parse(socket.sent[1]);
    socket.emit("message", JSON.stringify({ type: "res", id: agentReq.id, ok: true, payload: {} }));

    await expect(replayPromise).resolves.toBeUndefined();
  });
});
