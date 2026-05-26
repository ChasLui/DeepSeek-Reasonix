// 默认只开 alternate-scroll，避免 SGR mouse tracking 把普通拖拽吞成 mouse event。

const MOUSE_TRACKING_ENABLE = "\u001b[?1000h\u001b[?1006h";
const MOUSE_TRACKING_DISABLE = "\u001b[?1006l\u001b[?1000l";
const ALTERNATE_SCROLL_ENABLE = "\u001b[?1007h";
const ALTERNATE_SCROLL_DISABLE = "\u001b[?1007l";

let active = false;
let alternateScrollActive = false;
const subscribers = new Set<() => void>();

function notifyMouseModeChanged(): void {
  for (const fn of subscribers) fn();
}

export function enableMouseMode(): void {
  if (active) return;
  if (!process.stdout.isTTY) return;
  process.stdout.write(MOUSE_TRACKING_ENABLE);
  active = true;
  notifyMouseModeChanged();
}

export function disableMouseMode(): void {
  const wasActive = active;
  if (process.stdout.isTTY) process.stdout.write(MOUSE_TRACKING_DISABLE);
  active = false;
  if (wasActive) notifyMouseModeChanged();
}

export function enableAlternateScrollMode(): void {
  if (alternateScrollActive) return;
  if (!process.stdout.isTTY) return;
  process.stdout.write(ALTERNATE_SCROLL_ENABLE);
  alternateScrollActive = true;
}

export function disableAlternateScrollMode(): void {
  if (process.stdout.isTTY) process.stdout.write(ALTERNATE_SCROLL_DISABLE);
  alternateScrollActive = false;
}

export function isMouseModeActive(): boolean {
  return active;
}

export function getMouseModeSnapshot(): boolean {
  return active;
}

export function subscribeMouseMode(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

export function setMouseMode(next: boolean): { active: boolean; changed: boolean } {
  const before = active;
  if (next) enableMouseMode();
  else disableMouseMode();
  return { active, changed: before !== active };
}

export function toggleMouseMode(): { active: boolean; changed: boolean } {
  return setMouseMode(!active);
}
