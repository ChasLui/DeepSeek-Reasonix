import { Box, Text } from "ink";
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

function mount(
  reader: FakeReader,
  onClose: (value: unknown) => void = () => {},
  text = "hello world",
  prefixRows = 0,
) {
  return render(
    <KeystrokeProvider reader={reader}>
      <Box flexDirection="column">
        {prefixRows > 0 ? <Text>prefix</Text> : null}
        <CopyMode cards={[assistantCard(text)]} onClose={onClose} />
      </Box>
    </KeystrokeProvider>,
  );
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function feed(reader: FakeReader, ev: Partial<KeyEvent>): Promise<void> {
  reader.feed(ev);
  await flush();
}

async function waitForOutput(read: () => string, expected: string): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    if (read().includes(expected)) return;
    await flush();
  }
  expect(read()).toContain(expected);
}

describe("CopyMode mouse selection", () => {
  beforeEach(() => {
    clipboardMock.writeClipboard.mockClear();
    clipboardMock.writeClipboard.mockImplementation((text: string) => ({
      osc52: true,
      filePath: null,
      size: text.length,
    }));
  });

  it("copies a character span on mouse release", async () => {
    const reader = new FakeReader();
    const { unmount } = mount(reader);
    await flush();

    reader.feed(makeKeyEvent({ mouseClick: true, mouseRow: 3, mouseCol: 3 }));
    reader.feed(makeKeyEvent({ mouseDrag: true, mouseRow: 3, mouseCol: 7 }));
    reader.feed(makeKeyEvent({ mouseRelease: true, mouseRow: 3, mouseCol: 7 }));
    await flush();

    expect(clipboardMock.writeClipboard).toHaveBeenCalledWith("hello");
    unmount();
  });

  it("does not write the clipboard for click-and-release without drag", async () => {
    const reader = new FakeReader();
    const { unmount } = mount(reader);
    await flush();

    reader.feed(makeKeyEvent({ mouseClick: true, mouseRow: 3, mouseCol: 3 }));
    reader.feed(makeKeyEvent({ mouseRelease: true, mouseRow: 3, mouseCol: 3 }));
    await flush();

    expect(clipboardMock.writeClipboard).not.toHaveBeenCalled();
    unmount();
  });

  it("maps mouse rows through the CopyMode parent layout offset", async () => {
    const reader = new FakeReader();
    const { unmount } = mount(reader, () => {}, "hello world", 1);
    await flush();

    reader.feed(makeKeyEvent({ mouseClick: true, mouseRow: 4, mouseCol: 3 }));
    reader.feed(makeKeyEvent({ mouseDrag: true, mouseRow: 4, mouseCol: 7 }));
    reader.feed(makeKeyEvent({ mouseRelease: true, mouseRow: 4, mouseCol: 7 }));
    await flush();

    expect(clipboardMock.writeClipboard).toHaveBeenCalledWith("hello");
    unmount();
  });

  it("finishes a drag after the release event is lost", async () => {
    vi.useFakeTimers();
    try {
      const reader = new FakeReader();
      const { unmount } = mount(reader);
      await vi.runAllTimersAsync();

      reader.feed(makeKeyEvent({ mouseClick: true, mouseRow: 3, mouseCol: 3 }));
      reader.feed(makeKeyEvent({ mouseDrag: true, mouseRow: 3, mouseCol: 7 }));
      await vi.advanceTimersByTimeAsync(2000);

      expect(clipboardMock.writeClipboard).toHaveBeenCalledWith("hello");
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the tempfile path when OSC52 is unavailable", async () => {
    clipboardMock.writeClipboard.mockImplementation((text: string) => ({
      osc52: false,
      filePath: "/tmp/reasonix-clip/clip.txt",
      size: text.length,
    }));
    const reader = new FakeReader();
    const { lastFrame, unmount } = mount(reader);
    await flush();

    reader.feed(makeKeyEvent({ mouseClick: true, mouseRow: 3, mouseCol: 3 }));
    reader.feed(makeKeyEvent({ mouseDrag: true, mouseRow: 3, mouseCol: 7 }));
    reader.feed(makeKeyEvent({ mouseRelease: true, mouseRow: 3, mouseCol: 7 }));
    await flush();

    expect(clipboardMock.writeClipboard).toHaveBeenCalledWith("hello");
    await waitForOutput(() => lastFrame() ?? "", "file=/tmp/reasonix-clip/clip.txt");
    unmount();
  });

  it("double-click yanks the word under the pointer", async () => {
    const reader = new FakeReader();
    const { unmount } = mount(reader, () => {}, "/usr/bin/foo bar");
    await flush();

    reader.feed(makeKeyEvent({ mouseClick: true, mouseRow: 3, mouseCol: 5 }));
    reader.feed(makeKeyEvent({ mouseRelease: true, mouseRow: 3, mouseCol: 5 }));
    reader.feed(makeKeyEvent({ mouseClick: true, mouseRow: 3, mouseCol: 5 }));
    reader.feed(makeKeyEvent({ mouseRelease: true, mouseRow: 3, mouseCol: 5 }));
    await flush();

    expect(clipboardMock.writeClipboard).toHaveBeenCalledTimes(1);
    expect(clipboardMock.writeClipboard).toHaveBeenLastCalledWith("/usr/bin/foo");
    unmount();
  });

  it("triple-click yanks the whole visible line", async () => {
    const reader = new FakeReader();
    const { unmount } = mount(reader, () => {}, "/usr/bin/foo bar");
    await flush();

    for (let i = 0; i < 3; i += 1) {
      reader.feed(makeKeyEvent({ mouseClick: true, mouseRow: 3, mouseCol: 5 }));
      reader.feed(makeKeyEvent({ mouseRelease: true, mouseRow: 3, mouseCol: 5 }));
    }
    await flush();

    expect(clipboardMock.writeClipboard).toHaveBeenCalledTimes(2);
    expect(clipboardMock.writeClipboard).toHaveBeenLastCalledWith("/usr/bin/foo bar");
    unmount();
  });

  it("keeps keyboard yank behavior available", async () => {
    const reader = new FakeReader();
    const { unmount } = mount(reader);
    await flush();

    await feed(reader, { input: "y" });

    expect(clipboardMock.writeClipboard).toHaveBeenCalledWith("hello world");
    unmount();
  });
});
