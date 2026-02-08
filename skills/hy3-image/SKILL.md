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

Edit (image-conditioned):

```bash
python3 {baseDir}/scripts/hy3_image.py edit \
  --prompt "Same person, same face. Golden-hour beach portrait." \
  --image ./reference.png \
  --image-size 768x768
```

## Notes

- By default this runs the request **on spark-0116 via SSH** and saves the output locally, printing a `MEDIA:` line.
- If the server is down, pass `--ensure-server` to attempt to start it and wait for `/health`.
- Server endpoint is assumed to be `http://127.0.0.1:7869` on the Spark host (not exposed on the LAN).

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
