/** Reproduces the streaming-card + ChoiceConfirm-style modal scenario the user
 *  reports flickers on. Loops continuously: streaming card grows for ~1.2s,
 *  modal pops up below, streaming continues for ~1.5s, modal stays for ~3s,
 *  everything tears down, sleep, repeat. Watch the live region — any visible
 *  blank rows / repaint flashes during the modal-mount transition is the bug.
 *
 *  Use --real-modal to mirror the actual chat flow more closely:
 *    - wrap the modal in ViewportBudgetProvider + useReserveRows
 *    - use the real ApprovalCard (with dynamic-width horizontal rule)
 *  Without the flag, the modal is hand-rolled — equivalent layout, no budget. */

// biome-ignore lint/style/useImportType: tsconfig jsx=react needs React in value scope for JSX compilation
import React, { useEffect, useState } from "react";
import {
  CharPool,
  type Handle,
  HyperlinkPool,
  StylePool,
  inkCompat,
  mount,
  useKeystroke,
} from "../../renderer/index.js";
import { ApprovalCard } from "../ui/cards/ApprovalCard.js";
import { ViewportBudgetProvider, useReserveRows } from "../ui/layout/viewport-budget.js";

const BRAND = "#79c0ff";
const FAINT = "#6e7681";
const ACCENT = "#d2a8ff";
const OK = "#7ee787";
const META = "#8b949e";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

interface FlickerShellProps {
  readonly onExit: () => void;
  readonly realModal: boolean;
}

function Header({ phase }: { phase: string }): React.ReactElement {
  return (
    <inkCompat.Box flexDirection="row" gap={1}>
      <inkCompat.Text color={BRAND} bold>
        ◈ Reasonix
      </inkCompat.Text>
      <inkCompat.Text color={FAINT}>flicker-demo · phase:</inkCompat.Text>
      <inkCompat.Text color={ACCENT} bold>
        {phase}
      </inkCompat.Text>
      <inkCompat.Text color={FAINT}>· Esc to exit</inkCompat.Text>
    </inkCompat.Box>
  );
}

function StreamingCard({
  text,
  done,
  frame,
}: {
  text: string;
  done: boolean;
  frame: number;
}): React.ReactElement {
  const lines = text.length > 0 ? text.split("\n") : [""];
  const visible = lines.slice(-4);
  const glyph = done ? "‹" : "▸";
  const head = done ? "reply" : "writing…";
  const tone = done ? OK : BRAND;
  return (
    <inkCompat.Box flexDirection="column" marginTop={1}>
      <inkCompat.Box flexDirection="row" gap={1}>
        <inkCompat.Text color={tone}>{glyph}</inkCompat.Text>
        <inkCompat.Text color={tone} bold>
          {head}
        </inkCompat.Text>
        {!done ? (
          <inkCompat.Text color={tone}>{SPINNER[frame % SPINNER.length] ?? "·"}</inkCompat.Text>
        ) : null}
      </inkCompat.Box>
      {visible.map((line, i) => (
        <inkCompat.Box key={`s-${i}-${line.length}`} paddingLeft={2}>
          <inkCompat.Text>{line || " "}</inkCompat.Text>
        </inkCompat.Box>
      ))}
    </inkCompat.Box>
  );
}

const OPTIONS = [
  "1 · keep current approach",
  "2 · rewrite with the alternative",
  "3 · ask me a clarifying question first",
  "Let me type my own answer",
  "Cancel — drop the question",
] as const;

function ChoiceModalInline(): React.ReactElement {
  return (
    <inkCompat.Box flexDirection="column" marginTop={1}>
      <inkCompat.Box flexDirection="row" gap={1}>
        <inkCompat.Text color={ACCENT} bold>
          ?
        </inkCompat.Text>
        <inkCompat.Text color={ACCENT} bold>
          which path should I take?
        </inkCompat.Text>
        <inkCompat.Text color={FAINT}>· awaiting</inkCompat.Text>
      </inkCompat.Box>
      <inkCompat.Box flexDirection="column" paddingLeft={2}>
        {OPTIONS.map((opt, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static option list, never reordered
          <inkCompat.Box key={`o-${i}`} flexDirection="row" gap={1}>
            <inkCompat.Text color={i === 0 ? BRAND : META}>{i === 0 ? "▸" : " "}</inkCompat.Text>
            <inkCompat.Text color={i === 0 ? BRAND : META} bold={i === 0}>
              {opt}
            </inkCompat.Text>
          </inkCompat.Box>
        ))}
        <inkCompat.Box marginTop={1}>
          <inkCompat.Text color={FAINT}>{"─".repeat(40)}</inkCompat.Text>
        </inkCompat.Box>
        <inkCompat.Text color={FAINT}>↑↓ pick · ⏎ confirm · esc cancel</inkCompat.Text>
      </inkCompat.Box>
    </inkCompat.Box>
  );
}

/** Mirrors the real chat flow: wraps in ApprovalCard (dynamic rule width) +
 *  claims budget via useReserveRows. Lets us see whether the budget
 *  bookkeeping or the dynamic rule width is responsible for the flicker. */
