import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  disableAlternateScrollMode,
  disableMouseMode,
  enableAlternateScrollMode,
  enableMouseMode,
  getMouseModeSnapshot,
  isMouseModeActive,
  setMouseMode,
  subscribeMouseMode,
  toggleMouseMode,
} from "../src/cli/ui/mouse-mode.js";

describe("mouse-mode SGR enable/disable", () => {
  let writes: string[];
  let origWrite: typeof process.stdout.write;
  let origIsTTY: boolean | undefined;

  beforeEach(() => {
    writes = [];
    origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;
    origIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    // Reset module state — disable first to clear `active` from any prior test.
    disableMouseMode();
    disableAlternateScrollMode();
    writes.length = 0;
  });

  afterEach(() => {
    disableMouseMode();
    disableAlternateScrollMode();
    process.stdout.write = origWrite;
    Object.defineProperty(process.stdout, "isTTY", { value: origIsTTY, configurable: true });
  });

  it("enable writes the SGR + 1000 + 1006 escape", () => {
    enableMouseMode();
    expect(writes.join("")).toBe("\u001b[?1000h\u001b[?1006h");
  });

  it("enable is idempotent — second call is a no-op", () => {
    enableMouseMode();
    enableMouseMode();
    expect(writes.length).toBe(1);
  });

  it("disable writes the matching off-escape", () => {
    enableMouseMode();
    writes.length = 0;
    disableMouseMode();
    expect(writes.join("")).toBe("\u001b[?1006l\u001b[?1000l");
  });

  it("set/toggle return the active snapshot and changed flag", () => {
    expect(isMouseModeActive()).toBe(false);
    expect(setMouseMode(true)).toEqual({ active: true, changed: true });
    expect(setMouseMode(true)).toEqual({ active: true, changed: false });
    expect(toggleMouseMode()).toEqual({ active: false, changed: true });
    expect(getMouseModeSnapshot()).toBe(false);
  });

  it("subscribers are notified only when active state changes", () => {
    const snapshots: boolean[] = [];
    const unsubscribe = subscribeMouseMode(() => snapshots.push(getMouseModeSnapshot()));

    setMouseMode(true);
    setMouseMode(true);
    setMouseMode(false);
    unsubscribe();
    setMouseMode(true);

    expect(snapshots).toEqual([true, false]);
  });

  it("disable without prior enable still clears stale terminal tracking", () => {
    disableMouseMode();
    expect(writes.join("")).toBe("\u001b[?1006l\u001b[?1000l");
    expect(isMouseModeActive()).toBe(false);
  });

  it("alternate-scroll writes only DECSET 1007 and does not enable SGR tracking", () => {
    enableAlternateScrollMode();
    expect(writes.join("")).toBe("\u001b[?1007h");
    expect(isMouseModeActive()).toBe(false);
  });

  it("alternate-scroll disable clears DECSET 1007 without changing SGR state", () => {
    enableAlternateScrollMode();
    writes.length = 0;
    disableAlternateScrollMode();
    expect(writes.join("")).toBe("\u001b[?1007l");
    expect(isMouseModeActive()).toBe(false);
  });

  it("enable when stdout isn't a TTY is a no-op", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    enableMouseMode();
    enableAlternateScrollMode();
    expect(writes.length).toBe(0);
    // And subsequent disable is also a no-op (active flag never flipped).
    disableMouseMode();
    disableAlternateScrollMode();
    expect(writes.join("")).toBe("");
  });
});
