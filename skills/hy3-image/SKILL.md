---
name: hy3-image
description: Generate or edit images using the local HunyuanImage-3 (HY3) SDNQ server on DGX Spark (spark-0116). Use when you need text-to-image or image-conditioned editing with HY3, including uploading an input image, calling the server /generate endpoint over SSH, downloading the result, and optionally ensuring the server is running.
---

# HY3 Image (HunyuanImage-3 SDNQ)

Use the bundled script to run HY3 **text-to-image** or **edit (image-conditioned)** via the Spark host.

## Quick start

Text-to-image:

```bash
python3 {baseDir}/scripts/hy3_image.py generate \
  --prompt "Photorealistic sawfish underwater, sun rays" \
  --image-size 768x768
```

Edit (image-conditioned, preserves face/likeness from reference):

```bash
python3 {baseDir}/scripts/hy3_image.py edit \
  --prompt "Same person, same face. Golden-hour beach portrait." \
  --image ./reference.png \
  --image-size 768x768
```

## Server Management

### systemd service (preferred)

The HY3 server runs as a **systemd user service** on spark-0116:

```bash
# Status / logs
ssh john@spark-0116.local 'systemctl --user status hy3-sdnq'
ssh john@spark-0116.local 'journalctl --user -u hy3-sdnq -f'

# Restart (if needed)
ssh john@spark-0116.local 'systemctl --user restart hy3-sdnq'
```

- **Auto-restarts on crash** (`Restart=on-failure`, 30s delay)
- **Starts at boot** (linger enabled for john user)
- **Service file:** `~/.config/systemd/user/hy3-sdnq.service`
- **Model load time:** ~7 minutes (11 shards). After restart, wait for `/health` to return `{"ok": true}`.

### Health check

```bash
ssh john@spark-0116.local 'curl -s http://127.0.0.1:7869/health'
# Returns: {"ok": true, "status": "up"} when ready
```

### --ensure-server flag

The `hy3_image.py` script accepts `--ensure-server` to auto-start the server if it's down.

⚠️ **Known issue:** The ensure-server startup command uses `pkill -f hy3_sdnq_server.py` which can accidentally kill its own SSH shell (since the command line contains the pkill target string). This causes silent SSH exit code 255. **Prefer using the systemd service** for starting/stopping. If ensure-server hangs, check if the systemd service is running instead.

## Proven Settings (DO NOT CHANGE without reason)

These settings have been tested extensively and produce reliable results:

| Setting         | Value            | Notes                                                                |
| --------------- | ---------------- | -------------------------------------------------------------------- |
| **Attention**   | `sdpa` (default) | Do NOT change to `eager` unless sdpa is broken. sdpa is faster.      |
| **Steps**       | `6` (default)    | The SDNQ distilled model uses 8 internal denoising steps regardless. |
| **Image size**  | `768x768`        | Works for both generate and edit modes. `512x512` also works.        |
| **Server port** | `7869`           | Bound to 127.0.0.1 (not LAN-exposed).                                |

**If generation crashes:** Restart the server cleanly via systemd (`systemctl --user restart hy3-sdnq`) and retry with the SAME settings. Previous crashes were caused by duplicate server processes, not settings problems. Don't change resolution, steps, or attention mode as a first response.

## Two Modes

1. **`generate`** — Text-to-image. No reference image needed.
2. **`edit`** — Image-conditioned generation. Pass `--image <path>` with a reference image. The model preserves likeness/features from the reference. Use this for dream images with Prue's avatar anchor.

For dream images, **always use edit mode** with Prue's avatar (`/Users/prue/clawd/prue-elegant-2-20260129-084425.png`) to maintain facial consistency.

## Configuration (env vars)

All optional; defaults match current Spark setup.

- `HY3_SSH_HOST` (default: `john@spark-0116.local`)
- `HY3_SSH_KEY` (default: `~/.ssh/id_ed25519_spark`)
- `HY3_SERVER_URL` (default: `http://127.0.0.1:7869`)
- `HY3_REMOTE_TMP` (default: `/home/john/tmp`)
- `HY3_REMOTE_APP_DIR` (default: `/home/john/apps/HunyuanImage-3.0`)
- `HY3_REMOTE_VENV` (default: `/home/john/venvs/hy3`)
- `HY3_MODEL_DIR` (default: `/home/john/models/HunyuanImage-3-Instruct-Distil-SDNQ-4bit`)

## Outputs

- The script writes an output PNG locally (default under `/tmp/`) and prints:

```
MEDIA: /tmp/<filename>.png
```

## Troubleshooting

| Symptom                                  | Cause                             | Fix                                                     |
| ---------------------------------------- | --------------------------------- | ------------------------------------------------------- |
| `remote curl failed: rc=52`              | Server crashed during generation  | `systemctl --user restart hy3-sdnq`, wait ~7 min, retry |
| SSH exit code 255 with `--ensure-server` | pkill self-kill bug (see above)   | Use systemd to manage server instead                    |
| Server log stuck at shard loading        | Normal — 11 shards take ~7 min    | Wait for "listening on http://..." in journal           |
| Progress bar shows 0/8 then crash        | Likely duplicate server processes | Kill all, restart one via systemd                       |
| CUDA capability 12.1 warning             | PyTorch built for max 12.0        | Harmless warning — generation still works               |

## Infrastructure Notes

- **DGX Spark spark-0116:** 128GB unified memory, NVIDIA GB10 (compute 12.1)
- **SDNQ 4-bit model:** ~48GB — fits comfortably alongside parakeet-asr (~5GB)
- **Full bf16 model (158GB):** Does NOT fit on Spark. Don't attempt to load it.
- **Parakeet ASR** also runs on spark-0116 (port 8001) — both services coexist fine.
