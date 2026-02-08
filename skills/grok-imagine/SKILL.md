---
name: grok-imagine
description: Generate single images via xAI Grok Imagine API. Returns MEDIA path on stdout.
homepage: https://console.x.ai
metadata:
  openclaw:
    emoji: "🎨"
    requires:
      bins: ["python3"]
      env: ["XAI_API_KEY"]
    primaryEnv: "XAI_API_KEY"
---

# Grok Imagine

Single-image generation CLI for xAI's Grok Imagine models.

## Quick Start

```bash
python3 {baseDir}/scripts/generate.py \
  --prompt "a brutalist lighthouse at golden hour" \
  --output /tmp/lighthouse.jpg
```

Stdout prints exactly one line: `MEDIA: /absolute/path`

## Usage

```bash
python3 {baseDir}/scripts/generate.py \
  --prompt "PROMPT" \
  --output OUTPUT_PATH \
  [--model MODEL] \
  [--timeout SECONDS] \
  [--retries N] \
  [--retry-backoff BASE] \
  [--metadata SIDECAR_PATH]
```

### Arguments

| Arg               | Default              | Description                     |
| ----------------- | -------------------- | ------------------------------- |
| `--prompt`        | _(required)_         | Image prompt text               |
| `--output`        | _(required)_         | Output file path                |
| `--model`         | `grok-imagine-image` | Model id                        |
| `--timeout`       | `30`                 | HTTP timeout (seconds)          |
| `--retries`       | `2`                  | Max retries on transient errors |
| `--retry-backoff` | `2.0`                | Exponential backoff base        |
| `--metadata`      | _(none)_             | Path for JSON metadata sidecar  |

## Models

| Model                    | Notes                  |
| ------------------------ | ---------------------- |
| `grok-imagine-image`     | Standard quality, fast |
| `grok-imagine-image-pro` | Higher quality, slower |

## Examples

```bash
# Standard model
python3 {baseDir}/scripts/generate.py \
  --prompt "cyberpunk noodle shop in neon rain" \
  --output ~/images/noodles.jpg

# Pro model with metadata sidecar
python3 {baseDir}/scripts/generate.py \
  --model grok-imagine-image-pro \
  --prompt "minimalist product photo of a ceramic vase" \
  --output ~/images/vase.jpg \
  --metadata ~/images/vase.json

# With increased timeout and retries
python3 {baseDir}/scripts/generate.py \
  --prompt "surreal underwater library" \
  --output /tmp/library.jpg \
  --timeout 60 --retries 4
```

## Authentication

1. **Environment variable:** `XAI_API_KEY`
2. **Fallback:** 1Password CLI — reads from `op://$OP_VAULT/xAI API Key/password` (defaults to `Private` vault; set `OP_VAULT` to override)

If neither is available the script exits with code 1.

## API Quirks

- **No size parameter.** The API does not accept a `size` field; output dimensions are determined automatically (typically 1408×768 JPEG).
- **Expiring URLs.** The `.data[0].url` in the API response is temporary — the script downloads it immediately.
- **Single image only.** `n` is always 1.

## Exit Codes

| Code | Meaning                              |
| ---- | ------------------------------------ |
| 0    | Success                              |
| 1    | Authentication error                 |
| 2    | API error (rate limit, server error) |
| 3    | Download / save error                |
| 4    | Invalid arguments                    |

## Output Contract

- **stdout:** Exactly one line: `MEDIA: /absolute/path`
- **stderr:** Model info, dimensions, timing, errors
