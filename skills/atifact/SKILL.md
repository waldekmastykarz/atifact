---
name: atifact
description: This skill should be used when the user asks to "extract agent trajectory", "convert HAR to trajectory", "get trajectory from session", "parse agent session", "convert Claude Code logs", "convert Copilot CLI logs", "extract ATIF", or needs to convert HAR files or JSONL session logs into ATIF trajectory JSON using the atifact CLI.
---

# Extract Agent Trajectories with atifact

Convert agent session recordings (HAR files, Claude Code JSONL logs, Copilot CLI JSONL logs) into structured ATIF v1.6 trajectory JSON using the `atifact` CLI.

## Prerequisites

Verify the CLI is available:

```bash
command -v atifact
```

If not installed, install globally:

```bash
npm install -g atifact
```

## Supported input formats

| Format | File type | Description |
|--------|-----------|-------------|
| `har` | `.har` | HAR files with OpenAI (Chat Completions, Responses API) or Anthropic (Messages API) requests |
| `claude-code-jsonl` | `.jsonl` | Claude Code CLI session logs |
| `copilot-cli-jsonl` | `.jsonl` | Copilot CLI session logs |

Format is auto-detected from file contents (not extension). Use `--format` / `-f` to force a specific format when auto-detection fails.

## Usage

### Basic conversion

The `--output` / `-o` option takes a **prefix**, not a filename. Output files are derived from the prefix:
- Main trajectory: `<prefix>.trajectory.json`
- Subagent trajectories: `<prefix>.trajectory.<name>.json`

Default prefix is the input file path:

```bash
atifact session.har
# Writes: session.har.trajectory.json
```

### Specify output prefix

```bash
atifact session.har -o out
# Writes: out.trajectory.json
# If subagents exist: out.trajectory.<name>.json
```

### Force input format

Use when auto-detection picks the wrong format for `.jsonl` files:

```bash
atifact session.jsonl -f claude-code-jsonl
atifact session.jsonl -f copilot-cli-jsonl
```

### Pipe JSON to stdout

Use `--json` with `--quiet` to suppress diagnostics and get clean JSON on stdout. Output is a JSON array of all trajectories (main first, then subagents). No files are written.

```bash
atifact session.har --json --quiet
```

Combine with other tools:

```bash
atifact session.har --json --quiet | jq '.[0].steps | length'
```

## CLI options

| Option | Alias | Description |
|--------|-------|-------------|
| `<input-file>` | | Path to the input file (required) |
| `--output` | `-o` | Output path prefix. Main: `<prefix>.trajectory.json`, subagents: `<prefix>.trajectory.<name>.json` (default: input file path) |
| `--format` | `-f` | Force input format: `har`, `claude-code-jsonl`, `copilot-cli-jsonl` |
| `--json` | | Write JSON array of all trajectories to stdout (no files written). First element is main, rest are subagents. |
| `--quiet` | `-q` | Suppress progress messages (stderr only) |

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Runtime error (parse failure, I/O error) |
| 2 | Invalid usage (bad arguments, missing file) |

## Workflow

1. Identify the input file and its format (HAR or JSONL).
2. For `.jsonl` files, determine the source (Claude Code or Copilot CLI) to use the correct `--format` if auto-detection fails.
3. Run `atifact` with the input file. Use `-o` to set the output prefix (e.g., `atifact /path/to/session.har -o /path/to/session`). The main trajectory is written to `<prefix>.trajectory.json`.
4. Report the output file path(s) and key metrics (total steps, total cost) from the generated trajectory.

## Notes

- HAR files may contain multiple API formats (OpenAI + Anthropic); all are parsed.
- Multi-turn HAR conversations are deduplicated (each request carries full history).
- Utility calls (e.g., gpt-4o-mini title generation) are excluded from the trajectory.
- Tool results from request N are attached as observations to the agent step from request N-1.
- Copilot CLI logs with subagent `task` tool calls produce separate trajectory files per subagent. The main trajectory references them via `subagent_trajectory_ref` with `trajectory_path` pointing to the sibling file.
- All timestamps are preserved from source data as-is (ISO 8601).
