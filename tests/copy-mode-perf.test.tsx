import { performance } from "node:perf_hooks";
import { Box } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CopyMode } from "../src/cli/ui/copy-mode/CopyMode.js";
import {
  type KeystrokeHandler,
  KeystrokeProvider,
  type KeystrokeReader,
  makeKeyEvent,
} from "../src/cli/ui/keystroke-context.js";
import type { Card } from "../src/cli/ui/state/cards.js";
import type { KeyEvent } from "../src/cli/ui/stdin-reader.js";

const clipboardMock = vi.hoisted(() => ({
  writeClipboard: vi.fn(() => ({ osc52: true, filePath: null, size: 0 })),
}));

vi.mock("../src/cli/ui/clipboard.js", () => ({
  writeClipboard: clipboardMock.writeClipboard,
}));

class FakeReader implements KeystrokeReader {
  private readonly handlers = new Set<KeystrokeHandler>();

  start(): void {
    // no-op
  }

  subscribe(handler: KeystrokeHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  feed(ev: Partial<KeyEvent>): void {
    const event = makeKeyEvent(ev);
    for (const handler of [...this.handlers]) handler(event);
  }
}

const assistantCard = (text: string): Card => ({
  id: "a1",
  ts: 0,
  kind: "streaming",
  text,
  done: true,
});

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function mount(reader: FakeReader, text: string) {
  return render(
    <KeystrokeProvider reader={reader}>
      <Box flexDirection="column">
        <CopyMode cards={[assistantCard(text)]} onClose={() => {}} />
      </Box>
    </KeystrokeProvider>,
  );
}

function p95(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

describe("CopyMode performance", () => {
  beforeEach(() => {
    clipboardMock.writeClipboard.mockClear();
    clipboardMock.writeClipboard.mockImplementation((text: string) => ({
      osc52: true,
      filePath: null,
      size: text.length,
    }));
  });

  it("renders only the viewport slice for a 1000-line snapshot", async () => {
    const reader = new FakeReader();
    const text = Array.from({ length: 1000 }, (_, i) => `line ${String(i).padStart(4, "0")}`).join(
      "\n",
    );

    const { lastFrame, unmount } = mount(reader, text);
    await flush();

    const frame = lastFrame() ?? "";
    const renderedDataRows = frame.split("\n").filter((line) => /line \d{4}/.test(line)).length;

    expect(frame).toContain("line 0000");
    expect(frame).not.toContain("line 0050");
    expect(frame).not.toContain("line 0999");
    expect(renderedDataRows).toBeLessThanOrEqual(30);
    unmount();
  });

  it("keeps mouseDrag dispatch p95 under the frame budget", async () => {
    const reader = new FakeReader();
    const { unmount } = mount(reader, "hello world");
    await flush();

    reader.feed(makeKeyEvent({ mouseClick: true, mouseRow: 3, mouseCol: 3 }));
    const samples: number[] = [];
    for (let i = 0; i < 80; i += 1) {
      const col = 3 + (i % 8);
      const started = performance.now();
      reader.feed(makeKeyEvent({ mouseDrag: true, mouseRow: 3, mouseCol: col }));
      samples.push(performance.now() - started);
    }
    reader.feed(makeKeyEvent({ mouseRelease: true, mouseRow: 3, mouseCol: 10 }));
    await flush();

    expect(p95(samples)).toBeLessThan(16);
    expect(clipboardMock.writeClipboard).toHaveBeenCalledWith("hello wo");
    unmount();
  });
});
