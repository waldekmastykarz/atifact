import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseVally } from "../src/parsers/vally.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..", "..");
const fixture = resolve(projectRoot, "test", "fixtures", "vally-simple.json");

describe("parseVally", () => {
  it("converts a Vally trajectory to ATIF", async () => {
    const { trajectory, subagentTrajectories } = await parseVally(fixture);

    assert.equal(trajectory.schema_version, "ATIF-v1.8");
    assert.equal(trajectory.session_id, "session-001");
    assert.equal(trajectory.trajectory_id, "trial-001");
    assert.equal(trajectory.agent.name, "copilot-sdk");
    assert.equal(trajectory.agent.model_name, "gpt-5.5");

    assert.equal(trajectory.steps.length, 4);
    assert.equal(trajectory.steps[0].source, "user");
    const agentStep = trajectory.steps[1];
    assert.equal(agentStep.message, "I'll inspect the file.");
    assert.equal(agentStep.reasoning_content, "Inspect the implementation first.");
    assert.equal(agentStep.tool_calls?.[0].function_name, "read_file");
    assert.equal(agentStep.observation?.results.length, 2);
    assert.equal(agentStep.metrics?.prompt_tokens, 100);
    assert.equal(agentStep.metrics?.cache_write_tokens, 5);
    assert.equal(agentStep.llm_call_count, 1);

    assert.equal(trajectory.steps[2].source, "system");
    assert.equal(trajectory.steps[2].message, "Compacted context");
    assert.equal(trajectory.steps[3].message, "Tests added.");
    assert.equal(trajectory.final_metrics?.total_cache_write_tokens, 5);
    assert.equal(
      ((trajectory.extra?.vally as Record<string, unknown>).diff),
      "diff --git a/test.ts b/test.ts"
    );

    assert.equal(subagentTrajectories?.size, 1);
    const subagent = subagentTrajectories?.get("researcher");
    assert.equal(subagent?.steps[0].message, "The implementation is in src/add.ts.");
  });

  it("rejects a non-Vally JSON object", async () => {
    await assert.rejects(
      () => parseVally(resolve(projectRoot, "test", "fixtures", "unknown-format.txt")),
      { message: /Unexpected token|Vally trajectory/ }
    );
  });
});