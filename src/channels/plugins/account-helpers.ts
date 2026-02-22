import type { OpenClawConfig } from "../../config/config.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";

export function createAccountListHelpers(
  channelKey: string,
  options?: {
    /** Return true when a top-level / env token exists for the default account. */
    hasDefaultToken?: (cfg: OpenClawConfig) => boolean;
  },
) {
  function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
    const channel = cfg.channels?.[channelKey];
    const accounts = (channel as Record<string, unknown> | undefined)?.accounts;
    if (!accounts || typeof accounts !== "object") {
      return [];
    }
    return Object.keys(accounts as Record<string, unknown>).filter(Boolean);
  }

  function listAccountIds(cfg: OpenClawConfig): string[] {
    const ids = listConfiguredAccountIds(cfg);
    if (ids.length === 0) {
      return [DEFAULT_ACCOUNT_ID];
    }
    // When sub-accounts are configured but the default account is not among
    // them, check whether a top-level token still exists (env var or
    // channel-level config).  If so, include the default account so messages
    // routed to it are not silently dropped.
    if (!ids.includes(DEFAULT_ACCOUNT_ID) && options?.hasDefaultToken?.(cfg)) {
      return [...ids, DEFAULT_ACCOUNT_ID].toSorted((a, b) => a.localeCompare(b));
    }
    return ids.toSorted((a, b) => a.localeCompare(b));
  }

  function resolveDefaultAccountId(cfg: OpenClawConfig): string {
    const ids = listAccountIds(cfg);
    if (ids.includes(DEFAULT_ACCOUNT_ID)) {
      return DEFAULT_ACCOUNT_ID;
    }
    return ids[0] ?? DEFAULT_ACCOUNT_ID;
  }

  return { listConfiguredAccountIds, listAccountIds, resolveDefaultAccountId };
}
