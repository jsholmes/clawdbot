#!/usr/bin/env python3
"""Single-image CLI for OpenAI image generation.

Stdout contract: exactly one line  MEDIA: /absolute/path
All diagnostics go to stderr.

Exit codes:
  0 = success
  1 = auth error
  2 = API error (content policy, rate limit, etc.)
  3 = decode / save error
  4 = invalid arguments
"""
from __future__ import annotations

import argparse
import base64
import json
import struct
import sys
import time
from pathlib import Path

# Sibling module
sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402


# ---------------------------------------------------------------------------
# Image dimension helpers (no Pillow needed)
# ---------------------------------------------------------------------------

def _png_dimensions(data: bytes) -> tuple[int, int] | None:
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    w, h = struct.unpack(">II", data[16:24])
    return w, h


def _jpeg_dimensions(data: bytes) -> tuple[int, int] | None:
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


def _webp_dimensions(data: bytes) -> tuple[int, int] | None:
    if len(data) < 30 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        return None
    # VP8 lossy
    if data[12:16] == b"VP8 " and len(data) >= 30:
        w = int.from_bytes(data[26:28], "little") & 0x3FFF
        h = int.from_bytes(data[28:30], "little") & 0x3FFF
        return w, h
    # VP8L lossless
    if data[12:16] == b"VP8L" and len(data) >= 25:
        bits = int.from_bytes(data[21:25], "little")
        w = (bits & 0x3FFF) + 1
        h = ((bits >> 14) & 0x3FFF) + 1
        return w, h
    return None


def image_dimensions(data: bytes) -> tuple[int, int] | None:
    return _png_dimensions(data) or _jpeg_dimensions(data) or _webp_dimensions(data)


# ---------------------------------------------------------------------------
# Format / extension helpers
# ---------------------------------------------------------------------------

_FMT_EXTENSIONS = {"png": ".png", "jpeg": ".jpg", "webp": ".webp"}


def _validate_extension(output: Path, fmt: str) -> list[str]:
    """Warn (but don't error) if extension doesn't match format."""
    expected = _FMT_EXTENSIONS.get(fmt)
    if expected is None:
        return []
    ext = output.suffix.lower()
    # Accept both .jpg and .jpeg
    if fmt == "jpeg" and ext in (".jpg", ".jpeg"):
        return []
    if ext != expected:
        return [f"Warning: output extension '{ext}' does not match --format '{fmt}' (expected '{expected}')"]
    return []


# ---------------------------------------------------------------------------
# Metadata sidecar
# ---------------------------------------------------------------------------

