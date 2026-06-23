export type RegistrySource = "official" | "smithery" | "local";

export interface RegistryInstall {
  runtime: "npm" | "pypi" | "remote";
  packageId?: string | undefined;
  version?: string | undefined;
  transport: "stdio" | "sse" | "streamable-http";
  /** For remote transports. */
  url?: string | undefined;
  /** Env var names the user must set. */
  requiredEnv?: string[] | undefined;
  /** Trailing args to pass after the package id — e.g. ["run", "<qualifiedName>"] for `npx -y @smithery/cli run X`. */
  extraArgs?: string[] | undefined;
}

export interface RegistryEntry {
  /** Stable identifier — may be qualified ("io.example/mcp") or scoped ("@vendor/pkg"). */
  name: string;
  title: string;
  description: string;
  source: RegistrySource;
  /** Populated for official + local. Smithery list omits install info. */
  install?: RegistryInstall | undefined;
  /** Smithery's useCount, used as a sort key when present. */
  popularity?: number | undefined;
  /** Project / homepage URL. */
  homepage?: string | undefined;
  /** Icon URL — official: first packages[0].icons[0].src; smithery: iconUrl on listing. */
  iconUrl?: string | undefined;
}

export interface CachePagination {
  /** How many pages have been loaded so far. Smithery / local treat the whole listing as page 1. */
  pagesLoaded: number;
  /** Cursor needed to fetch the next page, or null if the source has been exhausted. */
  nextCursor: string | null;
}

export interface CacheFile {
  /** Bumped when the on-disk shape changes — older files are treated as invalid. */
  schemaVersion: 2;
  fetchedAt: number;
  source: RegistrySource;
  entries: RegistryEntry[];
  pagination: CachePagination;
}
