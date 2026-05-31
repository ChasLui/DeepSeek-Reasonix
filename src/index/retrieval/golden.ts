// Golden set for retrieval recall/precision (SC-001/SC-006): fixture corpus +
// positives (share tokens with one target) + disjoint-vocab negatives.
import { nullPrototype } from "../../utils/safe-object.js";

export interface GoldenQuery {
  query: string;
  expect: string;
}

export const FIXTURE_FILES: Record<string, string> = nullPrototype({
  "src/auth/token.ts":
    "export function validateAuthToken(jwt: string) {\n  // verify the bearer JWT signature and expiry\n  return jwt.startsWith('bearer ');\n}\n",
  "src/cache/prefix.ts":
    "export class PrefixCache {\n  // compute the prefix cache hit ratio for billing\n  hitRatio(): number { return 0.9; }\n}\n",
  "src/repair/scavenge.ts":
    "export function scavengeToolCalls(reasoning: string) {\n  // recover tool calls leaked into reasoning content\n  return reasoning.match(/tool_call/g);\n}\n",
  "src/net/retry.ts":
    "export function retryWithBackoff(fn: () => void) {\n  // exponential backoff retry on transient failure\n  return fn;\n}\n",
  "src/db/sqlite.ts":
    "export function openDatabase(path: string) {\n  // open a sqlite database in WAL journal mode\n  return path;\n}\n",
  "src/parse/json.ts":
    "export function parseLooseJson(text: string) {\n  // tolerant parser: trailing comma, single quote\n  return JSON.parse(text);\n}\n",
  "src/ui/spinner.ts":
    "export function renderSpinner(frame: number) {\n  // draw an animated terminal spinner frame\n  return frame % 8;\n}\n",
  "src/fs/walker.ts":
    "export function walkDirectory(root: string) {\n  // recursively walk files honoring gitignore rules\n  return root;\n}\n",
  "src/embed/cosine.ts":
    "export function cosineSimilarity(a: number[], b: number[]) {\n  // dot product of two normalized embedding vectors\n  return a.length + b.length;\n}\n",
  "src/cli/args.ts":
    "export function parseArguments(argv: string[]) {\n  // parse command line flags and positionals\n  return argv;\n}\n",
  "src/log/redact.ts":
    "export function redactSecrets(line: string) {\n  // mask api key and password tokens in logs\n  return line.replace(/key/g, '***');\n}\n",
  "src/queue/concurrency.ts":
    "export class ConcurrencyBucket {\n  // acquire and release concurrency slots with a queue\n  acquire() {}\n  release() {}\n}\n",
});

export const GOLDEN_QUERIES: GoldenQuery[] = [
  { query: "validateAuthToken", expect: "src/auth/token.ts" },
  { query: "verify a bearer jwt signature", expect: "src/auth/token.ts" },
  { query: "PrefixCache", expect: "src/cache/prefix.ts" },
  {
    query: "compute the prefix cache hit ratio",
    expect: "src/cache/prefix.ts",
  },
  { query: "scavengeToolCalls", expect: "src/repair/scavenge.ts" },
  {
    query: "recover tool calls leaked into reasoning",
    expect: "src/repair/scavenge.ts",
  },
  { query: "retryWithBackoff", expect: "src/net/retry.ts" },
  { query: "exponential backoff retry on failure", expect: "src/net/retry.ts" },
  { query: "openDatabase", expect: "src/db/sqlite.ts" },
  { query: "open a sqlite database in WAL mode", expect: "src/db/sqlite.ts" },
  { query: "parseLooseJson", expect: "src/parse/json.ts" },
  { query: "tolerant json parser trailing comma", expect: "src/parse/json.ts" },
  { query: "renderSpinner", expect: "src/ui/spinner.ts" },
  { query: "animated terminal spinner frame", expect: "src/ui/spinner.ts" },
  { query: "walkDirectory", expect: "src/fs/walker.ts" },
  {
    query: "recursively walk files honoring gitignore",
    expect: "src/fs/walker.ts",
  },
  { query: "cosineSimilarity", expect: "src/embed/cosine.ts" },
  {
    query: "dot product of normalized embedding vectors",
    expect: "src/embed/cosine.ts",
  },
  { query: "parseArguments", expect: "src/cli/args.ts" },
  { query: "parse command line flags", expect: "src/cli/args.ts" },
  { query: "redactSecrets", expect: "src/log/redact.ts" },
  { query: "mask api key and password in logs", expect: "src/log/redact.ts" },
  { query: "ConcurrencyBucket", expect: "src/queue/concurrency.ts" },
  {
    query: "acquire and release concurrency slots",
    expect: "src/queue/concurrency.ts",
  },
  {
    query: "queue concurrency slot acquire release",
    expect: "src/queue/concurrency.ts",
  },
];

export const NEGATIVE_QUERIES: string[] = [
  "kubernetes pod scheduler eviction",
  "graphql subscription resolver",
  "redis pubsub channel",
  "webrtc ice candidate negotiation",
  "protobuf wire serialization",
  "kafka consumer offset commit",
  "terraform provider plugin",
  "opengl shader pipeline",
  "bluetooth gatt characteristic",
  "midi sequencer playback",
  "raycasting collision mesh",
  "quaternion slerp interpolation",
];
