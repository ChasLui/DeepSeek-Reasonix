/** Mirrors Ink's useStdout — wires viewport sizes + real-stdout methods. */

import { type ReactNode, createContext, createElement, useContext, useMemo } from "react";

export interface ViewportSize {
  readonly columns: number;
  readonly rows: number;
}

export const ViewportContext = createContext<ViewportSize>({ columns: 80, rows: 24 });

export const StdoutContext = createContext<NodeJS.WriteStream>(
  (typeof process !== "undefined" ? (process.stdout ?? null) : null) as NodeJS.WriteStream,
);

export function StdoutProvider({
  stdout,
  children,
}: {
  stdout: NodeJS.WriteStream;
  children: ReactNode;
}): ReturnType<typeof createElement> {
  return createElement(StdoutContext.Provider, { value: stdout }, children);
}

/** Quacks like Ink's `useStdout().stdout`: viewport-driven `columns`/`rows`
 *  + real `.on/.off/.write/.isTTY` proxied to the WriteStream. */
export interface InkStdout {
  readonly columns: number;
  readonly rows: number;
  readonly isTTY: boolean | undefined;
  write(data: string): boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

export function useStdout(): { stdout: InkStdout; write: (data: string) => boolean } {
  const viewport = useContext(ViewportContext);
  const real = useContext(StdoutContext);
  // Stable identity: viewport-budget's `useEffect([stdout])` would otherwise
  // re-fire every render (the original cause of the modal-mount flicker).
  return useMemo(() => {
    const stdout: InkStdout = {
      columns: viewport.columns,
      rows: viewport.rows,
      isTTY: real ? real.isTTY : undefined,
      write: real ? (data: string) => real.write(data) : () => true,
      on: real
        ? (event: string, listener: (...args: unknown[]) => void) =>
            real.on(event as never, listener as never)
        : () => undefined,
      off: real
        ? (event: string, listener: (...args: unknown[]) => void) =>
            real.off(event as never, listener as never)
        : () => undefined,
    };
    return { stdout, write: stdout.write };
  }, [viewport.columns, viewport.rows, real]);
}
