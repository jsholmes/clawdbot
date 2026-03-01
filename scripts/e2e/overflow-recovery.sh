#!/usr/bin/env bash
# scripts/e2e/overflow-recovery.sh
#
# E2E smoke test for the overflow-recovery module.
# Exercises the pure TypeScript functions with a synthetic transcript and
# verifies the key acceptance criteria without requiring a live API.
#
# Exit 0 on pass, exit 1 on failure.
# Prints: pre-overflow context size, chars after preprocessing, summary size.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

echo "=== overflow-recovery e2e smoke test ==="
echo "Repo root: ${REPO_ROOT}"

TSX_BIN="${REPO_ROOT}/node_modules/.bin/tsx"
if [[ ! -f "${TSX_BIN}" ]]; then
  echo "ERROR: tsx not found at ${TSX_BIN}. Run pnpm install first."
  exit 1
fi

# Write the smoke test INSIDE the repo root so relative imports resolve correctly.
TMPFILE="${REPO_ROOT}/.overflow-recovery-e2e-$$.mts"
trap 'rm -f "${TMPFILE}"' EXIT

cat > "${TMPFILE}" << 'NODE_EOF'
import {
  shouldAttemptOverflowRecovery,
  performOverflowRecovery,
  preprocessTranscript,
  preTruncateTranscript,
  redactSecrets,
  buildSummarisationPrompt,
  DEFAULT_OVERFLOW_RECOVERY_CONFIG,
  type TranscriptMessage,
} from "./src/agents/pi-embedded-runner/overflow-recovery.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

// -----------------------------------------------------------------------
// Build a synthetic "huge" transcript that would overflow a small context.
// -----------------------------------------------------------------------
const sessionKey = "e2e-test-session-key-unchanged";
const diagId = "e2e-diag-001";

const messages: TranscriptMessage[] = [
  { role: "system", content: "You are Prue, a helpful assistant." },
  { role: "user", content: "Can you investigate the test failure?" },
  { role: "assistant", content: "Sure, running tests now." },
  { role: "tool", toolName: "exec", content: "x".repeat(50_000), metadata: { exit: 0 } },
  { role: "assistant", content: "Tests ran. Now checking logs." },
  { role: "tool", toolName: "read", content: "z".repeat(40_000), metadata: { path: "/tmp/test.log" } },
  ...Array.from({ length: 12 }, (_, i) => [
    { role: "user" as const, content: `Turn ${i}: what about issue ${i}?` },
    { role: "assistant" as const, content: `Turn ${i}: addressed it.` },
  ]).flat(),
  { role: "user", content: "This is the FINAL message that triggered overflow." },
  { role: "tool", toolName: "exec", content: "a".repeat(30_000), metadata: { outputFile: "/tmp/artifact-e2e.json", exit: 0 } },
];

const preContextChars = messages.reduce((s, m) => s + m.content.length, 0);
console.log(`\nPre-overflow context chars: ${preContextChars}`);

// -----------------------------------------------------------------------
// AC #3: Tool result preprocessing
// -----------------------------------------------------------------------
console.log("\n--- AC #3: Tool result pre-processing ---");
const preprocessed = preprocessTranscript(messages);
const charsAfterPreprocess = preprocessed.reduce((s, m) => s + m.content.length, 0);
console.log(`Chars after preprocessing: ${charsAfterPreprocess}`);

assert(charsAfterPreprocess < preContextChars, "preprocessing reduces total chars");

const toolMsgs = preprocessed.filter(m => m.role === "tool");
for (const tm of toolMsgs) {
  assert(
    tm.content.length < 200 || !tm.content.includes("x".repeat(50)),
    `tool result for "${tm.toolName}" is compact placeholder`,
  );
}

// Verify outputFile preserved
const execWithArtifact = preprocessed.find(
  m => m.role === "tool" && m.metadata?.outputFile === "/tmp/artifact-e2e.json"
);
assert(
  execWithArtifact !== undefined && execWithArtifact.content.includes("outputFile=/tmp/artifact-e2e.json"),
  "outputFile path preserved in placeholder",
);

// -----------------------------------------------------------------------
// AC #4: Pre-truncation
// -----------------------------------------------------------------------
console.log("\n--- AC #4: Input pre-truncation ---");
const maxInputChars = 200; // tiny limit to force truncation (after preprocessing they are ~877 chars; need even smaller)
const truncated = preTruncateTranscript(preprocessed, maxInputChars, 5);
const hasOmissionMarker = truncated.some(m => m.content.includes("turns omitted"));
assert(hasOmissionMarker, "omission marker inserted when transcript exceeds maxInputChars");
assert(truncated[0].role === "system", "system prompt preserved at index 0");
assert(
  truncated.some(m => m.content.includes("artifact-e2e") || m.content.includes("FINAL")),
  "last turns preserved (artifact or final user message visible)",
);

// -----------------------------------------------------------------------
// AC #5: Summarisation prompt structure
// -----------------------------------------------------------------------
console.log("\n--- AC #5: Summarisation prompt structure ---");
const config = { ...DEFAULT_OVERFLOW_RECOVERY_CONFIG, enabled: true, maxInputChars: 10_000, keepLastTurns: 5 };
const prompt = buildSummarisationPrompt({ messages, config, sessionKey, diagId });

