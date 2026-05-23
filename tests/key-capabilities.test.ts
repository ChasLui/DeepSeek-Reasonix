import { describe, expect, it } from "vitest";
import { detectKeyCapabilities } from "../src/cli/ui/key-capabilities.js";

describe("detectKeyCapabilities", () => {
  it("classifies Apple Terminal on macOS as Ctrl-only by default", () => {
    expect(
      detectKeyCapabilities({
        platform: "darwin",
        env: { TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" },
      }),
    ).toMatchObject({
      isMacOS: true,
      terminalFamily: "apple-terminal",
      optionIsMeta: "unknown",
      extendedKeys: "no",
      superIsReachable: "no",
    });
  });

  it("treats iTerm2 Cmd reporting as configurable rather than default", () => {
    expect(
      detectKeyCapabilities({
        platform: "darwin",
        env: { TERM_PROGRAM: "iTerm.app", TERM: "xterm-256color" },
      }),
    ).toMatchObject({
      terminalFamily: "iterm2",
      optionIsMeta: "unknown",
      extendedKeys: "maybe",
      superIsReachable: "maybe",
    });
  });

  it("keeps Warp conservative for Super while accepting Option-as-Meta", () => {
    expect(
      detectKeyCapabilities({
        platform: "darwin",
        env: { TERM_PROGRAM: "WarpTerminal", TERM: "xterm-256color" },
      }),
    ).toMatchObject({
      terminalFamily: "warp",
      optionIsMeta: "yes",
      extendedKeys: "maybe",
      superIsReachable: "no",
    });
  });

  it("recognizes Kitty protocol-capable terminals", () => {
    expect(
      detectKeyCapabilities({
        platform: "linux",
        env: { TERM: "xterm-kitty" },
      }),
    ).toMatchObject({
      isMacOS: false,
      terminalFamily: "kitty",
      optionIsMeta: "yes",
      extendedKeys: "yes",
      superIsReachable: "maybe",
    });
  });

  it("keeps Windows Terminal separate from legacy conhost", () => {
    expect(
      detectKeyCapabilities({
        platform: "win32",
        env: { WT_SESSION: "abc", TERM_PROGRAM: "" },
      }),
    ).toMatchObject({
      isWindows: true,
      terminalFamily: "windows-terminal",
      extendedKeys: "maybe",
      superIsReachable: "no",
    });

    expect(detectKeyCapabilities({ platform: "win32", env: {} })).toMatchObject({
      terminalFamily: "legacy-windows",
      extendedKeys: "no",
    });
  });

  it("marks extended-key support uncertain under tmux", () => {
    expect(
      detectKeyCapabilities({
        platform: "linux",
        env: { TERM: "xterm-kitty", TMUX: "/tmp/tmux-501/default,1,0" },
      }),
    ).toMatchObject({
      terminalFamily: "kitty",
      multiplexer: "tmux",
      extendedKeys: "maybe",
      superIsReachable: "maybe",
    });
  });
});
