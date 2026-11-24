/**
 * local-tools — this machine's search and listing binaries as first-class tools.
 *
 * Replaces pi's generic grep/find/ls (which stay disabled) with ripgrep, fd,
 * and eza, so the model gets tool-specific parameters instead of shell
 * quoting. Built for this box: /usr/bin/{rg,fd,eza}.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const run = promisify(execFile);

const MAX_OUTPUT_CHARS = 40000;
const DEFAULT_TIMEOUT_MS = 20000;

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated: ${text.length - MAX_OUTPUT_CHARS} more characters]`;
}

function tail(text: string, lines: number): string {
  const all = text.split("\n");
  if (all.length <= lines) return text;
  return [`[first ${all.length - lines} lines omitted]`, ...all.slice(-lines)].join("\n");
}

async function exec(bin: string, args: string[], cwd: string, signal?: AbortSignal) {
  try {
    const { stdout, stderr } = await run(bin, args, {
      cwd,
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: 12 * 1024 * 1024,
      signal,
    });
    return { code: 0, stdout, stderr };
  } catch (error: any) {
    // rg/fd use exit 1 for "no matches"; not an error for our purposes.
    if (error && typeof error.code === "number") {
      return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    }
    throw error;
  }
}

const RG_PARAMS = Type.Object({
  pattern: Type.String({ description: "Regular expression to search for (ripgrep syntax)." }),
  path: Type.Optional(Type.String({ description: "File or directory to search. Defaults to the project root." })),
  glob: Type.Optional(Type.String({ description: "Only search files matching this glob, e.g. '*.ts' or '!**/dist/**'." })),
  type: Type.Optional(Type.String({ description: "Only search files of this ripgrep type, e.g. ts, py, rust, md." })),
  fixed: Type.Optional(Type.Boolean({ description: "Treat the pattern as a literal string instead of a regex." })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search. Default is smart case." })),
  contextLines: Type.Optional(Type.Number({ description: "Lines of context around each match (0-5)." })),
  maxResults: Type.Optional(Type.Number({ description: "Maximum matches to return (default 80, max 300)." })),
  hidden: Type.Optional(Type.Boolean({ description: "Include hidden files and directories." })),
});

const FD_PARAMS = Type.Object({
  pattern: Type.Optional(Type.String({ description: "Regex matched against file names. Omit to list everything." })),
  path: Type.Optional(Type.String({ description: "Directory to search. Defaults to the project root." })),
  kind: Type.Optional(Type.Union([Type.Literal("file"), Type.Literal("dir")], { description: "Restrict to files or directories." })),
  extension: Type.Optional(Type.String({ description: "Only entries with this extension, e.g. ts or json (no dot)." })),
  maxDepth: Type.Optional(Type.Number({ description: "Maximum search depth." })),
  hidden: Type.Optional(Type.Boolean({ description: "Include hidden entries." })),
  maxResults: Type.Optional(Type.Number({ description: "Maximum paths to return (default 200, max 500)." })),
});

const EZA_PARAMS = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory or file to list. Defaults to the project root." })),
  tree: Type.Optional(Type.Boolean({ description: "Render a tree instead of a flat listing." })),
  depth: Type.Optional(Type.Number({ description: "Tree depth (1-4). Ignored without tree: true." })),
  all: Type.Optional(Type.Boolean({ description: "Include hidden entries." })),
  long: Type.Optional(Type.Boolean({ description: "Include size, permissions, and timestamps. Default true for flat listings." })),
});

export default function localTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "rg",
    label: "ripgrep",
    description:
      "Search file contents with ripgrep. Faster and more precise than grep: honors .gitignore, supports globs, file types, and context lines. Use this instead of shelling out to grep.",
    promptSnippet: "Search file contents with ripgrep (respects .gitignore, globs, file types).",
    promptGuidelines: [
      "Prefer rg over bash grep/find when looking for text in a codebase.",
      "Narrow searches with glob or type rather than searching the whole tree.",
    ],
    parameters: RG_PARAMS,
    async execute(_id, params, signal, _update, ctx) {
      const cwd = (ctx as any).cwd ?? process.cwd();
      const args = ["--line-number", "--no-heading", "--color=never", "--smart-case", "--max-columns=250"];
      if (params.fixed) args.push("--fixed-strings");
      if (params.ignoreCase) args.push("--ignore-case");
      if (params.hidden) args.push("--hidden", "--glob=!.git/*");
      if (params.glob) args.push("--glob", params.glob);
      if (params.type) args.push("--type", params.type);
      const context = Math.max(0, Math.min(5, params.contextLines ?? 0));
      if (context > 0) args.push("-C", String(context));
      const limit = Math.max(1, Math.min(300, params.maxResults ?? 80));
      args.push("--max-count", String(limit));
      args.push("--", params.pattern);
      if (params.path) args.push(params.path);

      const { code, stdout, stderr } = await exec("rg", args, cwd, signal);
      const output = tail(stdout.trim(), limit * (context > 0 ? context * 2 + 1 : 1) + 5).trim();
      if (code === 1 || !output) {
        return { content: [{ type: "text", text: `No matches for /${params.pattern}/.` }], details: { matches: 0 } };
      }
      if (code > 1) {
        return { content: [{ type: "text", text: `rg failed (exit ${code}):\n${stderr.trim()}` }], details: { error: true } };
      }
      return { content: [{ type: "text", text: truncate(output) }], details: { matches: output.split("\n").length } };
    },
  });

  pi.registerTool({
    name: "fd",
    label: "fd",
    description:
      "Find files and directories by name with fd. Honors .gitignore by default, supports regex patterns, extension and depth filters. Use this instead of shelling out to find or ls -R.",
    promptSnippet: "Find files and directories by name with fd (gitignore-aware).",
    promptGuidelines: ["Prefer fd over bash find when locating files by name or extension."],
    parameters: FD_PARAMS,
    async execute(_id, params, signal, _update, ctx) {
      const cwd = (ctx as any).cwd ?? process.cwd();
      const args = ["--color=never"];
      // fd rejects --strip-cwd-prefix when a path argument is present.
      if (!params.path) args.push("--strip-cwd-prefix");
      if (params.hidden) args.push("--hidden", "--exclude", ".git");
      if (params.kind === "file") args.push("--type", "f");
      if (params.kind === "dir") args.push("--type", "d");
      if (params.extension) args.push("--extension", params.extension.replace(/^\./, ""));
      if (params.maxDepth) args.push("--max-depth", String(Math.max(1, params.maxDepth)));
      const limit = Math.max(1, Math.min(500, params.maxResults ?? 200));
      args.push("--max-results", String(limit));
      if (params.pattern) args.push("--", params.pattern);
      if (params.path) args.push(params.path);

      const { code, stdout, stderr } = await exec("fd", args, cwd, signal);
      const output = stdout.trim();
      if (code > 1) {
        return { content: [{ type: "text", text: `fd failed (exit ${code}):\n${stderr.trim()}` }], details: { error: true } };
      }
      if (!output) {
        return { content: [{ type: "text", text: "No matching files." }], details: { count: 0 } };
      }
      return { content: [{ type: "text", text: truncate(output) }], details: { count: output.split("\n").length } };
    },
  });

  pi.registerTool({
    name: "eza",
    label: "eza",
    description:
      "List a directory with eza: compact, git-aware, and tree-capable. Use this instead of shelling out to ls.",
    promptSnippet: "List directories with eza (sizes, git status, optional tree).",
    promptGuidelines: ["Prefer eza over bash ls when inspecting a directory."],
    parameters: EZA_PARAMS,
    async execute(_id, params, signal, _update, ctx) {
      const cwd = (ctx as any).cwd ?? process.cwd();
      const args = ["--color=never", "--group-directories-first"];
      if (params.all) args.push("--all");
      if (params.tree) {
        args.push("--tree", "--level", String(Math.max(1, Math.min(4, params.depth ?? 2))));
      } else if (params.long !== false) {
        args.push("--long", "--git", "--time-style=iso", "--total-size", "--header");
      }
      if (params.path) args.push(params.path);

      const { stdout, stderr } = await exec("eza", args, cwd, signal);
      const output = stdout.trim();
      if (!output) {
        return { content: [{ type: "text", text: stderr.trim() || "Empty directory." }], details: { empty: true } };
      }
      return { content: [{ type: "text", text: truncate(output) }], details: {} };
    },
  });
}
