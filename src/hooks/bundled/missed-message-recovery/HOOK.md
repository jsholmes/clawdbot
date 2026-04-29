---
name: missed-message-recovery
description: "Replay messages sent while the gateway was restarting"
homepage: https://docs.openclaw.ai/automation/hooks#missed-message-recovery
metadata:
  {
    "openclaw":
      {
        "emoji": "🔁",
        "events": ["gateway:startup"],
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Missed Message Recovery Hook

Automatically replays Discord messages that arrived while the gateway was restarting.

## What It Does

When the gateway restarts:

1. **Records shutdown time** — on `gateway_stop`, saves the current timestamp to disk
2. **Scans sessions on startup** — on `gateway_start`, walks all known Discord channel sessions
3. **Detects missed messages** — finds messages sent after shutdown with no bot reply yet
4. **Replays them** — posts a `*(recovered...)*` note then replays each message through the gateway
5. **Resets state** — clears the shutdown timestamp after successful recovery

## Requirements

- Discord channel must be configured (`channels.discord`)
- Gateway auth token must be set (`gateway.auth.token`)

## Disabling

```bash
openclaw hooks disable missed-message-recovery
```

Or in config:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "missed-message-recovery": { "enabled": false }
      }
    }
  }
}
```
