import { describe, expect, it } from "vitest";
import { defaultRedactor } from "../../src/observability/secret-redactor.js";

describe("defaultRedactor", () => {
  it("redacts URL credentials", () => {
    expect(defaultRedactor("open https://u:p@example.com/path")).toBe(
      "open https://[redacted]@example.com/path",
    );
  });

  it("redacts bearer tokens", () => {
    expect(defaultRedactor("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.token")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
  });

  it("redacts sk-prefixed provider keys", () => {
    expect(
      defaultRedactor("sk-ant-api-abcdefghijklmnopqrstuvwxyz sk-deepseek-abcdefghijklmnop"),
    ).toBe("sk-[REDACTED] sk-[REDACTED]");
  });

  it("redacts common env secret assignments", () => {
    const input =
      "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz GITHUB_TOKEN:ghp_123 DB_PASSWORD=pw";

    expect(defaultRedactor(input)).toBe(
      "OPENAI_API_KEY=[REDACTED] GITHUB_TOKEN=[REDACTED] DB_PASSWORD=[REDACTED]",
    );
  });

  it("is idempotent", () => {
    const input =
      "https://u:p@example.com Bearer eyJhbGciOiJIUzI1NiJ9.token OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz";
    const once = defaultRedactor(input);

    expect(defaultRedactor(once)).toBe(once);
  });

  it("does not redact short or unrelated tokens", () => {
    expect(defaultRedactor("bearer-token sk-12")).toBe("bearer-token sk-12");
  });
});
