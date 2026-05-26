import type { JsonModeEmptyResponseInfo } from "../client.js";
import { nullPrototype } from "../utils/safe-object.js";

export interface JsonModeEmptyResponseStats {
  total: number;
  byModel: Record<string, number>;
}

const byModel = nullPrototype<Record<string, number>>({});
let total = 0;

export function recordJsonModeEmptyResponse(info: JsonModeEmptyResponseInfo): void {
  total += 1;
  byModel[info.model] = (byModel[info.model] ?? 0) + 1;
}

export function getJsonModeEmptyResponseStats(): JsonModeEmptyResponseStats {
  return { total, byModel: { ...byModel } };
}

export function resetJsonModeEmptyResponseStats(): void {
  total = 0;
  for (const model of Object.keys(byModel)) delete byModel[model];
}
