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

  it("redacts GitHub classic PATs", () => {
    const token = `ghp_${"A".repeat(36)}`;

    expect(defaultRedactor(`token ${token}`)).toBe("token [REDACTED]");
  });

  it("redacts GitHub fine-grained PATs", () => {
    const token = `github_pat_${"A".repeat(82)}`;

    expect(defaultRedactor(`token ${token}`)).toBe("token [REDACTED]");
  });

  it("redacts GitLab PATs", () => {
    const token = `glpat-${"A".repeat(20)}`;

    expect(defaultRedactor(`token ${token}`)).toBe("token [REDACTED]");
  });

  it("redacts AWS access key ids", () => {
    expect(defaultRedactor("aws AKIAABCDEFGHIJKLMNOP")).toBe("aws [REDACTED]");
  });

  it("redacts Stripe live keys", () => {
    const token = `sk_live_${"A".repeat(24)}`;

    expect(defaultRedactor(`stripe ${token}`)).toBe("stripe [REDACTED]");
  });

  it("redacts Slack tokens", () => {
    expect(defaultRedactor("slack xoxb-1234567890-ABCDEFGHIJ")).toBe("slack [REDACTED]");
  });

  it("redacts standalone JWTs", () => {
    const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature";

    expect(defaultRedactor(`jwt ${token}`)).toBe("jwt [REDACTED]");
  });

  it("is idempotent", () => {
    const input =
      "https://u:p@example.com Bearer eyJhbGciOiJIUzI1NiJ9.token OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz github_pat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const once = defaultRedactor(input);

    expect(defaultRedactor(once)).toBe(once);
  });

  it("does not redact short or unrelated tokens", () => {
    expect(defaultRedactor("bearer-token sk-12 ghp_short AKIAabcdefghijklmnop eyJnot.a.jwt")).toBe(
      "bearer-token sk-12 ghp_short AKIAabcdefghijklmnop eyJnot.a.jwt",
    );
  });

  it("does not redact normal markdown links", () => {
    expect(defaultRedactor("[link](https://x.com/path?q=1)")).toBe(
      "[link](https://x.com/path?q=1)",
    );
  });
});
