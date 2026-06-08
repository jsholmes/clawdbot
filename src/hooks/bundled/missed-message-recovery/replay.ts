import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/version.js";
import { buildDeviceAuthPayloadV3 } from "../../../gateway/device-auth.js";
import { publicKeyRawBase64UrlFromPem, signDevicePayload } from "../../../infra/device-identity.js";
import { VERSION } from "../../../version.js";
import {
  loadRecoveryDeviceAuthToken,
  loadRecoveryDeviceIdentity,
  storeRecoveryDeviceAuthToken,
} from "./auth.js";

export const RECOVERY_NOTE_CONTENT = "*(recovered — message sent while gateway was restarting)*";

/** Maximum time to wait for the full WS handshake + agent response. */
const REPLAY_TIMEOUT_MS = 30_000;
const RECOVERY_ROLE = "operator";
const RECOVERY_SCOPES = ["operator.read", "operator.write"];

export async function postRecoveryNote(channelId: string, botToken: string): Promise<void> {
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content: RECOVERY_NOTE_CONTENT }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to post recovery note (status=${response.status}, channelId=${channelId}, body=${body})`,
    );
  }
}

export type ReplayMessageParams = {
  port: number;
  gatewayToken: string;
  sessionKey: string;
  message: string;
  channelId: string;
  messageId: string;
};

/**
 * Replay a missed message through the gateway's WS JSON-RPC interface.
 *
 * Uses a dedicated stable backend device identity for this hook. That keeps
 * operator scopes bound to an authenticated device instead of relying on a
 * device-less shared-token connect (which 2026.3.12 now strips to zero scopes).
 *
 * When the gateway returns a device token in hello-ok, cache it in the hook's
 * own auth store for future reconnects. On same-host installs the gateway may
 * still choose the authenticated-local backend fast path and omit a device token;
 * the signed device identity is still what preserves the requested scopes.
 */
export async function replayMessage(params: ReplayMessageParams): Promise<void> {
  const { port, gatewayToken, sessionKey, message, channelId, messageId } = params;
  const connectId = randomUUID();
  const requestId = `recovery-${messageId}`;
  const identity = loadRecoveryDeviceIdentity();
  const cachedDeviceAuth = loadRecoveryDeviceAuthToken({
    deviceId: identity.deviceId,
    role: RECOVERY_ROLE,
  });

  return await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    let settled = false;
    let phase: "challenge" | "connect" | "request" | "done" = "challenge";

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.close();
        reject(new Error(`Replay timed out after ${REPLAY_TIMEOUT_MS}ms (channelId=${channelId})`));
      }
    }, REPLAY_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };

    ws.on("error", (err) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(`WS error during replay: ${err.message}`));
      }
    });

    ws.on("close", () => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(`WS closed unexpectedly during replay (phase=${phase})`));
      }
    });

    ws.on("message", (data) => {
      let msg: Record<string, unknown>;
      try {
        const raw =
          typeof data === "string"
            ? data
            : Buffer.isBuffer(data)
              ? data.toString("utf8")
              : JSON.stringify(data);
        msg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }

      // Step 1: Receive connect.challenge → send connect request
      if (phase === "challenge" && msg.type === "event" && msg.event === "connect.challenge") {
        const nonce =
          typeof (msg.payload as { nonce?: unknown } | undefined)?.nonce === "string"
            ? ((msg.payload as { nonce?: string }).nonce ?? "").trim()
            : "";
        if (!nonce) {
          settled = true;
          cleanup();
          reject(new Error(`Gateway connect challenge missing nonce (channelId=${channelId})`));
          return;
        }
        const signedAtMs = Date.now();
        const payload = buildDeviceAuthPayloadV3({
          deviceId: identity.deviceId,
          clientId: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
          clientMode: GATEWAY_CLIENT_MODES.BACKEND,
          role: RECOVERY_ROLE,
          scopes: RECOVERY_SCOPES,
          signedAtMs,
          token: gatewayToken,
          nonce,
          platform: process.platform,
          deviceFamily: undefined,
        });
        const signature = signDevicePayload(identity.privateKeyPem, payload);
        phase = "connect";
        ws.send(
          JSON.stringify({
            type: "req",
            id: connectId,
            method: "connect",
            params: {
              minProtocol: PROTOCOL_VERSION,
              maxProtocol: PROTOCOL_VERSION,
              role: RECOVERY_ROLE,
              client: {
                id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
                displayName: "missed-message-recovery",
                version: VERSION,
                platform: process.platform,
                mode: GATEWAY_CLIENT_MODES.BACKEND,
              },
              auth: {
                token: gatewayToken,
                deviceToken: cachedDeviceAuth?.token,
              },
              scopes: RECOVERY_SCOPES,
              device: {
                id: identity.deviceId,
                publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
                signature,
                signedAt: signedAtMs,
                nonce,
              },
            },
          }),
        );
        return;
      }

      // Step 2: Receive connect response → send agent request
      if (phase === "connect" && msg.type === "res" && msg.id === connectId) {
        if (msg.ok === false) {
          settled = true;
          cleanup();
          const errorText =
            typeof msg.error === "object" && msg.error !== null
              ? JSON.stringify(msg.error)
              : JSON.stringify(msg.error ?? "unknown connect error");
          reject(new Error(`Gateway connect rejected: ${errorText}`));
          return;
        }
        const deviceToken =
          typeof (msg.payload as { auth?: { deviceToken?: unknown } } | undefined)?.auth
            ?.deviceToken === "string"
            ? (
                (
                  msg.payload as {
                    auth?: { deviceToken?: string; role?: string; scopes?: string[] };
                  }
                ).auth?.deviceToken ?? ""
              ).trim() || null
            : null;
        if (deviceToken) {
          const authInfo = (
            msg.payload as {
              auth?: { deviceToken?: string; role?: string; scopes?: string[] };
            }
          ).auth;
          storeRecoveryDeviceAuthToken({
            deviceId: identity.deviceId,
            role: authInfo?.role ?? RECOVERY_ROLE,
            token: deviceToken,
            scopes: authInfo?.scopes ?? RECOVERY_SCOPES,
          });
        }
        phase = "request";
        ws.send(
          JSON.stringify({
            type: "req",
            id: requestId,
            method: "agent",
            params: {
              sessionKey,
              message,
              channel: "discord",
              to: `channel:${channelId}`,
              accountId: "default",
              deliver: true,
              idempotencyKey: requestId,
            },
          }),
        );
        return;
      }

      // Step 3: Receive agent response
      if (phase === "request" && msg.type === "res" && msg.id === requestId) {
        settled = true;
        phase = "done";
        cleanup();
        if (msg.ok === false) {
          const errorText =
            typeof msg.error === "object" && msg.error !== null
              ? JSON.stringify(msg.error)
              : JSON.stringify(msg.error ?? "unknown");
          reject(new Error(`Gateway replay returned ok=false: ${errorText}`));
        } else {
          resolve();
        }
        return;
      }

      // Handle unexpected errors
      if (msg.type === "res" && msg.ok === false) {
        settled = true;
        cleanup();
        const errorText =
          typeof msg.error === "object" && msg.error !== null
            ? JSON.stringify(msg.error)
            : JSON.stringify(msg.error ?? "unknown");
        reject(new Error(`Gateway error: ${errorText}`));
      }
    });
  });
}
