import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { decodeStructuredPayload, encodeToonPayload } from "./codec.js";

export function toonPathFor(path: string): string {
  return path.endsWith(".json") ? `${path.slice(0, -5)}.toon` : path;
}

export function legacyJsonPathFor(path: string): string {
  return path.endsWith(".toon") ? `${path.slice(0, -5)}.json` : path;
}

export function readStructuredFileSync<T>(path: string): T | null {
  for (const candidate of structuredCandidates(path)) {
    if (!existsSync(candidate)) continue;
    try {
      return decodeStructured(readFileSync(candidate, "utf8")) as T;
    } catch {}
  }
  return null;
}

export function writeStructuredFileSync(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${encodeToonPayload(value)}\n`, "utf8");
}

export async function readStructuredFile<T>(path: string): Promise<T | null> {
  for (const candidate of structuredCandidates(path)) {
    try {
      return decodeStructured(await fs.readFile(candidate, "utf8")) as T;
    } catch {}
  }
  return null;
}

export async function writeStructuredFile(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, `${encodeToonPayload(value)}\n`, "utf8");
}

function structuredCandidates(path: string): string[] {
  const legacy = legacyJsonPathFor(path);
  return legacy === path ? [path] : [path, legacy];
}

function decodeStructured(raw: string): unknown {
  return decodeStructuredPayload(raw);
}
