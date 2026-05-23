import { describe, expect, it } from "vitest";
import { SLASH_COMMANDS } from "../src/cli/ui/slash/commands.js";
import { EN } from "../src/i18n/EN.ts";
import { zhCN } from "../src/i18n/zh-CN.ts";

describe("slash help i18n coverage", () => {
  it("every registered slash command has an EN description key", () => {
    const missing = SLASH_COMMANDS.filter((c) => !EN.slash[c.cmd]?.description);
    expect(missing.map((c) => c.cmd)).toEqual([]);
  });

  it("every registered slash command has a zh-CN description key", () => {
    const missing = SLASH_COMMANDS.filter((c) => !zhCN.slash[c.cmd]?.description);
    expect(missing.map((c) => c.cmd)).toEqual([]);
  });

  it("documents the macOS Ctrl-not-Cmd modifier note in both locales", () => {
    const enKeyboard = EN.ui.keysReference.sections.find((section) => section.title === "keyboard");
    const zhKeyboard = zhCN.ui.keysReference.sections.find((section) => section.title === "键盘");
    expect(EN.ui.macOSModifierHint).toContain("Ctrl");
    expect(zhCN.ui.macOSModifierHint).toContain("Ctrl");
    expect(enKeyboard?.rows[0]).toMatchObject({ key: "macOS" });
    expect(zhKeyboard?.rows[0]).toMatchObject({ key: "macOS" });
    expect(enKeyboard?.rows[0]?.text).toContain("Cmd");
    expect(zhKeyboard?.rows[0]?.text).toContain("Cmd");
  });
});
