/** Golden set for search_tools retrieval quality (SC-002): GOLDEN_RECALL for
 *  recall@k, GOLDEN_NEGATIVE for precision traps. All real builtin tool names. */

export interface GoldenCase {
  query: string;
  expectedTool: string;
  source: "builtin" | "mcp" | "skill";
  note?: string;
}

/** ≥20 query→tool pairs for recall@k. */
export const GOLDEN_RECALL: GoldenCase[] = [
  {
    query: "find everywhere a function or symbol is called",
    expectedTool: "find_references",
    source: "builtin",
  },
  {
    query: "what files changed since the last index build",
    expectedTool: "detect_changes",
    source: "builtin",
  },
  {
    query: "what breaks if I change this function — blast radius",
    expectedTool: "impact",
    source: "builtin",
  },
  {
    query: "list the functions and classes defined in a file",
    expectedTool: "get_symbols",
    source: "builtin",
  },
  {
    query: "semantic search for where we handle authentication",
    expectedTool: "semantic_search",
    source: "builtin",
  },
  {
    query: "run a shell command and capture its output",
    expectedTool: "run_command",
    source: "builtin",
  },
  {
    query: "start a long-running background process",
    expectedTool: "run_background",
    source: "builtin",
  },
  {
    query: "replace a string inside an existing file",
    expectedTool: "edit_file",
    source: "builtin",
  },
  {
    query: "apply several edits to one file in a single call",
    expectedTool: "multi_edit",
    source: "builtin",
  },
  {
    query: "create a brand new file with some content",
    expectedTool: "write_file",
    source: "builtin",
  },
  {
    query: "read the contents of a source file",
    expectedTool: "read_file",
    source: "builtin",
  },
  {
    query: "show the project directory layout as a tree",
    expectedTool: "directory_tree",
    source: "builtin",
  },
  {
    query: "save a fact about the user to remember later",
    expectedTool: "remember",
    source: "builtin",
  },
  {
    query: "look up something the user told me earlier",
    expectedTool: "recall_memory",
    source: "builtin",
  },
  {
    query: "search the public internet for documentation",
    expectedTool: "web_search",
    source: "builtin",
  },
  {
    query: "download and read the text of a web page",
    expectedTool: "web_fetch",
    source: "builtin",
  },
  {
    query: "track a checklist of tasks for this session",
    expectedTool: "todo_write",
    source: "builtin",
  },
  {
    query: "connect a new MCP server to the agent",
    expectedTool: "add_mcp_server",
    source: "builtin",
  },
  {
    query: "package a reusable playbook as a skill",
    expectedTool: "create_skill",
    source: "builtin",
  },
  {
    query: "rename or move a file to a new path",
    expectedTool: "move_file",
    source: "builtin",
  },
  {
    query: "read the output of a background job",
    expectedTool: "job_output",
    source: "builtin",
  },
  {
    query: "delete an empty directory",
    expectedTool: "delete_directory",
    source: "builtin",
  },
];

export interface NegativeCase {
  /** Query whose phrasing is bm25-close to the confusables. */
  query: string;
  /** The single correct tool — must outrank every confusable. */
  expectedTool: string;
  /** Wrong-but-similar tools that a naive retriever would surface. */
  confusableWith: string[];
  source: "builtin" | "mcp" | "skill";
}

/** ≥10 precision traps: expected must beat confusables. */
export const GOLDEN_NEGATIVE: NegativeCase[] = [
  {
    query: "search the code for a regex pattern",
    expectedTool: "search_content",
    confusableWith: ["find_in_code", "search_files", "glob"],
    source: "builtin",
  },
  {
    query: "find files whose name matches a pattern",
    expectedTool: "search_files",
    confusableWith: ["glob", "search_content", "find_in_code"],
    source: "builtin",
  },
  {
    query: "where is this identifier referenced",
    expectedTool: "find_references",
    confusableWith: ["find_in_code", "search_content", "get_symbols"],
    source: "builtin",
  },
  {
    query: "jump to a function's definition",
    expectedTool: "get_symbols",
    confusableWith: ["find_references", "find_in_code"],
    source: "builtin",
  },
  {
    query: "remove a single file from disk",
    expectedTool: "delete_file",
    confusableWith: ["delete_directory", "move_file"],
    source: "builtin",
  },
  {
    query: "duplicate a file to another location",
    expectedTool: "copy_file",
    confusableWith: ["move_file", "write_file"],
    source: "builtin",
  },
  {
    query: "stop a job that is still running",
    expectedTool: "stop_job",
    confusableWith: ["wait_for_job", "job_output", "list_jobs"],
    source: "builtin",
  },
  {
    query: "fetch JSON from a REST endpoint",
    expectedTool: "web_fetch",
    confusableWith: ["web_search"],
    source: "builtin",
  },
  {
    query: "estimate what removing this symbol affects",
    expectedTool: "impact",
    confusableWith: ["detect_changes", "find_references"],
    source: "builtin",
  },
  {
    query: "find code by meaning rather than exact text",
    expectedTool: "semantic_search",
    confusableWith: ["find_in_code", "search_content"],
    source: "builtin",
  },
  {
    query: "wait until a background job finishes",
    expectedTool: "wait_for_job",
    confusableWith: ["stop_job", "job_output"],
    source: "builtin",
  },
];
