import {
  addProjectShellAllowed,
  clearProjectShellAllowed,
  loadProjectShellAllowed,
  removeProjectShellAllowed,
} from "../../../../config.js";
import { BUILTIN_ALLOWLIST } from "../../../../tools/shell.js";
import type { SlashHandler } from "../dispatch.js";

const permissions: SlashHandler = (args, _loop, ctx) => {
  const sub = (args[0] ?? "").toLowerCase();
  const root = ctx.codeRoot;
  const mode = ctx.editMode ?? null;

  // Bare → status + listing.
  if (sub === "" || sub === "list" || sub === "ls") {
    return { info: renderListing(root, mode) };
  }

  // Mutating subcommands need a code-mode root.
  if (!root) {
    return {
      info: "/permissions add / remove / clear are only available inside `reasonix code` — they edit the project-scoped allowlist (`~/.reasonix/config.json` projects[<root>].shellAllowed).",
    };
  }

  if (sub === "add") {
    const prefix = args.slice(1).join(" ").trim();
    if (!prefix) {
      return {
        info: 'usage: /permissions add <prefix>   (multi-token OK: /permissions add "git push origin")',
      };
    }
    const before = loadProjectShellAllowed(root);
    if (before.includes(prefix)) {
      return { info: `▸ already allowed: ${prefix}` };
    }
    if (BUILTIN_ALLOWLIST.includes(prefix)) {
      return {
        info: `▸ \`${prefix}\` is already in the builtin allowlist — no per-project entry needed. (Builtin entries are always on.)`,
      };
    }
    addProjectShellAllowed(root, prefix);
    return {
      info: `▸ added: ${prefix}\n  → next \`${prefix}\` invocation runs without prompting in this project.`,
    };
  }

  if (sub === "remove" || sub === "rm" || sub === "delete") {
    const target = args.slice(1).join(" ").trim();
    if (!target) {
      return {
        info: "usage: /permissions remove <prefix-or-index>   (e.g. /permissions remove 3, or /permissions remove npm)",
      };
    }
    const existing = loadProjectShellAllowed(root);
    let prefix: string | null = null;
    // Index form: "/permissions remove 3" → 1-based project index.
    if (/^\d+$/.test(target)) {
      const idx = Number.parseInt(target, 10);
      if (idx < 1 || idx > existing.length) {
        return {
          info:
            existing.length === 0
              ? "▸ no project allowlist entries to remove."
              : `▸ index out of range: ${idx} (project list has ${existing.length} entries)`,
        };
      }
      prefix = existing[idx - 1] ?? null;
    } else {
      prefix = target;
    }
    if (prefix === null) return { info: "▸ nothing to remove." };
    // Builtin entries can't be touched — surface that explicitly.
    if (BUILTIN_ALLOWLIST.includes(prefix) && !existing.includes(prefix)) {
      return {
        info: `▸ \`${prefix}\` is in the builtin allowlist (read-only). Builtin entries can't be removed at runtime — they're baked into the binary.`,
      };
    }
    const ok = removeProjectShellAllowed(root, prefix);
    return {
      info: ok
        ? `▸ removed: ${prefix}`
        : `▸ no such project entry: ${prefix}   (try /permissions list to see what's stored)`,
    };
  }

  if (sub === "clear") {
    if ((args[1] ?? "").toLowerCase() !== "confirm") {
      const count = loadProjectShellAllowed(root).length;
      return {
        info:
          count === 0
            ? "▸ project allowlist is already empty."
            : `about to drop ${count} project allowlist entr${count === 1 ? "y" : "ies"} for ${root}. Re-run with the word 'confirm' to proceed: /permissions clear confirm`,
      };
    }
    const dropped = clearProjectShellAllowed(root);
    return {
      info:
        dropped === 0
          ? "▸ project allowlist was already empty — nothing changed."
          : `▸ cleared ${dropped} project allowlist entr${dropped === 1 ? "y" : "ies"}.`,
    };
  }

  return {
    info: [
      "usage: /permissions [list]                   show current state",
      '       /permissions add <prefix>            persist (e.g. "npm run build")',
      "       /permissions remove <prefix-or-N>    drop one entry",
      "       /permissions clear confirm           wipe every project entry",
    ].join("\n"),
  };
};

function renderListing(root: string | undefined, mode: string | null): string {
  const lines: string[] = [];
  // Mode banner — edit-gate is the dial that decides whether the
  // allowlist matters for the next call.
  if (mode === "yolo") {
    lines.push(
      "▸ edit mode: YOLO  — every shell command auto-runs, allowlist is bypassed. /mode review to re-enable prompts.",
    );
  } else if (mode === "auto") {
    lines.push(
      "▸ edit mode: auto  — edits auto-apply, shell still gated by allowlist (or ShellConfirm prompt for non-allowlisted).",
    );
  } else if (mode === "review") {
    lines.push(
      "▸ edit mode: review — both edits and non-allowlisted shell commands ask before running.",
    );
  }
  lines.push("");

  // Project list.
  if (root) {
    const project = loadProjectShellAllowed(root);
    lines.push(`Project allowlist (${project.length}) — ${root}`);
    if (project.length === 0) {
      lines.push('  (none — pick "always allow" on a ShellConfirm prompt to add one,');
      lines.push("   or `/permissions add <prefix>` directly.)");
    } else {
      project.forEach((p, i) => {
        lines.push(`  ${String(i + 1).padStart(2)}. ${p}`);
      });
    }
  } else {
    lines.push("Project allowlist — (no project root; chat mode shows builtin entries only)");
  }
  lines.push("");

  // Builtin list — grouped by leading verb so 40 lines stay scannable.
  lines.push(`Builtin allowlist (${BUILTIN_ALLOWLIST.length}) — read-only, baked in`);
  const grouped = new Map<string, string[]>();
  for (const entry of BUILTIN_ALLOWLIST) {
    const head = entry.split(" ")[0] ?? entry;
    if (!grouped.has(head)) grouped.set(head, []);
    grouped.get(head)!.push(entry);
  }
  for (const [head, items] of grouped) {
    if (items.length === 1 && items[0] === head) {
      lines.push(`  · ${head}`);
    } else {
      const tail = items.map((i) => i.slice(head.length).trim() || "(bare)").join(", ");
      lines.push(`  · ${head}: ${tail}`);
    }
  }
  lines.push("");
  lines.push(
    "Subcommands: /permissions add <prefix> · /permissions remove <prefix-or-N> · /permissions clear confirm",
  );
  return lines.join("\n");
}

export const handlers: Record<string, SlashHandler> = {
  permissions,
  perms: permissions,
};
