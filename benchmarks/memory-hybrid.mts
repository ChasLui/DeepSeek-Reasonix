import { performance } from "node:perf_hooks";
import { segmentCjk } from "../src/index/cjk/segment.js";
import { fuseRrf } from "../src/index/hybrid/fuse.js";
import { Bm25Index } from "../src/index/lexical/bm25.js";

interface BenchDoc {
  id: string;
  text: string;
}

const QUERIES = [
  "prompt cache 漂移",
  "缓存优先策略",
  "tool repair storm",
  "Claude Code import",
  "observation capture",
];

for (const size of [1_000, 10_000]) {
  const docs = makeDocs(size);
  const index = new Bm25Index();
  const rssBefore = process.memoryUsage().rss;
  for (const doc of docs) index.add(doc.id, segmentCjk(doc.text, { loadJieba: () => null }));
  const rssAfter = process.memoryUsage().rss;

  const timings: number[] = [];
  let outputChars = 0;
  for (let i = 0; i < 50; i++) {
    const query = QUERIES[i % QUERIES.length]!;
    const start = performance.now();
    const lexical = index.search(segmentCjk(query, { loadJieba: () => null }), 8);
    const vectorLike = lexical.slice().reverse();
    const fused = fuseRrf([lexical, vectorLike]).slice(0, 8);
    timings.push(performance.now() - start);
    outputChars += JSON.stringify(fused).length;
  }

  timings.sort((a, b) => a - b);
  const p95 = timings[Math.floor(timings.length * 0.95)] ?? 0;
  const rssDeltaMb = (rssAfter - rssBefore) / 1024 / 1024;
  console.log(
    `memory-hybrid size=${size} p95=${p95.toFixed(2)}ms rssDelta=${rssDeltaMb.toFixed(1)}MiB outputChars=${outputChars}`,
  );

  if (size === 1_000 && p95 > 200) {
    console.error(`FAIL: 1k p95 ${p95.toFixed(2)}ms exceeds 200ms`);
    process.exit(1);
  }
}

function makeDocs(size: number): BenchDoc[] {
  const templates = [
    "prompt cache 漂移 should check prefix fingerprint and append-only log",
    "缓存优先策略要求 immutable prefix and volatile scratch boundaries",
    "tool repair storm suppresses repeated tool calls in a sliding window",
    "Claude Code import writes ChatMessage JSONL into Reasonix sessions",
    "observation capture reads Stop hook NDJSON without blocking hook outcome",
  ];
  return Array.from({ length: size }, (_, i) => ({
    id: `doc_${i}`,
    text: `${templates[i % templates.length]} #${i}`,
  }));
}
