import { DeepSeekClient, type DeepSeekClientOptions } from "./client.js";

const clients = new Map<string, DeepSeekClient>();

export function getOrCreateDeepSeekClient(opts: DeepSeekClientOptions = {}): DeepSeekClient {
  const key = clientKey(opts);
  let found = clients.get(key);
  if (!found) {
    found = new DeepSeekClient(opts);
    clients.set(key, found);
  }
  return found;
}

export function _resetClientSingletonForTests(): void {
  clients.clear();
}

function clientKey(opts: DeepSeekClientOptions): string {
  const apiKey = opts.apiKey ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return JSON.stringify({ apiKey: "", baseUrl: normalizeBaseUrl(opts.baseUrl) });
  }
  return JSON.stringify({ apiKey, baseUrl: normalizeBaseUrl(opts.baseUrl) });
}

function normalizeBaseUrl(input: string | undefined): string {
  let url = input ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
  while (url.endsWith("/")) url = url.slice(0, -1);
  return url;
}
