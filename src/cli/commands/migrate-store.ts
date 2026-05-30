import { SUBSYSTEMS, type Subsystem, migrateStore } from "../../storage/migrate-store.js";

export interface MigrateStoreOptions {
  /** Flip `.store-version` to sqlite after a clean copy. */
  activate?: boolean;
  /** Preview counts without writing. */
  dryRun?: boolean;
  /** Comma-separated subsystem allow-list (usage,sessions,events,memory). */
  only?: string;
}

function parseOnly(only: string | undefined): Subsystem[] | undefined {
  if (!only) return undefined;
  const names = only
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const invalid = names.filter((n) => !SUBSYSTEMS.includes(n as Subsystem));
  if (invalid.length > 0) {
    console.error(`unknown subsystem(s): ${invalid.join(", ")}. valid: ${SUBSYSTEMS.join(", ")}`);
    process.exit(1);
  }
  return names as Subsystem[];
}

export function migrateStoreCommand(opts: MigrateStoreOptions): void {
  const only = parseOnly(opts.only);
  let result: ReturnType<typeof migrateStore>;
  try {
    result = migrateStore({
      activate: opts.activate,
      dryRun: opts.dryRun,
      only,
    });
  } catch (err) {
    console.error(`migrate-store failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (result.dryRun) console.log("DRY RUN — nothing written, no backend change.\n");
  const verb = result.dryRun ? "would copy" : "copied";
  for (const s of result.subsystems) {
    console.log(
      s.skipped ? `  ${s.name}: already migrated (skipped)` : `  ${s.name}: ${verb} ${s.count}`,
    );
  }
  console.log("");

  if (result.activated) {
    console.log("✓ backend switched to SQLite (.store-version=sqlite).");
    console.log(
      "  Source files left in place as a cold backup — delete .store-version to roll back.",
    );
  } else if (!result.dryRun) {
    console.log("Data copied to SQLite; the backend still reads files (.store-version unchanged).");
    console.log("Re-run with --activate to switch the backend over.");
  }
}
