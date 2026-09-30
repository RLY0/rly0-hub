import { describe, expect, it } from "vitest";

import {
  sanitizeDiagnosticsText,
  sanitizeDiagnosticsValue,
} from "../../src/rly0-maintenance/sanitize.js";

describe("sanitizeDiagnosticsText", () => {
  it("redacts email addresses", () => {
    expect(sanitizeDiagnosticsText("contact admin@example.com for help", undefined)).toBe(
      "contact <email> for help",
    );
  });

  it("redacts Bearer tokens", () => {
    expect(sanitizeDiagnosticsText("Authorization: Bearer abc123.def-456", undefined)).toBe(
      "Authorization: Bearer <redacted>",
    );
  });

  it("redacts sk- prefixed keys", () => {
    expect(sanitizeDiagnosticsText("key sk-abcdefghijklmnop in use", undefined)).toBe(
      "key sk-<redacted> in use",
    );
  });

  it("redacts labeled secrets while keeping the label", () => {
    expect(sanitizeDiagnosticsText('token: "abcdef123456"', undefined)).toBe('token: "<redacted>"');
    expect(sanitizeDiagnosticsText("api_key=abcdef123456", undefined)).toBe("api_key=<redacted>");
  });

  it("replaces every occurrence of the home directory with a placeholder", () => {
    expect(
      sanitizeDiagnosticsText(
        "C:\\Users\\alice\\.codex and C:\\Users\\alice\\logs",
        "C:\\Users\\alice",
      ),
    ).toBe("<home>\\.codex and <home>\\logs");
  });

  it("leaves unrelated text untouched", () => {
    expect(sanitizeDiagnosticsText("codexHomeExists: true", "/home/alice")).toBe(
      "codexHomeExists: true",
    );
  });
});

describe("sanitizeDiagnosticsValue", () => {
  it("recursively sanitizes strings inside nested objects and arrays", () => {
    const input = {
      note: "email me at bob@example.com",
      nested: { headers: ["Bearer secrettoken1"] },
      count: 3,
      ok: true,
    };
    const output = sanitizeDiagnosticsValue(input, undefined) as typeof input;
    expect(output.note).toBe("email me at <email>");
    expect(output.nested.headers[0]).toBe("Bearer <redacted>");
    expect(output.count).toBe(3);
    expect(output.ok).toBe(true);
  });
});
