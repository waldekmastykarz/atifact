# atifact

Convert agent logs to [ATIF](https://harborframework.com/docs/agents/trajectory-format) trajectories. One command. Zero dependencies.

Turn HAR files, Claude Code logs, and Copilot CLI logs into standardized [ATIF v1.6](https://github.com/harbor-framework/harbor/blob/main/docs/rfcs/0001-trajectory-format.md) trajectory JSON — ready for debugging, visualization, fine-tuning, and RL pipelines.

## Use with AI agents

Give your AI coding agent the atifact skill so it can extract trajectories on your behalf:

```sh
npx skills add waldekmastykarz/atifact
```

Once installed, ask your agent to _"extract the trajectory from this HAR file"_, _"convert Claude Code logs to ATIF"_, or _"convert Copilot CLI logs"_ and it will handle the rest.

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

# Convert Copilot CLI logs
atifact copilot-session.jsonl

# Pipe to stdout (returns JSON array of trajectories)
atifact session.har --json | jq '.[0].steps | length'
```

Output: `<input>.trajectory.json` in ATIF v1.6 format. Copilot CLI logs with subagents produce additional `<input>.trajectory.<name>.json` files.

`--json` mode outputs a JSON array of all trajectories (main first, then subagents) to stdout with no files written.

## Supported inputs

| Format | Source | Flag |
|---|---|---|
| HAR | OpenAI Chat Completions API, OpenAI Responses API, Anthropic Messages API | `har` |
| JSONL | Claude Code CLI session logs | `claude-code-jsonl` |
| JSONL | Copilot CLI session logs | `copilot-cli-jsonl` |

Format is auto-detected from file contents (not extension). Force it with `-f`:

```sh
atifact myfile.log -f claude-code-jsonl
atifact myfile.log -f copilot-cli-jsonl
```

## Usage

```
atifact <input-file> [options]
```

| Option | Description |
|---|---|
| `-o, --output <prefix>` | Output path prefix (default: input file path). Main: `<prefix>.trajectory.json`, subagents: `<prefix>.trajectory.<name>.json` |
| `-f, --format <fmt>` | Force input format: `har`, `claude-code-jsonl`, `copilot-cli-jsonl` |
| `--json` | Write JSON array of all trajectories to stdout (no files written) |
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
- **Subagent trajectories** — Copilot CLI subagents (task tool calls) produce separate trajectory files, linked via `subagent_trajectory_ref`
- **Final metrics** — aggregated totals across the trajectory
- All timestamps preserved as ISO 8601 from source data
- Null/undefined fields excluded for compact output

## Examples

### HAR → trajectory

```sh
atifact recording.har -o my-trajectory
# Writes: my-trajectory.trajectory.json
```

### Claude Code → trajectory, piped

```sh
atifact ~/.claude/projects/*/sessions/*.jsonl --json --quiet > trajectory.json
```

### Copilot CLI → trajectory with subagents

```sh
atifact copilot-session.jsonl
# Writes: copilot-session.jsonl.trajectory.json
# Writes: copilot-session.jsonl.trajectory.<subagent-name>.json (per subagent)
```

### Count agent steps

```sh
atifact session.har --json | jq '[.[0].steps[] | select(.source == "agent")] | length'
```

## Requirements

- Node.js 22+

## License

[MIT](LICENSE)
