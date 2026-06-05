# atifact

[![skills.sh](https://skills.sh/b/waldekmastykarz/atifact)](https://skills.sh/waldekmastykarz/atifact)

Convert agent logs to [ATIF](https://harborframework.com/docs/agents/trajectory-format) trajectories. One command. Zero dependencies.

Turn HAR files, Claude Code logs, Copilot CLI logs, and Codex CLI logs into standardized [ATIF v1.7](https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md) trajectory JSON — ready for debugging, visualization, fine-tuning, and RL pipelines.

![A terminal session on a macOS desktop showing the atifact CLI tool in action. Two commands are displayed against a dark background. The first command runs: atifact copilot-cli-subagent.jsonl — the output shows: Detecting input format..., Detected: Copilot CLI logs (JSONL), Parsing copilot-cli-jsonl..., followed by two Wrote lines confirming trajectory files were saved, and a summary: Done. 3 steps, 2 agent turns, 1 subagent trajectories. The second command runs: cat copilot-cli-subagent.jsonl.trajectory.json — showing a JSON object with fields including schema_version: ATIF-v1.7, session_id: session-subagent-001, an agent block with name: copilot-cli, version: 1.0.0, model_name: claude-opus-4.6-1m, and a steps array beginning with step_id: 1, timestamp: 2026-03-25T16:29:11.000Z, source: user, message: Explore the project structure. The status bar at the bottom shows version v24.15.0, the file path, branch main, and a change count of +137. The overall tone is functional and developer-focused.](assets/screenshot.png)

## Use with AI agents

Give your AI coding agent the atifact skill so it can extract trajectories on your behalf:

```sh
npx skills add waldekmastykarz/atifact
```

Once installed, ask your agent to _"extract the trajectory from this HAR file"_, _"convert Claude Code logs to ATIF"_, _"convert Copilot CLI logs"_, or _"convert Codex CLI logs"_ and it will handle the rest.

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

# Convert Codex CLI logs
atifact codex-session.jsonl

# Pipe to stdout (returns JSON array of trajectories)
atifact session.har --json | jq '.steps | length'
```

Output: `<input>.trajectory.json` in ATIF v1.7 format. Copilot CLI and Codex CLI logs with subagents produce additional `<input>.trajectory.<name>.json` files.

`--json` mode outputs a single trajectory with subagents embedded in the `subagent_trajectories` array to stdout with no files written.

## Supported inputs

| Format | Source | Flag |
|---|---|---|
| HAR | OpenAI Chat Completions API, OpenAI Responses API, Anthropic Messages API | `har` |
| JSONL | Claude Code CLI session logs | `claude-code-jsonl` |
| JSONL | Copilot CLI session logs | `copilot-cli-jsonl` |
| JSONL | Codex CLI `exec --json` logs | `codex-cli-jsonl` |

Format is auto-detected from file contents (not extension). Force it with `-f`:

```sh
atifact myfile.log -f claude-code-jsonl
atifact myfile.log -f copilot-cli-jsonl
atifact myfile.log -f codex-cli-jsonl
```

## Usage

```
atifact <input-file> [options]
```

| Option | Description |
|---|---|
| `-o, --output <prefix>` | Output path prefix (default: input file path). Main: `<prefix>.trajectory.json`, subagents: `<prefix>.trajectory.<name>.json` |
| `-f, --format <fmt>` | Force input format: `har`, `claude-code-jsonl`, `copilot-cli-jsonl`, `codex-cli-jsonl` |
| `--json` | Write trajectory to stdout with subagents embedded (no files written) |
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

atifact produces [ATIF v1.7](https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md) JSON with:

- **Steps** — user messages, agent responses, tool calls, and observations
- **Metrics** — token counts, costs, cached tokens per step
- **Tool calls** — structured function name + arguments with observation results
- **Subagent trajectories** — Copilot CLI and Codex CLI subagents produce separate trajectory files linked via `subagent_trajectory_ref` with `trajectory_id` resolution; `--json` mode embeds them in `subagent_trajectories`
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

### Codex CLI → trajectory

```sh
atifact codex-session.jsonl
# Writes: codex-session.jsonl.trajectory.json
```

### Count agent steps

```sh
atifact session.har --json | jq '[.steps[] | select(.source == "agent")] | length'
```

## Requirements

- Node.js 22+

## License

[MIT](LICENSE)