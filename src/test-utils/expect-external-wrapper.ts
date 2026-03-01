import { expect } from "vitest";

export function expectExternalWrapper(params: {
  output: unknown;
  source: string;
  payload: string;
}) {
  expect(typeof params.output).toBe("string");
  const text = typeof params.output === "string" ? params.output : "";

  expect(text).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT");
  expect(text).toContain("<<<END_EXTERNAL_UNTRUSTED_CONTENT");
  expect(text).toContain(`Source: ${params.source}`);
  expect(text).toContain(params.payload);
}
