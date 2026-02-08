#!/usr/bin/env python3
"""Shared utilities for OpenAI image generation scripts.

Provides:
  - API key resolution (env → 1Password)
  - HTTP request wrapper with retry + error normalisation
  - Model capability map and validation
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

def resolve_api_key() -> str:
    """Return OpenAI API key from env or 1Password, or sys.exit(1)."""
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if key:
        return key

    vault = os.environ.get("OP_VAULT", "Private")
    print(f"OPENAI_API_KEY not set; trying 1Password (vault: {vault}) …", file=sys.stderr)
    try:
        result = subprocess.run(
            ["op", "read", f"op://{vault}/OpenAI API Key/credential"],
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

    print("ERROR: No OpenAI API key found. Set OPENAI_API_KEY or configure 1Password CLI (OP_VAULT to set vault).", file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------------------
# Model capability map
# ---------------------------------------------------------------------------

GPT_IMAGE_MODELS = {"gpt-image-1.5", "gpt-image-1", "gpt-image-1-mini"}

MODEL_CAPS: dict[str, dict] = {
    "gpt-image-1.5": {
        "sizes": ["1024x1024", "1024x1536", "1536x1024"],
        "qualities": ["low", "medium", "high"],
        "formats": ["png", "jpeg", "webp"],
        "backgrounds": ["transparent", "opaque", "auto"],
        "supports_style": False,
        "response_field": "b64_json",
    },
    "gpt-image-1": {
        "sizes": ["1024x1024", "1024x1536", "1536x1024"],
        "qualities": ["low", "medium", "high"],
        "formats": ["png", "jpeg", "webp"],
        "backgrounds": ["transparent", "opaque", "auto"],
        "supports_style": False,
        "response_field": "b64_json",
    },
    "gpt-image-1-mini": {
        "sizes": ["1024x1024", "1024x1536", "1536x1024"],
        "qualities": ["low", "medium", "high"],
        "formats": ["png", "jpeg", "webp"],
        "backgrounds": ["transparent", "opaque", "auto"],
        "supports_style": False,
        "response_field": "b64_json",
    },
    "dall-e-3": {
        "sizes": ["1024x1024", "1792x1024", "1024x1792"],
        "qualities": ["standard", "hd"],
        "formats": ["png"],
        "backgrounds": [],
        "supports_style": True,
        "styles": ["vivid", "natural"],
        "response_field": "b64_json",
    },
    "dall-e-2": {
        "sizes": ["256x256", "512x512", "1024x1024"],
        "qualities": ["standard"],
        "formats": ["png"],
        "backgrounds": [],
        "supports_style": False,
        "response_field": "b64_json",
        "deprecated": True,
    },
}

ALL_MODELS = list(MODEL_CAPS.keys())


def is_gpt_image(model: str) -> bool:
    return model in GPT_IMAGE_MODELS


def validate_params(
    model: str,
    size: str,
    quality: str,
    fmt: str,
    background: str,
    style: str,
) -> list[str]:
    """Validate parameter combo. Return list of error strings (empty = OK)."""
    caps = MODEL_CAPS.get(model)
    if caps is None:
        return [f"Unknown model: {model}"]

    errors: list[str] = []

    if size not in caps["sizes"]:
        errors.append(f"Size '{size}' not valid for {model}. Choose from: {', '.join(caps['sizes'])}")

    if quality not in caps["qualities"]:
        errors.append(f"Quality '{quality}' not valid for {model}. Choose from: {', '.join(caps['qualities'])}")

    if fmt and caps["formats"] and fmt not in caps["formats"]:
        errors.append(f"Format '{fmt}' not valid for {model}. Choose from: {', '.join(caps['formats'])}")

    if background and not caps["backgrounds"]:
        errors.append(f"--background is not supported for {model}")
    elif background and background not in caps["backgrounds"]:
        errors.append(f"Background '{background}' not valid for {model}. Choose from: {', '.join(caps['backgrounds'])}")

    if style and not caps.get("supports_style"):
        errors.append(f"--style is only supported for dall-e-3, not {model}")
    elif style and style not in caps.get("styles", []):
        errors.append(f"Style '{style}' not valid for dall-e-3. Choose from: {', '.join(caps.get('styles', []))}")

    return errors


# ---------------------------------------------------------------------------
# Cost estimation
# ---------------------------------------------------------------------------

# Approximate cost per image in USD (as of early 2026)
_COST_TABLE: dict[str, dict[str, float]] = {
    "gpt-image-1.5": {"low": 0.02, "medium": 0.07, "high": 0.19},
    "gpt-image-1": {"low": 0.011, "medium": 0.042, "high": 0.167},
    "gpt-image-1-mini": {"low": 0.007, "medium": 0.026, "high": 0.100},
    "dall-e-3": {"standard": 0.04, "hd": 0.08},
    "dall-e-2": {"standard": 0.02},
}


def estimate_cost(model: str, quality: str) -> float | None:
    """Return estimated cost in USD or None if unknown."""
    return _COST_TABLE.get(model, {}).get(quality)


# ---------------------------------------------------------------------------
# HTTP request with retry
# ---------------------------------------------------------------------------

_RETRYABLE_CODES = {429, 500, 502, 503, 504}


def api_request(
    api_key: str,
    payload: dict,
    *,
    timeout: int = 60,
    retries: int = 2,
    backoff: float = 2.0,
) -> dict:
    """POST to OpenAI images/generations with retries. Returns parsed JSON.

    Exits with code 2 on non-retryable or exhausted retries.
    """
    url = "https://api.openai.com/v1/images/generations"
    body = json.dumps(payload).encode()
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": "openai-image-gen-cli/1.0",
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
            raw = exc.read().decode("utf-8", errors="replace")
            print(f"  API HTTP {exc.code}: {raw[:300]}", file=sys.stderr)

            # Detect content-policy specifically
            if exc.code == 400:
                try:
                    err_body = json.loads(raw)
                    code = err_body.get("error", {}).get("code", "")
                    if code == "content_policy_violation":
                        print("ERROR: content policy violation", file=sys.stderr)
                        sys.exit(2)
                except (json.JSONDecodeError, KeyError):
                    pass

            if exc.code in _RETRYABLE_CODES:
                last_err = exc
                continue
            print(f"ERROR: OpenAI API returned {exc.code}", file=sys.stderr)
            sys.exit(2)
        except (urllib.error.URLError, OSError) as exc:
            print(f"  network error: {exc}", file=sys.stderr)
            last_err = exc

    print(f"ERROR: OpenAI API failed after {retries + 1} attempts: {last_err}", file=sys.stderr)
    sys.exit(2)


def api_edit_request(
    api_key: str,
    image_path: str,
    prompt: str,
    *,
    model: str = "gpt-image-1.5",
    size: str = "1024x1024",
    quality: str = "high",
    timeout: int = 90,
    retries: int = 2,
    backoff: float = 2.0,
) -> dict:
    """POST to OpenAI images/edits (multipart form) with retries.

    Returns parsed JSON. Exits with code 2 on failure.
    """
    import mimetypes
    url = "https://api.openai.com/v1/images/edits"

    img_data = open(image_path, "rb").read()
    content_type = mimetypes.guess_type(image_path)[0] or "image/jpeg"
    filename = image_path.rsplit("/", 1)[-1] if "/" in image_path else image_path

    # Build multipart form data
    boundary = "----OpenClaw_ImageEdit_Boundary"

    def _field(name: str, value: str) -> bytes:
        return (
            f"--{boundary}\r\n"
            f"Content-Disposition: form-data; name=\"{name}\"\r\n\r\n"
            f"{value}\r\n"
        ).encode()

    def _file_field(name: str, fname: str, data: bytes, ct: str) -> bytes:
        header = (
            f"--{boundary}\r\n"
            f"Content-Disposition: form-data; name=\"{name}\"; filename=\"{fname}\"\r\n"
            f"Content-Type: {ct}\r\n\r\n"
        ).encode()
        return header + data + b"\r\n"

    body = b""
    body += _file_field("image", filename, img_data, content_type)
    body += _field("model", model)
    body += _field("prompt", prompt)
    body += _field("size", size)
    body += _field("quality", quality)
    body += f"--{boundary}--\r\n".encode()

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "User-Agent": "openai-image-gen-cli/1.0",
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
            raw = exc.read().decode("utf-8", errors="replace")
            print(f"  API HTTP {exc.code}: {raw[:300]}", file=sys.stderr)

            if exc.code == 400:
                try:
                    err_body = json.loads(raw)
                    code = err_body.get("error", {}).get("code", "")
                    if code == "content_policy_violation":
                        print("ERROR: content policy violation", file=sys.stderr)
                        sys.exit(2)
                except (json.JSONDecodeError, KeyError):
                    pass

            if exc.code in _RETRYABLE_CODES:
                last_err = exc
                continue
            print(f"ERROR: OpenAI Edit API returned {exc.code}", file=sys.stderr)
            sys.exit(2)
        except (urllib.error.URLError, OSError) as exc:
            print(f"  network error: {exc}", file=sys.stderr)
            last_err = exc

    print(f"ERROR: OpenAI Edit API failed after {retries + 1} attempts: {last_err}", file=sys.stderr)
    sys.exit(2)
