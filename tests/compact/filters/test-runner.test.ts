import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testRunnerCompactors } from "../../../src/compact/filters/test-runner.js";
import {
  applyCompactor,
  registerCompactor,
  resetCompactors,
} from "../../../src/compact/registry.js";

beforeEach(() => {
  resetCompactors();
  for (const c of testRunnerCompactors) registerCompactor(c);
});
afterEach(() => {
  resetCompactors();
});

describe("vitest filter", () => {
  it("returns one-line ok summary when all pass", () => {
    const out = [
      " RUN  v2.1.9",
      " ✓ a.test.ts (3 tests) 5ms",
      "",
      "Test Files  1 passed (1)",
      "      Tests  3 passed (3)",
    ].join("\n");
    const r = applyCompactor("npx vitest run", out, {
      exitCode: 0,
      timedOut: false,
    });
    expect(r.filter).toBe("vitest");
    expect(r.compact).toMatch(/vitest ok/);
    expect(r.compact).not.toContain("a.test.ts");
  });

  it("extracts FAIL blocks and hides passes", () => {
    const out = [
      " RUN  v2.1.9",
      " ✓ a.test.ts > should pass",
      " FAIL  b.test.ts > should fail",
      "AssertionError: expected 1 to be 2",
      " ❯ b.test.ts:5:20",
      "",
      " FAIL  c.test.ts > breaks here",
      "TypeError: cannot read prop",
      " ❯ c.test.ts:9",
      "",
      "Test Files  2 failed | 1 passed (3)",
      "      Tests  2 failed | 18 passed (20)",
    ].join("\n");
    const r = applyCompactor("npx vitest", out, {
      exitCode: 1,
      timedOut: false,
    });
    expect(r.filter).toBe("vitest");
    expect(r.compact).toMatch(/FAILED — 2 failures/);
    expect(r.compact).toContain("b.test.ts");
    expect(r.compact).toContain("c.test.ts");
    expect(r.compact).toContain("AssertionError");
    expect(r.compact).not.toMatch(/should pass/);
  });
});

describe("jest filter", () => {
  it("ok summary all pass", () => {
    const out = [
      "PASS  a.test.js",
      "",
      "Test Suites: 1 passed, 1 total",
      "Tests:       3 passed, 3 total",
    ].join("\n");
    const r = applyCompactor("npx jest", out, { exitCode: 0, timedOut: false });
    expect(r.filter).toBe("jest");
    expect(r.compact).toMatch(/jest ok/);
  });

  it("extracts ● failure blocks", () => {
    const out = [
      "FAIL b.test.js",
      "  ● test > breaks",
      "    Expected 1 to equal 2",
      "      at Object.<anonymous> (b.test.js:7:11)",
      "",
      "Tests:       1 failed, 5 passed, 6 total",
    ].join("\n");
    const r = applyCompactor("npx jest", out, { exitCode: 1, timedOut: false });
    expect(r.compact).toMatch(/FAILED — 1 failure/);
    expect(r.compact).toContain("breaks");
    expect(r.compact).toContain("Expected 1 to equal 2");
  });
});

describe("pytest filter", () => {
  it("ok summary on green run", () => {
    const out = [
      "test_a.py ..",
      "",
      "============================ 5 passed in 1.23s =============================",
    ].join("\n");
    const r = applyCompactor("pytest", out, { exitCode: 0, timedOut: false });
    expect(r.filter).toBe("pytest");
    expect(r.compact).toMatch(/pytest ok/);
  });

  it("extracts failure block + drops passing tests", () => {
    const out = [
      "============================= test session starts =============================",
      "test_a.py .F",
      "",
      "================================== FAILURES ===================================",
      "_______________________________ test_subtract ________________________________",
      "",
      "    def test_subtract():",
      ">       assert subtract(2, 1) == 0",
      "E       assert 1 == 0",
      "",
      "test_a.py:14: AssertionError",
      "========================= 1 failed, 1 passed in 0.05s =========================",
    ].join("\n");
    const r = applyCompactor("pytest", out, { exitCode: 1, timedOut: false });
    expect(r.filter).toBe("pytest");
    expect(r.compact).toMatch(/FAILED/);
    expect(r.compact).toContain("test_subtract");
    expect(r.compact).toContain("AssertionError");
  });
});

describe("cargo test filter", () => {
  it("ok summary all pass", () => {
    const out = [
      "running 5 tests",
      "test foo ... ok",
      "",
      "test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out",
    ].join("\n");
    const r = applyCompactor("cargo test", out, {
      exitCode: 0,
      timedOut: false,
    });
    expect(r.filter).toBe("cargo-test");
    expect(r.compact).toMatch(/cargo test ok/);
  });

  it("extracts stdout block per failure", () => {
    const out = [
      "running 3 tests",
      "test bar ... ok",
      "test baz ... FAILED",
      "",
      "failures:",
      "",
      "---- baz stdout ----",
      "thread 'baz' panicked at 'assertion failed'",
      "  ",
      "",
      "test result: FAILED. 1 passed; 1 failed; 0 ignored",
    ].join("\n");
    const r = applyCompactor("cargo test", out, {
      exitCode: 1,
      timedOut: false,
    });
    expect(r.filter).toBe("cargo-test");
    expect(r.compact).toMatch(/FAILED/);
    expect(r.compact).toContain("baz");
    expect(r.compact).toContain("panicked");
  });
});

describe("go test filter", () => {
  it("ok summary", () => {
    const out = ["ok  example.com/foo  0.123s"].join("\n");
    const r = applyCompactor("go test ./...", out, {
      exitCode: 0,
      timedOut: false,
    });
    expect(r.filter).toBe("go-test");
    expect(r.compact).toMatch(/go test ok/);
  });

  it("extracts FAIL blocks", () => {
    const out = [
      "=== RUN   TestA",
      "--- FAIL: TestA (0.00s)",
      "    a_test.go:5: oops",
      "FAIL",
      "FAIL    example.com/foo  0.001s",
    ].join("\n");
    const r = applyCompactor("go test ./...", out, {
      exitCode: 1,
      timedOut: false,
    });
    expect(r.filter).toBe("go-test");
    expect(r.compact).toMatch(/FAILED/);
    expect(r.compact).toContain("TestA");
    expect(r.compact).toContain("oops");
  });
});

describe("abstention", () => {
  it("vitest with no summary returns null → passthrough", () => {
    const out = "RUN v2.1.9\nlots of unrelated output";
    const r = applyCompactor("npx vitest", out, {
      exitCode: 1,
      timedOut: false,
    });
    expect(r.filter).toBe("passthrough");
  });

  it("non-zero exit with no FAIL markers → passthrough so model can debug", () => {
    const out = "Test Files  1 passed (1)\nbut config exploded somehow";
    const r = applyCompactor("npx vitest", out, {
      exitCode: 2,
      timedOut: false,
    });
    expect(r.filter).toBe("passthrough");
  });
});
