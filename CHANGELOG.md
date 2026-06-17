# Changelog

## [0.11.0](https://github.com/waldekmastykarz/atifact/compare/v0.10.1...v0.11.0)

### Features

- Add `--utility-model` option to mark utility calls (e.g. title generation) with `extra.utility: true` instead of silently filtering them out. Repeatable flag with no default — all exchanges are included unless explicitly marked.

## [0.10.1](https://github.com/waldekmastykarz/atifact/compare/v0.10.0...v0.10.1)

### Bug Fixes

- Report a HAR trajectory's `agent.model_name` as the model the user selected (a specific model, or `auto` when model routing is used) instead of the most-used model

## [0.10.0](https://github.com/waldekmastykarz/atifact/compare/v0.9.0...v0.10.0)

### Features

- Extract trajectories from WebSocket exchanges in HAR files
- Capture Copilot model routing decisions as a system step in HAR trajectories

## [0.9.0](https://github.com/waldekmastykarz/atifact/compare/v0.8.0...v0.9.0)

### Features

- Capture MCP server and skills discovery from Copilot CLI logs in `agent.extra`

## [0.8.0](https://github.com/waldekmastykarz/atifact/compare/v0.7.0...v0.8.0)

### Features

- Add Codex CLI JSONL parser (`codex exec --json` logs)

## [0.7.0](https://github.com/waldekmastykarz/atifact/compare/v0.6.4...v0.7.0)

### Features

- Upgrade to ATIF v1.7 trajectory format

## [0.6.4](https://github.com/waldekmastykarz/atifact/compare/v0.6.3...v0.6.4)

### Bug Fixes

- Fix Claude Code JSONL detection failing when the file starts with non-init lines (e.g. `rate_limit_event`)

## [0.6.3](https://github.com/waldekmastykarz/atifact/compare/v0.6.2...v0.6.3)

### Bug Fixes

- Fix HAR parser attaching replayed tool results to agent steps that don't own those tool calls

## [0.6.2](https://github.com/waldekmastykarz/atifact/compare/v0.6.1...v0.6.2)

### Bug Fixes

- Fix overly broad utility call filtering that could discard legitimate OpenAI Chat API exchanges

## [0.6.1](https://github.com/waldekmastykarz/atifact/compare/v0.6.0...v0.6.1)

### Bug Fixes

- Fix ATIF trajectory format spec link

## [0.6.0](https://github.com/waldekmastykarz/atifact/compare/v0.5.0...v0.6.0)

### Features

- Extract token usage metrics from Copilot CLI session shutdown events

### Bug Fixes

- Correctly extract session ID from Copilot CLI session start events

## [0.5.0](https://github.com/waldekmastykarz/atifact/compare/v0.4.0...v0.5.0)

### Breaking Changes

- `--json` now outputs a JSON array of trajectories (main first, subagents after) instead of a single object

### Features

- `--json` mode writes no files — pure stdout output
- Subagent trajectories included in `--json` array output

## [0.4.0](https://github.com/waldekmastykarz/atifact/compare/v0.3.0...v0.4.0)

### Features

- Subagent trajectory support for Copilot CLI logs

## [0.3.0](https://github.com/waldekmastykarz/atifact/compare/v0.2.0...v0.3.0)

### Features

- Model fallback logic for Copilot CLI parser

## [0.2.0](https://github.com/waldekmastykarz/atifact/compare/v0.1.0...v0.2.0)

### Features

- Parse Copilot CLI JSONL output into ATIF trajectories

## [0.1.0](https://github.com/waldekmastykarz/atifact/releases/tag/v0.1.0)

Initial release.

### Features

- Parse HAR files from OpenAI and Anthropic APIs into ATIF trajectories
- Parse Claude Code CLI JSONL logs into ATIF trajectories
- Auto-detect input format