assert(prompt.includes("DECISIONS"), "prompt includes DECISIONS section");
assert(prompt.includes("ACTIVE_THREADS"), "prompt includes ACTIVE_THREADS section");
assert(prompt.includes("IMPORTANT_CONSTANTS"), "prompt includes IMPORTANT_CONSTANTS section");
assert(prompt.includes("LAST_EXCHANGES"), "prompt includes LAST_EXCHANGES section");
assert(prompt.includes("ARTIFACT_POINTERS"), "prompt includes ARTIFACT_POINTERS section");
assert(prompt.includes("SESSION_STATE"), "prompt includes SESSION_STATE section");
assert(/treat.*data/i.test(prompt), "prompt instructs summariser to treat content as DATA");

// -----------------------------------------------------------------------
// AC #1: Gating logic
// -----------------------------------------------------------------------
console.log("\n--- AC #1: Gating logic ---");

assert(
  !shouldAttemptOverflowRecovery({ ...config, enabled: false }, {
    normalCompactionAttempted: true, toolResultTruncationAttempted: true, stillOverflow: true,
  }),
  "recovery NOT triggered when disabled",
);
assert(
  !shouldAttemptOverflowRecovery(config, {
    normalCompactionAttempted: false, toolResultTruncationAttempted: true, stillOverflow: true,
  }),
  "recovery NOT triggered when normal compaction not attempted",
);
assert(
  !shouldAttemptOverflowRecovery(config, {
    normalCompactionAttempted: true, toolResultTruncationAttempted: false, stillOverflow: true,
  }),
  "recovery NOT triggered when tool-result truncation not attempted",
);
assert(
  !shouldAttemptOverflowRecovery(config, {
    normalCompactionAttempted: true, toolResultTruncationAttempted: true, stillOverflow: false,
  }),
  "recovery NOT triggered when no longer overflow",
);
assert(
  shouldAttemptOverflowRecovery(config, {
    normalCompactionAttempted: true, toolResultTruncationAttempted: true, stillOverflow: true,
  }),
  "recovery triggered when all conditions met",
);

// -----------------------------------------------------------------------
// AC #9: Secret redaction
// -----------------------------------------------------------------------
console.log("\n--- AC #9: Secret redaction ---");
const secretTests: [string, string][] = [
  ["sk- key", "sk-abc123def456ghi789jkl"],
  ["ghp_ token", "ghp_abcdefghijklmnopqrstu"],
  ["xoxb- token", "xoxb-123-456-abcdefghijk"],
  ["Bearer token", "Bearer EXAMPLE_BEARER_TOKEN_xyz"],
  ["op:// ref", "op://Prudent Things/key/cred"],
  ["JWT eyJ", "EXAMPLE_JWT_TOKEN.test"],
  ["env var", "API_KEY=supersecretvalue123"],
  ["--password", "--password mypassword123"],
  ["--token", "--token mytoken12345678"],
];
for (const [label, secret] of secretTests) {
  const redacted = redactSecrets(`context: ${secret} end`);
  assert(!redacted.includes(secret), `redacts ${label}`);
}
assert(redactSecrets("bead workspace-runa is active").includes("workspace-runa"), "preserves bead IDs");
assert(redactSecrets("/Users/prue/.openclaw/workspace/MEMORY.md").includes("MEMORY.md"), "preserves file paths");

// -----------------------------------------------------------------------
// AC #6: Recovery failure falls back gracefully
// -----------------------------------------------------------------------
console.log("\n--- AC #6: Recovery failure fallback ---");
const failResult = await performOverflowRecovery(
  { messages, config, sessionKey, diagId },
  async () => { throw new Error("simulated network timeout"); },
);
assert(!failResult.success, "result.success is false on model failure");
assert(failResult.error?.message.includes("simulated network timeout"), "error message propagated");
assert(failResult.summaryBlock === undefined, "no summaryBlock on failure");

// -----------------------------------------------------------------------
// Success path with mock model
// -----------------------------------------------------------------------
console.log("\n--- Success path: mock model ---");
const successResult = await performOverflowRecovery(
  { messages, config, sessionKey, diagId },
  async (_prompt, _model, _timeoutMs) => {
    return "DECISIONS: finished tests\nACTIVE_THREADS: workspace-runa\nARTIFACT_POINTERS: /tmp/artifact-e2e.json\nLAST_EXCHANGES: ...\nSESSION_STATE: tests done";
  },
);
assert(successResult.success, "recovery succeeds with mock model");
assert(successResult.diagId === diagId, "diagId preserved in result");
assert(typeof successResult.summaryChars === "number", "summaryChars reported");
console.log(`Summary chars: ${successResult.summaryChars}`);
console.log(`Duration: ${successResult.durationMs}ms`);

// -----------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
}
NODE_EOF

echo ""
echo "Running e2e smoke test via tsx..."
cd "${REPO_ROOT}"
"${TSX_BIN}" "${TMPFILE}"
EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]]; then
  echo ""
  echo "✅ overflow-recovery e2e smoke test PASSED"
else
  echo ""
  echo "❌ overflow-recovery e2e smoke test FAILED (exit ${EXIT_CODE})"
fi

exit $EXIT_CODE
