import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseClaudeCode } from "../src/parsers/claude-code.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..", "..");
const fixture = (name: string) => resolve(projectRoot, "test", "fixtures", name);

describe("parseClaudeCode", () => {
  describe("simple conversation", () => {
    it("produces a valid ATIF trajectory", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-simple.jsonl"));
      assert.equal(t.schema_version, "ATIF-v1.6");
      assert.equal(t.session_id, "sess-abc123");
    });

    it("builds the agent from init line", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-simple.jsonl"));
      assert.equal(t.agent.name, "claude-code");
      assert.equal(t.agent.version, "1.0.0");
      assert.equal(t.agent.model_name, "claude-sonnet-4-20250514");
      assert.deepEqual(t.agent.extra?.tools, ["Read", "Write", "Bash"]);
    });

    it("extracts user, agent, and tool steps in order", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-simple.jsonl"));
      const sources = t.steps.map((s) => s.source);
      assert.deepEqual(sources, ["user", "agent", "agent"]);
    });

    it("numbers steps sequentially starting from 1", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-simple.jsonl"));
      const ids = t.steps.map((s) => s.step_id);
      assert.deepEqual(ids, [1, 2, 3]);
    });

    it("extracts user message text", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-simple.jsonl"));
      const userStep = t.steps.find((s) => s.source === "user")!;
      assert.equal(userStep.message, "What files are in the current directory?");
    });

    it("extracts tool calls from assistant messages", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-simple.jsonl"));
      const agentWithTool = t.steps[1];
      assert.ok(agentWithTool.tool_calls);
      assert.equal(agentWithTool.tool_calls!.length, 1);
      assert.equal(agentWithTool.tool_calls![0].function_name, "Bash");
      assert.equal(agentWithTool.tool_calls![0].tool_call_id, "toolu_001");
      assert.deepEqual(agentWithTool.tool_calls![0].arguments, { command: "ls -la" });
    });

    it("attaches observations from tool results", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-simple.jsonl"));
      const agentWithTool = t.steps[1];
      assert.ok(agentWithTool.observation);
      assert.equal(agentWithTool.observation!.results.length, 1);
      assert.equal(agentWithTool.observation!.results[0].source_call_id, "toolu_001");
      assert.ok(
        (agentWithTool.observation!.results[0].content as string).includes("README.md")
      );
    });

    it("extracts metrics from usage data", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-simple.jsonl"));
      const agentStep = t.steps[1];
      assert.ok(agentStep.metrics);
      assert.equal(agentStep.metrics!.completion_tokens, 50);
      assert.equal(agentStep.metrics!.cached_tokens, 10);
    });

    it("computes final metrics from modelUsage", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-simple.jsonl"));
      assert.ok(t.final_metrics);
      assert.equal(t.final_metrics!.total_cost_usd, 0.005);
      assert.equal(t.final_metrics!.total_steps, 3);
    });
  });

  describe("subagent filtering", () => {
    it("skips subagent (parent_tool_use_id) messages", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-subagent.jsonl"));
      // Should have: user, agent (with tool), agent (final)
      // The subagent message (parent_tool_use_id = "toolu_010") should be skipped
      const agentSteps = t.steps.filter((s) => s.source === "agent");
      // None of the agent steps should be the subagent response
      for (const step of agentSteps) {
        assert.notEqual(step.message, "Subagent response");
      }
    });

    it("includes agents in agent extra when present", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-subagent.jsonl"));
      assert.deepEqual(t.agent.extra?.agents, ["task"]);
    });
  });

  describe("cache creation tokens", () => {
    it("includes cache_creation_input_tokens in prompt_tokens", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-cache-creation.jsonl"));
      const agentStep = t.steps.find(
        (s) => s.source === "agent" && s.tool_calls && s.tool_calls.length > 0
      )!;
      // prompt_tokens = input_tokens(100) + cache_read(20) + cache_creation(50) = 170
      assert.equal(agentStep.metrics!.prompt_tokens, 170);
    });

    it("sets metrics.extra with cache_creation_input_tokens", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-cache-creation.jsonl"));
      const agentStep = t.steps.find(
        (s) => s.source === "agent" && s.tool_calls && s.tool_calls.length > 0
      )!;
      assert.ok(agentStep.metrics!.extra);
      assert.equal(agentStep.metrics!.extra!.cache_creation_input_tokens, 50);
    });

    it("sets cached_tokens from cache_read_input_tokens", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-cache-creation.jsonl"));
      const agentStep = t.steps.find(
        (s) => s.source === "agent" && s.tool_calls && s.tool_calls.length > 0
      )!;
      assert.equal(agentStep.metrics!.cached_tokens, 20);
    });
  });

  describe("final metrics fallback", () => {
    it("sums from steps when modelUsage is absent", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-cache-creation.jsonl"));
      // The fixture has no modelUsage in the result line, so it should sum from steps
      assert.ok(t.final_metrics);
      assert.ok(t.final_metrics!.total_prompt_tokens! > 0);
      assert.ok(t.final_metrics!.total_completion_tokens! > 0);
      assert.equal(t.final_metrics!.total_cost_usd, 0.008);
    });
  });

  describe("error handling", () => {
    it("throws when no init line is found", async () => {
      await assert.rejects(
        () => parseClaudeCode(fixture("claude-code-no-init.jsonl")),
        { message: /No system\/init line found/ }
      );
    });
  });
});
