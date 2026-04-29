/** N parallel samples; selector picks fewest uncertainties with shorter-answer tie-break (Occam prior). */

import type { ChatResponse, DeepSeekClient } from "./client.js";
import { type HarvestOptions, type TypedPlanState, harvest } from "./harvest.js";
import type { ChatRequestOptions } from "./types.js";

export interface BranchSample {
  index: number;
  temperature: number;
  response: ChatResponse;
  planState: TypedPlanState;
}

export type BranchSelector = (samples: BranchSample[]) => BranchSample;

export interface BranchOptions {
  /** Number of parallel samples. 1 disables branching. Default 1. */
  budget?: number;
  /** Temperatures for each branch. Default spreads across [0, 1]. */
  temperatures?: readonly number[];
  /** Harvest options; the selector needs harvest to score samples. */
  harvestOptions?: HarvestOptions;
  /** Custom selector. Default: min uncertainties, tie-break shortest answer. */
  selector?: BranchSelector;
  /** Not awaited; exceptions swallowed. Fires when sample's main + harvest both complete. */
  onSampleDone?: (sample: BranchSample) => void;
}

export interface BranchResult {
  chosen: BranchSample;
  samples: BranchSample[];
}

/** Default: fewest uncertainties wins, ties broken by shorter answer content. */
export const defaultSelector: BranchSelector = (samples) => {
  if (samples.length === 0) throw new Error("defaultSelector: samples is empty");
  return samples.slice().sort((a, b) => {
    const uDiff = a.planState.uncertainties.length - b.planState.uncertainties.length;
    if (uDiff !== 0) return uDiff;
    const aLen = a.response.content?.length ?? 0;
    const bLen = b.response.content?.length ?? 0;
    return aLen - bLen;
  })[0]!;
};

export async function runBranches(
  client: DeepSeekClient,
  request: ChatRequestOptions,
  opts: BranchOptions = {},
): Promise<BranchResult> {
  const budget = Math.max(1, opts.budget ?? 1);
  const temperatures = resolveTemperatures(budget, opts.temperatures);
  const selector = opts.selector ?? defaultSelector;

  const samples = await Promise.all(
    temperatures.map(async (temperature, index): Promise<BranchSample> => {
      const response = await client.chat({ ...request, temperature });
      const planState = await harvest(response.reasoningContent, client, opts.harvestOptions);
      const sample: BranchSample = { index, temperature, response, planState };
      try {
        opts.onSampleDone?.(sample);
      } catch {
        /* callback errors must not poison the await */
      }
      return sample;
    }),
  );

  return { chosen: selector(samples), samples };
}

/** Sum usage across branch samples for telemetry purposes. */
export function aggregateBranchUsage(samples: readonly BranchSample[]) {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let promptCacheHitTokens = 0;
  let promptCacheMissTokens = 0;
  for (const s of samples) {
    promptTokens += s.response.usage.promptTokens;
    completionTokens += s.response.usage.completionTokens;
    totalTokens += s.response.usage.totalTokens;
    promptCacheHitTokens += s.response.usage.promptCacheHitTokens;
    promptCacheMissTokens += s.response.usage.promptCacheMissTokens;
  }
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    promptCacheHitTokens,
    promptCacheMissTokens,
  };
}

function resolveTemperatures(budget: number, custom?: readonly number[]): number[] {
  if (custom && custom.length >= budget) return [...custom.slice(0, budget)];
  // Spread evenly across [0, 1] to encourage reasoning-path diversity.
  if (budget === 1) return [0];
  const out: number[] = [];
  for (let i = 0; i < budget; i++) {
    out.push(Number((i / (budget - 1)).toFixed(2)));
  }
  return out;
}
