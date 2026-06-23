/** Minimal Ink TUI thin client: renders a remote daemon session's kernel-event stream and resolves confirmations as a modal. Self-contained — does not touch the in-process App.tsx. */

import { Box, Static, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import React, { useEffect, useRef, useState } from "react";
import type {
  PermissionRequestParams,
  PermissionRequestResult,
  SessionUpdate,
} from "../../acp/protocol.js";
import { type DaemonClient, connectDaemon } from "../../daemon/client.js";

type LineKind = "user" | "assistant" | "tool" | "error" | "info";
interface Line {
  id: number;
  kind: LineKind;
  text: string;
}

interface PendingPermission {
  params: PermissionRequestParams;
  resolve: (r: PermissionRequestResult) => void;
}

const LINE_COLOR: Record<LineKind, string> = {
  user: "cyan",
  assistant: "green",
  tool: "yellow",
  error: "red",
  info: "gray",
};

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function LineView({ line }: { line: Line }): React.ReactElement {
  return (
    <Text color={LINE_COLOR[line.kind]}>
      {line.kind === "user" ? "› " : ""}
      {line.text}
    </Text>
  );
}

export function PermissionModal({
  params,
  onChoose,
}: {
  params: PermissionRequestParams;
  onChoose: (optionId: string | null) => void;
}): React.ReactElement {
  const [idx, setIdx] = useState(0);
  useInput((input, key) => {
    if (key.upArrow) setIdx((i) => Math.max(0, i - 1));
    else if (key.downArrow) setIdx((i) => Math.min(params.options.length - 1, i + 1));
    else if (key.return) onChoose(params.options[idx]?.optionId ?? null);
    else if (key.escape) onChoose(null);
    else if (/^[1-9]$/.test(input)) {
      const opt = params.options[Number(input) - 1];
      if (opt) onChoose(opt.optionId);
    }
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow">⚠ {params.toolCall.title ?? "Confirm action"}</Text>
      {params.options.map((o, i) => (
        <Text key={o.optionId} {...(i === idx ? { color: "cyan" } : {})}>
          {i === idx ? "▸ " : "  "}
          {i + 1}) {o.name}
        </Text>
      ))}
      <Text color="gray">↑/↓ or 1-{params.options.length} · enter · esc cancel</Text>
    </Box>
  );
}

export interface RemoteAppProps {
  socketPath: string;
  cwd: string;
  /** Injectable for tests; defaults to the real socket client. */
  connect?: typeof connectDaemon | undefined;
}

export function RemoteApp({ socketPath, cwd, connect }: RemoteAppProps): React.ReactElement {
  const { exit } = useApp();
  const [lines, setLines] = useState<Line[]>([]);
  const [streaming, setStreaming] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingPermission | null>(null);
  const [status, setStatus] = useState("connecting…");
  const clientRef = useRef<DaemonClient | null>(null);
  const sessionRef = useRef("");
  const nextId = useRef(0);
  const streamBuf = useRef("");

  const push = (kind: LineKind, text: string): void =>
    setLines((ls) => [...ls, { id: nextId.current++, kind, text }]);

  const flushStream = (): void => {
    if (!streamBuf.current) return;
    push("assistant", streamBuf.current);
    streamBuf.current = "";
    setStreaming("");
  };

  const applyUpdate = (u: SessionUpdate): void => {
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        streamBuf.current += u.content.text;
        setStreaming(streamBuf.current);
        return;
      case "tool_call":
        if (u.status === "pending") {
          flushStream();
          push("tool", `⚙ ${u.title ?? u.toolCallId}`);
        }
        return;
      case "tool_call_update":
        if (u.status === "completed" || u.status === "failed") {
          const text = u.content?.[0]?.content.text ?? "";
          push(
            "tool",
            `${u.status === "failed" ? "✗" : "✓"}${text ? ` ${truncate(text, 200)}` : ""}`,
          );
        }
        return;
      default:
        return;
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: applyUpdate/push are mount-stable (refs + stable setState); the effect connects once.
  useEffect(() => {
    let cancelled = false;
    const connectFn = connect ?? connectDaemon;
    void (async () => {
      try {
        const client = await connectFn(socketPath, {
          onUpdate: (p) => applyUpdate(p.update),
          onPermission: (params) =>
            new Promise<PermissionRequestResult>((resolve) => setPending({ params, resolve })),
        });
        if (cancelled) {
          client.close();
          return;
        }
        clientRef.current = client;
        await client.initialize();
        sessionRef.current = await client.newSession(cwd);
        setStatus(`session ${sessionRef.current}`);
      } catch {
        push("error", `daemon not reachable at ${socketPath} — run: reasonix daemon start`);
        setStatus("disconnected");
      }
    })();
    return () => {
      cancelled = true;
      clientRef.current?.close();
    };
  }, [socketPath, cwd, connect]);

  const submit = async (raw: string): Promise<void> => {
    const text = raw.trim();
    setInput("");
    if (!text) return;
    if (text === "exit" || text === "quit") {
      exit();
      return;
    }
    if (!clientRef.current || !sessionRef.current) {
      push("error", "not connected to a daemon session yet");
      return;
    }
    push("user", text);
    setBusy(true);
    try {
      const stop = await clientRef.current.prompt(sessionRef.current, text, () => undefined);
      flushStream();
      if (stop === "error") push("error", "turn ended with error");
    } catch (err) {
      push("error", (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box flexDirection="column">
      <Static items={lines}>{(line) => <LineView key={line.id} line={line} />}</Static>
      {streaming ? <Text color="green">{streaming}</Text> : null}
      {pending ? (
        <PermissionModal
          params={pending.params}
          onChoose={(optionId) => {
            pending.resolve(
              optionId
                ? { outcome: { outcome: "selected", optionId } }
                : { outcome: { outcome: "cancelled" } },
            );
            setPending(null);
          }}
        />
      ) : busy ? (
        <Text color="gray">…thinking</Text>
      ) : (
        <Box>
          <Text color="cyan">› </Text>
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={submit}
            placeholder={`${status} — type a prompt (exit to quit)`}
          />
        </Box>
      )}
    </Box>
  );
}
