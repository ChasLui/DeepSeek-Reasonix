/** Wire-up: registers the Tier-1 filter set in a single call. Idempotent via try/catch on duplicates. */

import { gitCompactors } from "./filters/git.js";
import { linterCompactors } from "./filters/linter.js";
import { listingCompactors } from "./filters/listing.js";
import { testRunnerCompactors } from "./filters/test-runner.js";
import { registerCompactor } from "./registry.js";

let registered = false;

/** Register the built-in Tier-1 compactors. Subsequent calls are no-ops. */
export function registerDefaultCompactors(): void {
  if (registered) return;
  for (const c of [
    ...gitCompactors,
    ...testRunnerCompactors,
    ...linterCompactors,
    ...listingCompactors,
  ]) {
    try {
      registerCompactor(c);
    } catch {
      // Duplicate id → another caller already registered; safe to ignore.
    }
  }
  registered = true;
}

/** Test-only: forget that we registered so a follow-up call re-registers. */
export function _resetDefaultsRegistered(): void {
  registered = false;
}
