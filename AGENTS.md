# Agents

## ATIF spec version

The canonical source for the current ATIF spec version is the RFC on GitHub:

<https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md>

**Do NOT use** the Harbor docs website (`harborframework.com/docs/agents/trajectory-format`) for version checks — it lags behind the RFC and may show an outdated version.

When updating the ATIF version referenced in this project, update all occurrences across source, tests, and docs:

- `README.md` — version mentions and links
- `src/types.ts` — comment
- `src/index.ts` — help text
- `src/parsers/har.ts` — `schema_version` field
- `src/parsers/claude-code.ts` — `schema_version` field
- `src/parsers/copilot-cli.ts` — `schema_version` field
- `src/parsers/codex-cli.ts` — `schema_version` field
- `test/har.test.ts` — assertions
- `test/cli.test.ts` — assertions
- `test/claude-code.test.ts` — assertions
- `test/copilot-cli.test.ts` — assertions
- `test/codex-cli.test.ts` — assertions
