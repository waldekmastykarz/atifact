# atifact

Convert agent logs to [ATIF](https://harborframework.com/docs/agents/trajectory-format) trajectories. One command. Zero dependencies.

Turn HAR files and Claude Code logs into standardized [ATIF v1.6](https://github.com/harbor-framework/harbor/blob/main/docs/rfcs/0001-trajectory-format.md) trajectory JSON — ready for debugging, visualization, fine-tuning, and RL pipelines.

## Use with AI agents

Give your AI coding agent the atifact skill so it can extract trajectories on your behalf:

```sh
npx skills add waldekmastykarz/atifact
```

Once installed, ask your agent to _"extract the trajectory from this HAR file"_ or _"convert Claude Code logs to ATIF"_ and it will handle the rest.

## Install

```sh
npm install -g atifact
```

## Quick start

```sh
# Convert a HAR file (auto-detected)
atifact session.har

# Convert Claude Code logs
atifact claude-log.jsonl

# Pipe to stdout
atifact session.har --json | jq '.steps | length'
```

Output: a `.trajectory.json` file in ATIF v1.6 format.

## Supported inputs

| Format | Source | Flag |
|---|---|---|
| HAR | OpenAI Chat Completions API, OpenAI Responses API, Anthropic Messages API | `har` |
| JSONL | Claude Code CLI session logs | `claude-code-jsonl` |

Format is auto-detected from file contents (not extension). Force it with `-f`:

```sh
atifact myfile.log -f claude-code-jsonl
```

## Usage

```
atifact <input-file> [options]
```

| Option | Description |
|---|---|
| `-o, --output <path>` | Output file path (default: `<input>.trajectory.json`) |
| `-f, --format <fmt>` | Force input format: `har`, `claude-code-jsonl` |
| `--json` | Write JSON to stdout instead of file |
| `-q, --quiet` | Suppress progress messages |
| `-h, --help` | Show help |
| `--version` | Print version |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Runtime error (parse failure, I/O error) |
| `2` | Invalid usage (bad arguments, missing file) |

## Output format

atifact produces [ATIF v1.6](https://github.com/harbor-framework/harbor/blob/main/docs/rfcs/0001-trajectory-format.md) JSON with:

- **Steps** — user messages, agent responses, tool calls, and observations
- **Metrics** — token counts, costs, cached tokens per step
- **Tool calls** — structured function name + arguments with observation results
- **Final metrics** — aggregated totals across the trajectory
- All timestamps preserved as ISO 8601 from source data
- Null/undefined fields excluded for compact output

## Examples

### HAR → trajectory

```sh
atifact recording.har -o my-trajectory.json
```

### Claude Code → trajectory, piped

```sh
atifact ~/.claude/projects/*/sessions/*.jsonl --json --quiet > trajectory.json
```

### Count agent steps

```sh
atifact session.har --json | jq '[.steps[] | select(.source == "agent")] | length'
```

## Requirements

- Node.js 22+

## License

[MIT](LICENSE)
