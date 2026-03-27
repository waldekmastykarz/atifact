#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve, basename, extname } from "node:path";
import { createRequire } from "node:module";
import { detectFormat } from "./detect.js";
import { parseHar } from "./parsers/har.js";
import { parseClaudeCode } from "./parsers/claude-code.js";
import type { InputFormat, Trajectory } from "./types.js";

const require = createRequire(import.meta.url);
const { version: VERSION } = require("../../package.json");

interface CliOptions {
  input: string;
  output: string;
  format?: InputFormat;
  json: boolean;
  quiet: boolean;
}

function printHelp(): void {
  const help = `atifact v${VERSION} — Convert agent logs to ATIF-format trajectories

USAGE
  atifact <input-file> [options]
  atifact --help | --version

ARGUMENTS
  <input-file>    Path to the input file (.har or .jsonl)

OPTIONS
  -o, --output <path>   Output file path (default: <input>.trajectory.json)
  -f, --format <fmt>    Force input format: har, claude-code-jsonl
                        (auto-detected if omitted)
      --json            Write JSON output to stdout instead of file
  -q, --quiet           Suppress progress messages (stderr only)
  -h, --help            Show this help
      --version         Print version

SUPPORTED INPUT FORMATS
  har                HAR files with OpenAI (Chat Completions, Responses API)
                     or Anthropic (Messages API) requests
  claude-code-jsonl  Claude Code CLI session logs (.jsonl)

EXAMPLES
  atifact session.har                          Convert, write to session.trajectory.json
  atifact session.har -o out.json              Explicit output path
  atifact session.har --json | jq '.steps | length'   Pipe step count
  atifact session.har --json --quiet           JSON to stdout, no diagnostics
  atifact claude-log.jsonl -f claude-code-jsonl        Force format

JSON OUTPUT SCHEMA (ATIF v1.6)
  {
    "schema_version": "ATIF-v1.6",
    "session_id": "string",
    "agent": { "name": "string", "version": "string", "model_name": "string",
               "tool_definitions": [{ "type": "function", "function": { "name", "description", "parameters" } }] },
    "steps": [{
      "step_id": 1,
      "source": "system | user | agent",
      "timestamp": "ISO 8601 (when available)",
      "message": "string",
      "model_name": "string (agent steps only)",
      "reasoning_effort": "string (agent steps only, e.g. low/medium/high)",
      "reasoning_content": "string (agent thinking/CoT)",
      "tool_calls": [{ "tool_call_id": "string", "function_name": "string", "arguments": {} }],
      "observation": { "results": [{ "source_call_id": "string", "content": "string" }] },
      "metrics": { "prompt_tokens": 0, "completion_tokens": 0, "cached_tokens": 0, "cost_usd": 0.0 }
    }],
    "final_metrics": { "total_prompt_tokens": 0, "total_completion_tokens": 0,
                       "total_cached_tokens": 0, "total_cost_usd": 0.0, "total_steps": 0 },
    "notes": "string"
  }

OUTPUT
  Primary output (ATIF JSON) goes to file or stdout (--json).
  Diagnostics and progress go to stderr.

EXIT CODES
  0  Success
  1  Runtime error (parse failure, I/O error)
  2  Invalid usage (bad arguments, missing file)

NOTES
  Format auto-detection inspects file contents, not extension.
  HAR files may contain multiple API formats (OpenAI + Anthropic); all are parsed.
  Multi-turn HAR conversations are deduplicated (each request carries full history).
  Utility calls (e.g. gpt-4o-mini title generation) are excluded from the trajectory.
  Tool results from request N are attached as observations to the agent step from request N-1.
  Output excludes null/undefined fields for compact JSON.
  All timestamps are preserved from source data as-is (ISO 8601).
`;
  process.stderr.write(help);
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  let input = "";
  let output = "";
  let format: InputFormat | undefined;
  let json = false;
  let quiet = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--version") {
      process.stdout.write(`${VERSION}\n`);
      process.exit(0);
    }

    if (arg === "-o" || arg === "--output") {
      output = args[++i];
      if (!output) {
        process.stderr.write("Error: --output requires a path argument\n");
        process.exit(2);
      }
      continue;
    }

    if (arg === "-f" || arg === "--format") {
      const fmt = args[++i];
      if (!fmt || !["har", "claude-code-jsonl"].includes(fmt)) {
        process.stderr.write(
          `Error: Invalid format "${fmt || ""}". Valid values: har, claude-code-jsonl\n`
        );
        process.exit(2);
      }
      format = fmt as InputFormat;
      continue;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "-q" || arg === "--quiet") {
      quiet = true;
      continue;
    }

    if (arg.startsWith("-")) {
      process.stderr.write(`Error: Unknown option "${arg}"\n`);
      process.exit(2);
    }

    if (!input) {
      input = arg;
    } else {
      process.stderr.write(
        `Error: Unexpected argument "${arg}". Only one input file is supported.\n`
      );
      process.exit(2);
    }
  }

  if (!input) {
    process.stderr.write("Error: Missing required <input-file> argument\n\n");
    printHelp();
    process.exit(2);
  }

  if (!output && !json) {
    // Default output filename
    const base = basename(input, extname(input));
    output = resolve(process.cwd(), `${base}.trajectory.json`);
  }

  return { input: resolve(input), output, format, json, quiet };
}