function ChoiceModalReal(): React.ReactElement {
  useReserveRows("modal", { min: 6, max: 12 });
  return (
    <ApprovalCard tone="info" title="which path should I take?" metaRight="awaiting">
      {OPTIONS.map((opt, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static option list, never reordered
        <inkCompat.Box key={`r-${i}`} flexDirection="row" gap={1}>
          <inkCompat.Text color={i === 0 ? BRAND : META}>{i === 0 ? "▸" : " "}</inkCompat.Text>
          <inkCompat.Text color={i === 0 ? BRAND : META} bold={i === 0}>
            {opt}
          </inkCompat.Text>
        </inkCompat.Box>
      ))}
    </ApprovalCard>
  );
}

const STREAM_TEXT = `analyzing the failing test on src/loop.test.ts
  the assertion on line 42 expects the parser to drop the trailing tool-call marker
  but the new tokenizer keeps it; two paths forward — patch the tokenizer's strip
  step, or update the expectation. The trade-off is whether downstream consumers
  rely on the marker to detect partial tool-call output.`;

function FlickerShell({ onExit, realModal }: FlickerShellProps): React.ReactElement {
  const [streamText, setStreamText] = useState("");
  const [streamDone, setStreamDone] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [frame, setFrame] = useState(0);
  const [phase, setPhase] = useState("idle");

  useKeystroke((k) => {
    if (k.escape) onExit();
  });

  // Spinner ticker — runs while streaming.
  useEffect(() => {
    if (streamDone) return;
    const id = setInterval(() => setFrame((f) => f + 1), 80);
    return () => clearInterval(id);
  }, [streamDone]);

  // Main loop — endlessly cycles through the test scenario.
  useEffect(() => {
    let cancelled = false;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(() => resolve(), ms);
      });

    const cycle = async (): Promise<void> => {
      while (!cancelled) {
        // Reset
        setStreamText("");
        setStreamDone(false);
        setShowModal(false);
        setPhase("streaming");
        await sleep(400);
        if (cancelled) return;

        // Stream chunks for ~1.2s before the modal appears
        const chunks = STREAM_TEXT.split(" ");
        let revealed = "";
        for (let i = 0; i < chunks.length / 2; i++) {
          if (cancelled) return;
          revealed += `${chunks[i]} `;
          setStreamText(revealed);
          await sleep(80);
        }

        // Modal appears WHILE streaming continues — this is the flicker scenario.
        setPhase("streaming + modal");
        setShowModal(true);
        for (let i = Math.floor(chunks.length / 2); i < chunks.length; i++) {
          if (cancelled) return;
          revealed += `${chunks[i]} `;
          setStreamText(revealed);
          await sleep(80);
        }

        // Streaming finishes, modal stays
        setStreamDone(true);
        setPhase("done + modal");
        await sleep(2500);
        if (cancelled) return;

        // Tear down
        setShowModal(false);
        setPhase("idle");
        await sleep(800);
      }
    };

    void cycle();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <inkCompat.Box flexDirection="column">
      <Header phase={`${phase}${realModal ? " (real)" : ""}`} />
      {streamText.length > 0 ? (
        <StreamingCard text={streamText.trim()} done={streamDone} frame={frame} />
      ) : null}
      {showModal ? realModal ? <ChoiceModalReal /> : <ChoiceModalInline /> : null}
    </inkCompat.Box>
  );
}

export interface FlickerDemoOptions {
  readonly stdout?: NodeJS.WriteStream;
  readonly stdin?: NodeJS.ReadStream;
  /** When true, wraps the modal in the real ApprovalCard + useReserveRows
   *  budget claim — same primitives the live chat ChoiceConfirm uses. */
  readonly realModal?: boolean;
}

export async function runFlickerDemo(opts: FlickerDemoOptions = {}): Promise<void> {
  const stdout = opts.stdout ?? process.stdout;
  const stdin = opts.stdin ?? process.stdin;

  if (!stdin.isTTY || !stdout.isTTY) {
    process.stderr.write("flicker-demo requires an interactive TTY.\n");
    process.exit(1);
  }

  const pools = {
    char: new CharPool(),
    style: new StylePool(),
    hyperlink: new HyperlinkPool(),
  };

  let resolveExit: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const realModal = !!opts.realModal;
  const tree = realModal ? (
    <ViewportBudgetProvider>
      <FlickerShell onExit={() => resolveExit()} realModal={true} />
    </ViewportBudgetProvider>
  ) : (
    <FlickerShell onExit={() => resolveExit()} realModal={false} />
  );

  const handle: Handle = mount(tree, {
    viewportWidth: stdout.columns ?? 80,
    viewportHeight: stdout.rows ?? 24,
    pools,
    write: (bytes) => stdout.write(bytes),
    stdin,
    stdout,
    onExit: () => resolveExit(),
  });

  const onResize = () => handle.resize(stdout.columns ?? 80, stdout.rows ?? 24);
  stdout.on("resize", onResize);

  try {
    await exited;
  } finally {
    stdout.off("resize", onResize);
    handle.destroy();
    stdin.pause();
  }
}
