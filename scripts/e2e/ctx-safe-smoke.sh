#!/usr/bin/env bash
set -uo pipefail

fail=0

printf 'node: %s\n' "$(node -v)"
printf 'pnpm: %s\n' "$(pnpm -v)"
printf 'vitest: %s\n' "$(pnpm vitest --version | head -n1)"
printf 'git branch: %s\n' "$(git rev-parse --abbrev-ref HEAD)"
printf 'git sha: %s\n' "$(git rev-parse --short HEAD)"

echo "[ctx-safe-smoke] running pnpm test:fast"
if pnpm test:fast; then
  echo "[ctx-safe-smoke] pnpm test:fast: PASS"
else
  echo "[ctx-safe-smoke] pnpm test:fast: FAIL"
  fail=1
fi

echo "[ctx-safe-smoke] verifying external-content wrapper roundtrip"
if pnpm tsx --eval '
import assert from "node:assert/strict";
import { wrapExternalContent } from "./src/security/external-content.ts";

const payload = "ctx-safe smoke payload";
const wrapped = wrapExternalContent(payload, { source: "web_fetch", includeWarning: false });
const start = wrapped.match(/<<<EXTERNAL_UNTRUSTED_CONTENT id="([a-f0-9]{16})">>>/);
const end = wrapped.match(/<<<END_EXTERNAL_UNTRUSTED_CONTENT id="([a-f0-9]{16})">>>/);
assert.ok(start, "missing start marker");
assert.ok(end, "missing end marker");
assert.equal(start?.[1], end?.[1], "wrapper marker ids must match");
assert.ok(wrapped.includes("Source: Web Fetch"), "missing source label");
const body = wrapped.split("\n---\n")[1]?.split(`\n${end?.[0] ?? ""}`)[0];
assert.equal(body, payload, "payload roundtrip mismatch");
console.log("[ctx-safe-smoke] wrapper roundtrip: PASS");
'; then
  :
else
  echo "[ctx-safe-smoke] wrapper roundtrip: FAIL"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "[ctx-safe-smoke] overall: PASS"
  exit 0
fi

echo "[ctx-safe-smoke] overall: FAIL"
exit 1