function log(quiet: boolean, message: string): void {
  if (!quiet) {
    process.stderr.write(`${message}\n`);
  }
}

function stripUndefined(obj: unknown): unknown {
  if (obj === null || obj === undefined) return undefined;
  if (Array.isArray(obj)) {
    return obj.map(stripUndefined).filter((v) => v !== undefined);
  }
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const stripped = stripUndefined(value);
      if (stripped !== undefined) {
        result[key] = stripped;
      }
    }
    return result;
  }
  return obj;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);

  // Verify input file exists
  try {
    await readFile(opts.input, { flag: "r" });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      process.stderr.write(`Error: File not found: ${opts.input}\n`);
    } else if (code === "EACCES") {
      process.stderr.write(
        `Error: Permission denied reading: ${opts.input}\n`
      );
    } else {
      process.stderr.write(`Error: Cannot read file: ${opts.input}\n`);
    }
    process.exit(1);
  }

  // Detect or use forced format
  let inputFormat = opts.format;
  if (!inputFormat) {
    log(opts.quiet, "Detecting input format...");
    const detected = await detectFormat(opts.input);
    inputFormat = detected.format;
    log(opts.quiet, `Detected: ${detected.description}`);
  }

  // Parse
  log(opts.quiet, `Parsing ${inputFormat}...`);
  let trajectory: Trajectory;

  try {
    switch (inputFormat) {
      case "har":
        trajectory = await parseHar(opts.input);
        break;
      case "claude-code-jsonl":
        trajectory = await parseClaudeCode(opts.input);
        break;
      default:
        process.stderr.write(
          `Error: Unsupported format "${inputFormat}"\n`
        );
        process.exit(1);
        return;
    }
  } catch (err) {
    process.stderr.write(
      `Error: Failed to parse ${inputFormat}: ${(err as Error).message}\n`
    );
    process.exit(1);
    return;
  }

  const cleaned = stripUndefined(trajectory);
  const jsonOutput = JSON.stringify(cleaned, null, 2);

  // Output
  if (opts.json) {
    process.stdout.write(jsonOutput);
    process.stdout.write("\n");
  } else {
    await writeFile(opts.output, jsonOutput + "\n", "utf-8");
    log(opts.quiet, `Wrote ${opts.output}`);
  }

  log(
    opts.quiet,
    `Done. ${trajectory.steps.length} steps, ` +
      `${trajectory.steps.filter((s) => s.source === "agent").length} agent turns`
  );
}

main().catch((err) => {
  process.stderr.write(`Error: ${(err as Error).message}\n`);
  process.exit(1);
});