def write_metadata(
    meta_path: Path,
    *,
    model: str,
    prompt: str,
    output: str,
    fmt: str,
    size: str,
    quality: str,
    width: int | None,
    height: int | None,
    elapsed: float,
    cost: float | None,
    usage: dict | None,
) -> None:
    meta = {
        "model": model,
        "prompt": prompt,
        "output": output,
        "format": fmt,
        "size": size,
        "quality": quality,
        "width": width,
        "height": height,
        "elapsed_seconds": round(elapsed, 2),
        "estimated_cost_usd": cost,
        "usage": usage,
        "generator": "openai-image-gen/generate.py",
    }
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = meta_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(meta, indent=2) + "\n")
    tmp.rename(meta_path)
    print(f"metadata: {meta_path}", file=sys.stderr)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Generate a single image via OpenAI Images API.",
    )
    p.add_argument("--prompt", required=True, help="Image prompt text.")
    p.add_argument("--output", required=True, help="Output file path.")
    p.add_argument("--image", default="", help="Reference image path for edit mode (uses /v1/images/edits).")
    p.add_argument(
        "--model",
        default="gpt-image-1.5",
        choices=common.ALL_MODELS,
        help="Model id (default: gpt-image-1.5).",
    )
    p.add_argument("--size", default="1024x1024", help="Image size (default: 1024x1024).")
    p.add_argument("--quality", default="high", help="Quality level (default: high).")
    p.add_argument("--format", default="png", dest="fmt", help="Output format: png, jpeg, webp (default: png).")
    p.add_argument("--background", default="auto", help="Background: transparent, opaque, auto (GPT models only; default: auto).")
    p.add_argument("--style", default="", help="Style: vivid or natural (dall-e-3 only).")
    p.add_argument("--timeout", type=int, default=60, help="HTTP timeout seconds (default: 60).")
    p.add_argument("--retries", type=int, default=2, help="Max retries on transient errors (default: 2).")
    p.add_argument("--retry-backoff", type=float, default=2.0, help="Exponential backoff base (default: 2.0).")
    p.add_argument("--estimate-cost", action="store_true", help="Print estimated cost to stderr.")
    p.add_argument("--metadata", default="", help="Path for optional JSON metadata sidecar.")
    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    output = Path(args.output).resolve()
    if output.is_dir():
        print("ERROR: --output must be a file path, not a directory", file=sys.stderr)
        return 4

    # Deprecation warning
    if args.model == "dall-e-2":
        print("WARNING: dall-e-2 is deprecated. Consider using gpt-image-1 or newer.", file=sys.stderr)

    # For non-GPT models, clear background (not supported)
    background = args.background if common.is_gpt_image(args.model) else ""

    # Validate parameter combo
    errors = common.validate_params(
        args.model,
        args.size,
        args.quality,
        args.fmt,
        background,
        args.style,
    )
    if errors:
        for e in errors:
            print(f"ERROR: {e}", file=sys.stderr)
        return 4

    # Extension check (warning only)
    ext_warns = _validate_extension(output, args.fmt)
    for w in ext_warns:
        print(w, file=sys.stderr)

    # Cost estimate
    cost = common.estimate_cost(args.model, args.quality)
    if args.estimate_cost and cost is not None:
        print(f"estimated cost: ~${cost:.3f}", file=sys.stderr)

    api_key = common.resolve_api_key()

    # Check edit mode
    edit_mode = bool(args.image)
    if edit_mode:
        image_path = Path(args.image).resolve()
        if not image_path.exists():
            print(f"ERROR: reference image not found: {image_path}", file=sys.stderr)
            return 4
        print(f"mode: EDIT (reference: {image_path})", file=sys.stderr)
    else:
        print("mode: GENERATE", file=sys.stderr)

    print(f"model: {args.model}", file=sys.stderr)
    print(f"size: {args.size}  quality: {args.quality}  format: {args.fmt}", file=sys.stderr)
    print(f"prompt: {args.prompt[:120]}", file=sys.stderr)

    t0 = time.monotonic()

    if edit_mode:
        # Use edit endpoint with reference image
        result = common.api_edit_request(
            api_key,
            str(image_path),
            args.prompt,
            model=args.model,
            size=args.size,
            quality=args.quality,
            timeout=args.timeout,
            retries=args.retries,
            backoff=args.retry_backoff,
        )
    else:
        # Build generation API payload
        payload: dict = {
            "model": args.model,
            "prompt": args.prompt,
            "n": 1,
            "size": args.size,
        }

        if common.is_gpt_image(args.model):
            payload["quality"] = args.quality
            if background:
                payload["background"] = background
            if args.fmt:
                payload["output_format"] = args.fmt
        elif args.model == "dall-e-3":
            payload["quality"] = args.quality
            if args.style:
                payload["style"] = args.style
        # dall-e-2: no quality param

        result = common.api_request(
            api_key,
            payload,
            timeout=args.timeout,
            retries=args.retries,
            backoff=args.retry_backoff,
        )

    elapsed = time.monotonic() - t0

    # Extract response
    data_list = result.get("data", [])
    usage = result.get("usage")
    if not data_list:
        print(f"ERROR: empty data in response: {json.dumps(result)[:400]}", file=sys.stderr)
        return 2

    item = data_list[0]
    b64 = item.get("b64_json")
    if not b64:
        print(f"ERROR: no b64_json in response: {json.dumps(item)[:300]}", file=sys.stderr)
        return 2

    # Decode
    try:
        img_data = base64.b64decode(b64)
    except Exception as exc:
        print(f"ERROR: base64 decode failed: {exc}", file=sys.stderr)
        return 3

    if not img_data:
        print("ERROR: decoded image is empty", file=sys.stderr)
        return 3

    # Atomic write
    output.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = output.with_name(output.name + ".tmp")
    try:
        tmp_path.write_bytes(img_data)
        tmp_path.rename(output)
    except OSError as exc:
        print(f"ERROR: failed to write output: {exc}", file=sys.stderr)
        return 3

    # Diagnostics to stderr
    dims = image_dimensions(img_data)
    if dims:
        print(f"dimensions: {dims[0]}x{dims[1]}", file=sys.stderr)
    print(f"file size: {len(img_data):,} bytes", file=sys.stderr)
    print(f"elapsed: {elapsed:.1f}s", file=sys.stderr)

    if usage:
        print(f"token usage: {json.dumps(usage)}", file=sys.stderr)

    print(f"saved: {output}", file=sys.stderr)

    # Metadata sidecar
    if args.metadata:
        write_metadata(
            Path(args.metadata).resolve(),
            model=args.model,
            prompt=args.prompt,
            output=str(output),
            fmt=args.fmt,
            size=args.size,
            quality=args.quality,
            width=dims[0] if dims else None,
            height=dims[1] if dims else None,
            elapsed=elapsed,
            cost=cost,
            usage=usage,
        )

    # Contract: exactly one line on stdout
    print(f"MEDIA: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
