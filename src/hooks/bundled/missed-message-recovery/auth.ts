import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../../config/paths.js";
import type { DeviceIdentity } from "../../../infra/device-identity.js";
import { loadOrCreateDeviceIdentity } from "../../../infra/device-identity.js";
import {
  type DeviceAuthEntry,
  type DeviceAuthStore,
  clearDeviceAuthTokenFromStore,
  loadDeviceAuthTokenFromStore,
  storeDeviceAuthTokenInStore,
} from "../../../shared/device-auth-store.js";

const HOOK_STATE_DIR = path.join(resolveStateDir(), "hooks", "missed-message-recovery");
const DEVICE_IDENTITY_PATH = path.join(HOOK_STATE_DIR, "device.json");
const DEVICE_AUTH_PATH = path.join(HOOK_STATE_DIR, "device-auth.json");

function readStore(filePath: string): DeviceAuthStore | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as DeviceAuthStore;
    if (parsed?.version !== 1 || typeof parsed.deviceId !== "string") {
      return null;
    }
    if (!parsed.tokens || typeof parsed.tokens !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeStore(filePath: string, store: DeviceAuthStore): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

export function loadRecoveryDeviceIdentity(): DeviceIdentity {
  return loadOrCreateDeviceIdentity(DEVICE_IDENTITY_PATH);
}

export function loadRecoveryDeviceAuthToken(params: {
  deviceId: string;
  role: string;
}): DeviceAuthEntry | null {
  return loadDeviceAuthTokenFromStore({
    adapter: {
      readStore: () => readStore(DEVICE_AUTH_PATH),
      writeStore: (_store) => {},
    },
    deviceId: params.deviceId,
    role: params.role,
  });
}

export function storeRecoveryDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  token: string;
  scopes?: string[];
}): DeviceAuthEntry {
  return storeDeviceAuthTokenInStore({
    adapter: {
      readStore: () => readStore(DEVICE_AUTH_PATH),
      writeStore: (store) => writeStore(DEVICE_AUTH_PATH, store),
    },
    deviceId: params.deviceId,
    role: params.role,
    token: params.token,
    scopes: params.scopes,
  });
}

export function clearRecoveryDeviceAuthToken(params: { deviceId: string; role: string }): void {
  clearDeviceAuthTokenFromStore({
    adapter: {
      readStore: () => readStore(DEVICE_AUTH_PATH),
      writeStore: (store) => writeStore(DEVICE_AUTH_PATH, store),
    },
    deviceId: params.deviceId,
    role: params.role,
  });
}

export const RECOVERY_DEVICE_IDENTITY_PATH = DEVICE_IDENTITY_PATH;
export const RECOVERY_DEVICE_AUTH_PATH = DEVICE_AUTH_PATH;
