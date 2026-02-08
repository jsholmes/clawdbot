#!/usr/bin/env python3
"""HY3 generate/edit helper.

Runs HY3 on spark-0116 over SSH (server bound to 127.0.0.1).
Prints MEDIA: <local_path> on success.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
from pathlib import Path


def _env(name: str, default: str) -> str:
    v = os.environ.get(name)
    return v if v else default


def _run(cmd: list[str], *, check: bool = True, capture: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        check=check,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
        text=True,
    )


def _ssh(host: str, key: str, remote_cmd: str, *, check: bool = True, capture: bool = False) -> subprocess.CompletedProcess:
    cmd = [
        "ssh",
        "-i",
        os.path.expanduser(key),
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=30",
        host,
        remote_cmd,
    ]
    return _run(cmd, check=check, capture=capture)


def _scp_to(host: str, key: str, local_path: Path, remote_path: str) -> None:
    cmd = [
        "scp",
        "-i",
        os.path.expanduser(key),
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=30",
        str(local_path),
        f"{host}:{remote_path}",
    ]
    _run(cmd)


def _scp_from(host: str, key: str, remote_path: str, local_path: Path) -> None:
    local_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "scp",
        "-i",
        os.path.expanduser(key),
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=30",
        f"{host}:{remote_path}",
        str(local_path),
    ]
    _run(cmd)


def _health(host: str, key: str, server_url: str) -> bool:
    r = _ssh(
        host,
        key,
        f"curl -s --max-time 2 {shlex.quote(server_url)}/health || true",
        check=False,
        capture=True,
    )
    return "\"ok\": true" in (r.stdout or "")


def _ensure_server(
    host: str,
    key: str,
    server_url: str,
    remote_app_dir: str,
    remote_venv: str,
    model_dir: str,
    remote_tmp: str,
    wait_seconds: int,
    poll_seconds: int,
) -> None:
    if _health(host, key, server_url):
        return

    # Start server (best-effort). This may take a long time to load shards.
    start_cmd = f"""
set -euo pipefail
pkill -f hy3_sdnq_server.py >/dev/null 2>&1 || true
cd {shlex.quote(remote_app_dir)}
source {shlex.quote(remote_venv)}/bin/activate
export SDNQ_USE_TORCH_COMPILE=0
export SDNQ_USE_TRITON_MM=0
export TORCHDYNAMO_DISABLE=1
export TORCHINDUCTOR_DISABLE=1
nohup python3 -u ./hy3_sdnq_server.py \
  --model-dir {shlex.quote(model_dir)} \
  --host 127.0.0.1 --port 7869 \
  --out-dir {shlex.quote(remote_tmp)} \
  > {shlex.quote(remote_tmp)}/hy3_sdnq_server.log 2>&1 &
echo $! > {shlex.quote(remote_tmp)}/hy3_sdnq_server.pid
""".strip()

    _ssh(host, key, f"bash -lc {shlex.quote(start_cmd)}", check=False)

    deadline = time.time() + wait_seconds
    while time.time() < deadline:
        if _health(host, key, server_url):
            return
        time.sleep(poll_seconds)

    raise SystemExit(
        f"HY3 server not healthy after {wait_seconds}s. Check remote log: {remote_tmp}/hy3_sdnq_server.log"
    )


def _call_generate(
    host: str,
    key: str,
    server_url: str,
    remote_tmp: str,
    prompt: str,
    image_path_remote: str | None,
    image_size: str,
    steps: int,
    seed: int | None,
    timeout_seconds: int,
    out_remote: str,
) -> None:
    payload = {
        "prompt": prompt,
        "steps": steps,
        "image_size": image_size,
        "out": out_remote,
    }
    if seed is not None:
        payload["seed"] = seed
    if image_path_remote is not None:
        payload["image_path"] = image_path_remote

    payload_local = Path("/tmp") / f"hy3_payload_{int(time.time())}.json"
    payload_local.write_text(json.dumps(payload), encoding="utf-8")
    payload_remote = f"{remote_tmp}/hy3_payload_{int(time.time())}.json"
    _scp_to(host, key, payload_local, payload_remote)

    # Execute curl remotely (server is bound to 127.0.0.1 on the Spark host)
    curl_cmd = (
        f"curl -s --max-time {int(timeout_seconds)} -X POST {shlex.quote(server_url)}/generate "
        f"-H 'Content-Type: application/json' --data-binary @{shlex.quote(payload_remote)}"
    )
    r = _ssh(host, key, f"bash -lc {shlex.quote(curl_cmd)}", capture=True, check=False)
    if r.returncode != 0:
        raise SystemExit(r.stderr or f"remote curl failed: rc={r.returncode}")
    # If server returns {ok:false}, surface it.
    try:
        j = json.loads((r.stdout or "{}").strip() or "{}")
    except Exception:
        j = {}
    if isinstance(j, dict) and not j.get("ok", False):
        raise SystemExit(f"HY3 error: {j}")


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--prompt", required=True)
    common.add_argument("--image-size", default="768x768")
    common.add_argument("--steps", type=int, default=6)
    common.add_argument("--seed", type=int, default=None)
    common.add_argument("--out", default=None, help="local output png path")
    common.add_argument("--timeout", type=int, default=3600)
    common.add_argument("--ensure-server", action="store_true")
    common.add_argument("--ensure-wait", type=int, default=7200)
    common.add_argument("--ensure-poll", type=int, default=30)

    sub.add_parser("generate", parents=[common])

    ap_edit = sub.add_parser("edit", parents=[common])
    ap_edit.add_argument("--image", required=True, help="local input image path")

    args = ap.parse_args()

    host = _env("HY3_SSH_HOST", "john@spark-0116.local")
    key = _env("HY3_SSH_KEY", "~/.ssh/id_ed25519_spark")
    server_url = _env("HY3_SERVER_URL", "http://127.0.0.1:7869")
    remote_tmp = _env("HY3_REMOTE_TMP", "/home/john/tmp")
    remote_app_dir = _env("HY3_REMOTE_APP_DIR", "/home/john/apps/HunyuanImage-3.0")
    remote_venv = _env("HY3_REMOTE_VENV", "/home/john/venvs/hy3")
    model_dir = _env("HY3_MODEL_DIR", "/home/john/models/HunyuanImage-3-Instruct-Distil-SDNQ-4bit")

    if args.ensure_server:
        _ensure_server(
            host,
            key,
            server_url,
            remote_app_dir,
            remote_venv,
            model_dir,
            remote_tmp,
            wait_seconds=args.ensure_wait,
            poll_seconds=args.ensure_poll,
        )

    ts = time.strftime("%Y%m%d-%H%M%S")
    out_local = Path(args.out) if args.out else Path("/tmp") / f"hy3-{args.cmd}-{ts}.png"

    image_remote = None
    if args.cmd == "edit":
        in_path = Path(args.image)
        if not in_path.exists():
            raise SystemExit(f"input image not found: {in_path}")
        image_remote = f"{remote_tmp}/hy3_input_{ts}{in_path.suffix.lower()}"
        _scp_to(host, key, in_path, image_remote)

    out_remote = f"{remote_tmp}/hy3_out_{args.cmd}_{ts}.png"

    _call_generate(
        host,
        key,
        server_url,
        remote_tmp,
        prompt=args.prompt,
        image_path_remote=image_remote,
        image_size=args.image_size,
        steps=args.steps,
        seed=args.seed,
        timeout_seconds=args.timeout,
        out_remote=out_remote,
    )

    _scp_from(host, key, out_remote, out_local)

    print(f"MEDIA: {out_local}")


if __name__ == "__main__":
    main()
