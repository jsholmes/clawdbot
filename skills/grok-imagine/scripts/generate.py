#!/usr/bin/env python3
"""Single-image CLI for xAI Grok Imagine image generation.

Stdout contract: exactly one line  MEDIA: /absolute/path
All diagnostics go to stderr.

Exit codes:
  0 = success
  1 = auth error
  2 = API error
  3 = download / save error
  4 = invalid arguments
"""
from __future__ import annotations

import argparse
import json
import os
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

def resolve_api_key() -> str:
    """Return XAI API key from env or 1Password, or exit(1)."""
    key = os.environ.get("XAI_API_KEY", "").strip()
    if key:
        return key

    vault = os.environ.get("OP_VAULT", "Private")
    print(f"XAI_API_KEY not set; trying 1Password (vault: {vault}) …", file=sys.stderr)
    try:
        result = subprocess.run(
            ["op", "read", f"op://{vault}/xAI API Key/password"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        key = result.stdout.strip()
        if result.returncode == 0 and key:
            return key
    except FileNotFoundError:
        pass
    except subprocess.TimeoutExpired:
        pass

    print("ERROR: No xAI API key found. Set XAI_API_KEY or configure 1Password CLI (OP_VAULT to set vault).", file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------------------
# API helpers
# ---------------------------------------------------------------------------

_RETRYABLE = {429, 500, 502, 503, 504}


def _api_generate(
    api_key: str,
    model: str,
    prompt: str,
    timeout: int,
    retries: int,
    backoff: float,
) -> dict:
    """Call xAI images/generations and return parsed JSON."""
    url = "https://api.x.ai/v1/images/generations"
    body = json.dumps({"model": model, "prompt": prompt, "n": 1}).encode()
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": "grok-imagine-cli/1.0",
    }

    last_err: Exception | None = None
    for attempt in range(1 + retries):
        if attempt > 0:
            wait = backoff ** attempt
            print(f"  retry {attempt}/{retries} in {wait:.1f}s …", file=sys.stderr)
            time.sleep(wait)

        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            payload = exc.read().decode("utf-8", errors="replace")
            print(f"  API HTTP {exc.code}: {payload[:300]}", file=sys.stderr)
            if exc.code in _RETRYABLE:
                last_err = exc
                continue
            # Non-retryable
            print(f"ERROR: xAI API returned {exc.code}", file=sys.stderr)
            sys.exit(2)
        except (urllib.error.URLError, OSError) as exc:
            print(f"  network error: {exc}", file=sys.stderr)
            last_err = exc
            continue

    print(f"ERROR: xAI API failed after {retries + 1} attempts: {last_err}", file=sys.stderr)
    sys.exit(2)


def _download(image_url: str, dest: Path, timeout: int, retries: int, backoff: float) -> None:
    """Download URL to *dest* with retries."""
    last_err: Exception | None = None
    for attempt in range(1 + retries):
        if attempt > 0:
            wait = backoff ** attempt
            print(f"  download retry {attempt}/{retries} in {wait:.1f}s …", file=sys.stderr)
            time.sleep(wait)

        req = urllib.request.Request(image_url, headers={"User-Agent": "grok-imagine-cli/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = resp.read()
                dest.write_bytes(data)
                return
        except (urllib.error.URLError, OSError) as exc:
            print(f"  download error: {exc}", file=sys.stderr)
            last_err = exc

    print(f"ERROR: image download failed after {retries + 1} attempts: {last_err}", file=sys.stderr)
    sys.exit(3)


# ---------------------------------------------------------------------------
# Image dimension detection (JPEG only, no deps)
# ---------------------------------------------------------------------------

def _jpeg_dimensions(data: bytes) -> tuple[int, int] | None:
    """Parse JPEG SOF marker to extract (width, height)."""
    if len(data) < 4 or data[:2] != b"\xff\xd8":
        return None
    i = 2
    while i < len(data) - 9:
        if data[i] != 0xFF:
            break
        marker = data[i + 1]
        if marker in (0xC0, 0xC1, 0xC2):
            h, w = struct.unpack(">HH", data[i + 5 : i + 9])
            return w, h
        length = struct.unpack(">H", data[i + 2 : i + 4])[0]
        i += 2 + length
    return None


def _png_dimensions(data: bytes) -> tuple[int, int] | None:
    """Parse PNG IHDR to extract (width, height)."""
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    w, h = struct.unpack(">II", data[16:24])
    return w, h


def image_dimensions(data: bytes) -> tuple[int, int] | None:
    return _jpeg_dimensions(data) or _png_dimensions(data)


# ---------------------------------------------------------------------------
# Metadata sidecar
# ---------------------------------------------------------------------------

def write_metadata(
    meta_path: Path,
    *,
    model: str,
    prompt: str,
    output: str,
    width: int | None,
    height: int | None,
    elapsed: float,
) -> None:
    meta = {
        "model": model,
        "prompt": prompt,
        "output": output,
        "width": width,
        "height": height,
        "elapsed_seconds": round(elapsed, 2),
        "generator": "grok-imagine/generate.py",
    }
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = meta_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(meta, indent=2) + "\n")
    tmp.rename(meta_path)
    print(f"metadata: {meta_path}", file=sys.stderr)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

MODELS = ("grok-imagine-image", "grok-imagine-image-pro")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Generate a single image via xAI Grok Imagine.",
    )
    p.add_argument("--prompt", required=True, help="Image prompt text.")
    p.add_argument("--output", required=True, help="Output file path.")
    p.add_argument(
        "--model",
        default="grok-imagine-image",
        choices=MODELS,
        help="Model id (default: grok-imagine-image).",
    )
    p.add_argument("--timeout", type=int, default=30, help="HTTP timeout seconds (default: 30).")
    p.add_argument("--retries", type=int, default=2, help="Max retries on transient errors (default: 2).")
    p.add_argument("--retry-backoff", type=float, default=2.0, help="Exponential backoff base (default: 2.0).")
    p.add_argument("--metadata", default="", help="Path for optional JSON metadata sidecar.")
    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    # Validate output path
    output = Path(args.output).resolve()
    if output.is_dir():
        print("ERROR: --output must be a file path, not a directory", file=sys.stderr)
        return 4

    api_key = resolve_api_key()

    print(f"model: {args.model}", file=sys.stderr)
    print(f"prompt: {args.prompt[:120]}", file=sys.stderr)

    t0 = time.monotonic()

    # API call
    result = _api_generate(
        api_key,
        args.model,
        args.prompt,
        args.timeout,
        args.retries,
        args.retry_backoff,
    )

    data_list = result.get("data", [])
    if not data_list or "url" not in data_list[0]:
        print(f"ERROR: unexpected API response: {json.dumps(result)[:400]}", file=sys.stderr)
        return 2

    image_url = data_list[0]["url"]

    # Download to temp file, then atomic rename
    output.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = output.with_name(output.name + ".tmp")

    _download(image_url, tmp_path, args.timeout, args.retries, args.retry_backoff)

    # Read back for dimension detection
    img_data = tmp_path.read_bytes()
    dims = image_dimensions(img_data)

    # Atomic rename
    tmp_path.rename(output)

    elapsed = time.monotonic() - t0

    if dims:
        print(f"dimensions: {dims[0]}x{dims[1]}", file=sys.stderr)
    print(f"size: {len(img_data):,} bytes", file=sys.stderr)
    print(f"elapsed: {elapsed:.1f}s", file=sys.stderr)
    print(f"saved: {output}", file=sys.stderr)

    # Optional metadata sidecar
    if args.metadata:
        write_metadata(
            Path(args.metadata).resolve(),
            model=args.model,
            prompt=args.prompt,
            output=str(output),
            width=dims[0] if dims else None,
            height=dims[1] if dims else None,
            elapsed=elapsed,
        )

    # Contract: exactly one line on stdout
    print(f"MEDIA: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
