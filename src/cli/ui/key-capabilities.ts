export type TerminalFamily =
  | "apple-terminal"
  | "iterm2"
  | "warp"
  | "kitty"
  | "wezterm"
  | "ghostty"
  | "alacritty"
  | "vscode"
  | "windows-terminal"
  | "legacy-windows"
  | "unknown";

export type StaticKeyCapability = "yes" | "no" | "maybe" | "unknown";

export interface KeyCapabilities {
  platform: NodeJS.Platform;
  isMacOS: boolean;
  isWindows: boolean;
  terminalFamily: TerminalFamily;
  multiplexer: "tmux" | "screen" | null;
  optionIsMeta: StaticKeyCapability;
  extendedKeys: StaticKeyCapability;
  superIsReachable: StaticKeyCapability;
}

export interface KeyCapabilityInput {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export function detectKeyCapabilities(input: KeyCapabilityInput = {}): KeyCapabilities {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const isMacOS = platform === "darwin";
  const isWindows = platform === "win32";
  const terminalFamily = detectTerminalFamily(env, isWindows);
  const multiplexer = env.TMUX ? "tmux" : env.STY ? "screen" : null;
  const extendedKeys = withMultiplexerCaution(detectExtendedKeys(terminalFamily), multiplexer);
  return {
    platform,
    isMacOS,
    isWindows,
    terminalFamily,
    multiplexer,
    optionIsMeta: detectOptionIsMeta(terminalFamily, isMacOS),
    extendedKeys,
    superIsReachable: withMultiplexerCaution(detectSuperReachability(terminalFamily), multiplexer),
  };
}

function detectTerminalFamily(env: NodeJS.ProcessEnv, isWindows: boolean): TerminalFamily {
  const termProgram = (env.TERM_PROGRAM ?? "").toLowerCase();
  if (isWindows && env.WT_SESSION) return "windows-terminal";
  if (isWindows && !env.TERM_PROGRAM) return "legacy-windows";
  if (termProgram === "apple_terminal") return "apple-terminal";
  if (termProgram === "iterm.app") return "iterm2";
  if (termProgram === "warpterminal") return "warp";
  if (termProgram === "wezterm") return "wezterm";
  if (termProgram === "ghostty") return "ghostty";
  if (termProgram === "vscode") return "vscode";

  const term = (env.TERM ?? "").toLowerCase();
  if (term.includes("kitty")) return "kitty";
  if (term.includes("wezterm")) return "wezterm";
  if (term.includes("ghostty")) return "ghostty";
  if (term.includes("alacritty")) return "alacritty";
  return "unknown";
}

function detectOptionIsMeta(terminalFamily: TerminalFamily, isMacOS: boolean): StaticKeyCapability {
  if (!isMacOS) return "yes";
  switch (terminalFamily) {
    case "kitty":
    case "wezterm":
    case "ghostty":
    case "alacritty":
    case "warp":
      return "yes";
    case "apple-terminal":
    case "iterm2":
      return "unknown";
    case "windows-terminal":
    case "legacy-windows":
      return "no";
    default:
      return "unknown";
  }
}

function detectExtendedKeys(terminalFamily: TerminalFamily): StaticKeyCapability {
  switch (terminalFamily) {
    case "kitty":
    case "wezterm":
    case "ghostty":
    case "alacritty":
      return "yes";
    case "iterm2":
    case "warp":
    case "windows-terminal":
      return "maybe";
    case "apple-terminal":
    case "legacy-windows":
      return "no";
    default:
      return "unknown";
  }
}

function detectSuperReachability(terminalFamily: TerminalFamily): StaticKeyCapability {
  switch (terminalFamily) {
    case "kitty":
    case "wezterm":
    case "ghostty":
    case "alacritty":
    case "iterm2":
      return "maybe";
    case "apple-terminal":
    case "warp":
    case "vscode":
    case "windows-terminal":
    case "legacy-windows":
      return "no";
    default:
      return "unknown";
  }
}

function withMultiplexerCaution(
  capability: StaticKeyCapability,
  multiplexer: KeyCapabilities["multiplexer"],
): StaticKeyCapability {
  if (!multiplexer) return capability;
  if (capability === "no") return "no";
  return "maybe";
}
