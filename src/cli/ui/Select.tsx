/**
 * Minimal arrow-key list components for Ink — single-select and
 * multi-select. No external deps beyond Ink's `useInput`.
 *
 * Why hand-roll: `ink-select-input` exists, but it defaults to
 * Enter-only interaction (no space-to-toggle for multi-select), doesn't
 * expose the "hint / footer" slot we want under each item, and would be
 * another dep for ~60 lines of UI code. Reasonix already has one React
 * rendering quirk bundled (`ink-text-input`); adding more is low value.
 */

import { Box, Text } from "ink";
import React, { useState } from "react";
import { useKeystroke } from "./keystroke-context.js";
import { COLOR } from "./theme.js";

export interface SelectItem<V extends string = string> {
  /** Stable identifier — returned to caller on submit. */
  value: V;
  /** First-row label. */
  label: string;
  /** Optional second row rendered dimmed. */
  hint?: string;
  /** If true, item is not selectable (rendered dimmed, skipped on nav). */
  disabled?: boolean;
  /** Tab on this item starts inline-edit; typed text is forwarded as `onSubmit`'s 2nd arg. */
  denyWithContext?: boolean;
}

export interface SingleSelectProps<V extends string> {
  items: SelectItem<V>[];
  initialValue?: V;
  onSubmit: (value: V, context?: string) => void;
  onCancel?: () => void;
  /** Optional dim footer beneath the list — e.g. "[↑↓] navigate · [Enter] select · [Esc] cancel". */
  footer?: string;
}

export function SingleSelect<V extends string>({
  items,
  initialValue,
  onSubmit,
  onCancel,
  footer,
}: SingleSelectProps<V>) {
  const initialIndex = Math.max(
    0,
    items.findIndex((i) => i.value === initialValue && !i.disabled),
  );
  const [index, setIndex] = useState(initialIndex === -1 ? 0 : initialIndex);
  const [editingContext, setEditingContext] = useState<string | null>(null);
  const activeItem = items[index];
  const isEditing = editingContext !== null;

  useKeystroke((ev) => {
    if (ev.paste) return;

    if (isEditing) {
      if (ev.escape) {
        setEditingContext(null);
      } else if (ev.upArrow || ev.downArrow) {
        setEditingContext(null);
        setIndex((i) => findNextEnabled(items, i, ev.upArrow ? -1 : +1));
      } else if (ev.return) {
        const chosen = items[index];
        if (chosen && !chosen.disabled) {
          const ctx = editingContext || undefined;
          setEditingContext(null);
          onSubmit(chosen.value, ctx);
        }
      } else if (ev.backspace) {
        setEditingContext((v) => (v ?? "").slice(0, -1));
      } else if (ev.tab) {
        setEditingContext((v) => `${v ?? ""}, `);
      } else if (ev.input) {
        setEditingContext((v) => (v ?? "") + ev.input);
      }
      return;
    }

    if (ev.upArrow) {
      setIndex((i) => findNextEnabled(items, i, -1));
    } else if (ev.downArrow) {
      setIndex((i) => findNextEnabled(items, i, +1));
    } else if (ev.tab && activeItem?.denyWithContext) {
      setEditingContext("");
    } else if (ev.return) {
      const chosen = items[index];
      if (chosen && !chosen.disabled) onSubmit(chosen.value);
    } else if (ev.escape && onCancel) {
      onCancel();
    }
  });

  const canDenyWithContext = activeItem?.denyWithContext;
  const resolvedFooter = (() => {
    if (isEditing) return "[Enter] confirm · [Esc] cancel · [↑↓] change option";
    return (
      footer ??
      (canDenyWithContext
        ? "[↑↓] navigate · [Enter] select · [Tab] add context · [Esc] cancel"
        : undefined)
    );
  })();

  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
        const showEditing = i === index && isEditing;
        const displayLabel = showEditing ? `${item.label}, ${editingContext}` : item.label;
        return (
          <SelectRow
            key={item.value}
            item={{ ...item, label: displayLabel }}
            active={i === index}
            marker={i === index ? "▸" : " "}
            showInlineCursor={showEditing}
          />
        );
      })}
      {resolvedFooter ? (
        <Box marginTop={1}>
          <Text dimColor>{resolvedFooter}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export interface MultiSelectProps<V extends string> {
  items: SelectItem<V>[];
  initialSelected?: V[];
  onSubmit: (values: V[]) => void;
  onCancel?: () => void;
  /** Footer hint under the list — e.g. "[Space] toggle · [Enter] confirm". */
  footer?: string;
}

export function MultiSelect<V extends string>({
  items,
  initialSelected = [],
  onSubmit,
  onCancel,
  footer,
}: MultiSelectProps<V>) {
  const [index, setIndex] = useState(() => {
    const first = items.findIndex((i) => !i.disabled);
    return first === -1 ? 0 : first;
  });
  const [selected, setSelected] = useState<Set<V>>(new Set(initialSelected));

  useKeystroke((ev) => {
    if (ev.paste) return;
    if (ev.upArrow) {
      setIndex((i) => findNextEnabled(items, i, -1));
    } else if (ev.downArrow) {
      setIndex((i) => findNextEnabled(items, i, +1));
    } else if (ev.input === " ") {
      const item = items[index];
      if (!item || item.disabled) return;
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(item.value)) next.delete(item.value);
        else next.add(item.value);
        return next;
      });
    } else if (ev.return) {
      // Preserve catalog order rather than insertion order, so reruns
      // produce the same spec list for the same checkbox set — makes the
      // `config.json` diff trivially stable.
      const ordered = items.filter((i) => selected.has(i.value)).map((i) => i.value);
      onSubmit(ordered);
    } else if (ev.escape && onCancel) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
        const checked = selected.has(item.value);
        const marker = checked ? "[x]" : "[ ]";
        return (
          <SelectRow
            key={item.value}
            item={item}
            active={i === index}
            marker={`${i === index ? "▸" : " "} ${marker}`}
          />
        );
      })}
      {footer ? (
        <Box marginTop={1}>
          <Text dimColor>{footer}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

// ---------- internals ----------

function SelectRow<V extends string>({
  item,
  active,
  marker,
  showInlineCursor = false,
}: {
  item: SelectItem<V>;
  active: boolean;
  marker: string;
  showInlineCursor?: boolean;
}) {
  // Color: dim for disabled, primary cyan + bold for active, plain
  // default for inactive. Keeps the active-row affordance consistent
  // with the slash + at-mention pickers (▸ + colored text).
  const color = item.disabled ? COLOR.info : active ? COLOR.primary : undefined;
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={color} bold={active} dimColor={item.disabled}>
          {marker} {item.label}
        </Text>
        {showInlineCursor ? (
          <Text backgroundColor="#67e8f9" color="black">
            {" "}
          </Text>
        ) : null}
      </Box>
      {item.hint ? (
        <Box paddingLeft={marker.length + 1}>
          <Text dimColor>{item.hint}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function findNextEnabled<V extends string>(
  items: SelectItem<V>[],
  from: number,
  step: -1 | 1,
): number {
  if (items.length === 0) return 0;
  let i = from;
  for (let tries = 0; tries < items.length; tries++) {
    i = (i + step + items.length) % items.length;
    if (!items[i]?.disabled) return i;
  }
  return from;
}
