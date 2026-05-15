import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCopilotCli } from "../src/parsers/copilot-cli.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..", "..");
const fixture = (name: string) => resolve(projectRoot, "test", "fixtures", name);

describe("parseCopilotCli", () => {
  describe("simple conversation", () => {
    it("produces a valid ATIF trajectory", async () => {
      const { trajectory: t } = await parseCopilotCli(fixture("copilot-cli-simple.jsonl"));
      assert.equal(t.schema_version, "ATIF-v1.7");
      assert.equal(t.session_id, "session-xyz-789");
    });

    it("builds the agent from session metadata", async () => {
      const { trajectory: t } = await parseCopilotCli(fixture("copilot-cli-simple.jsonl"));
      assert.equal(t.agent.name, "copilot-cli");
      assert.equal(t.agent.model_name, "claude-sonnet-4.6");
    });

    it("extracts user, agent steps in order", async () => {
      const { trajectory: t } = await parseCopilotCli(fixture("copilot-cli-simple.jsonl"));
      const sources = t.steps.map((s) => s.source);
      assert.deepEqual(sources, ["user", "agent", "agent"]);
    });

    it("numbers steps sequentially starting from 1", async () => {
      const { trajectory: t } = await parseCopilotCli(fixture("copilot-cli-simple.jsonl"));
      const ids = t.steps.map((s) => s.step_id);
      assert.deepEqual(ids, [1, 2, 3]);
    });

    it("extracts user message text", async () => {
      const { trajectory: t } = await parseCopilotCli(fixture("copilot-cli-simple.jsonl"));
      const userStep = t.steps.find((s) => s.source === "user")!;
      assert.equal(userStep.message, "List the files in the current directory");
    });

    it("extracts tool calls from assistant messages", async () => {
      const { trajectory: t } = await parseCopilotCli(fixture("copilot-cli-simple.jsonl"));
      const agentWithTool = t.steps[1];
      assert.ok(agentWithTool.tool_calls);
      assert.equal(agentWithTool.tool_calls!.length, 1);
      assert.equal(agentWithTool.tool_calls![0].function_name, "bash");
      assert.equal(agentWithTool.tool_calls![0].tool_call_id, "tooluse_abc123");
      assert.deepEqual(agentWithTool.tool_calls![0].arguments, { command: "ls -la" });
    });

    it("attaches observations from tool results", async () => {
      const { trajectory: t } = await parseCopilotCli(fixture("copilot-cli-simple.jsonl"));
      const agentWithTool = t.steps[1];
      assert.ok(agentWithTool.observation);
      assert.equal(agentWithTool.observation!.results.length, 1);
      assert.equal(agentWithTool.observation!.results[0].source_call_id, "tooluse_abc123");
      assert.ok(
        (agentWithTool.observation!.results[0].content as string).includes("README.md")
      );
    });

    it("extracts reasoning content", async () => {
      const { trajectory: t } = await parseCopilotCli(fixture("copilot-cli-simple.jsonl"));
      const agentStep = t.steps[1];
      assert.equal(
        agentStep.reasoning_content,
        "The user wants to list files. I'll use bash."
      );
    });

    it("accumulates message_delta content for final response", async () => {
      const { trajectory: t } = await parseCopilotCli(fixture("copilot-cli-simple.jsonl"));
      const finalStep = t.steps[2];
      assert.ok((finalStep.message as string).includes("Here are the files"));
      assert.ok((finalStep.message as string).includes("README.md"));
    });

    it("extracts metrics from outputTokens", async () => {
      const { trajectory: t } = await parseCopilotCli(fixture("copilot-cli-simple.jsonl"));
      const agentStep = t.steps[1];
      assert.ok(agentStep.metrics);
      assert.equal(agentStep.metrics!.completion_tokens, 42);
    });

    it("computes final metrics", async () => {
      const { trajectory: t } = await parseCopilotCli(fixture("copilot-cli-simple.jsonl"));
      assert.ok(t.final_metrics);
      assert.equal(t.final_metrics!.total_completion_tokens, 77);
      assert.equal(t.final_metrics!.total_steps, 3);
    });

    it("includes usage data in final_metrics extra", async () => {
      const { trajectory: t } = await parseCopilotCli(fixture("copilot-cli-simple.jsonl"));
      assert.ok(t.final_metrics?.extra);
      assert.equal(t.final_metrics!.extra!.premium_requests, 1);
      assert.equal(t.final_metrics!.extra!.total_api_duration_ms, 15000);
      assert.equal(t.final_metrics!.extra!.session_duration_ms, 16000);
    });

    it("preserves timestamps", async () => {
      const { trajectory: t } = await parseCopilotCli(fixture("copilot-cli-simple.jsonl"));
      const userStep = t.steps[0];
      assert.equal(userStep.timestamp, "2026-03-27T14:42:09.511Z");
    });
  });

  describe("model fallback from tool.execution_complete", () => {
    it("uses model from tool.execution_complete when session.tools_updated is missing", async () => {
      const { trajectory: t } = await parseCopilotCli(fixture("copilot-cli-no-tools-updated.jsonl"));
      assert.equal(t.agent.model_name, "claude-opus-4.6-1m");
    });

    it("sets model_name on agent steps", async () => {
      const { trajectory: t } = await parseCopilotCli(fixture("copilot-cli-no-tools-updated.jsonl"));
      const agentSteps = t.steps.filter((s) => s.source === "agent");
      for (const step of agentSteps) {
        assert.equal(step.model_name, "claude-opus-4.6-1m");
      }
    });
  });

  describe("subagent support", () => {
    it("excludes subagent messages from main trajectory steps", async () => {
      const { trajectory: t } = await parseCopilotCli(fixture("copilot-cli-subagent.jsonl"));
      const sources = t.steps.map((s) => s.source);
      assert.deepEqual(sources, ["user", "agent", "agent"]);
    });

    it("uses main agent model, not subagent model", async () => {
      const { trajectory: t } = await parseCopilotCli(fixture("copilot-cli-subagent.jsonl"));
      assert.equal(t.agent.model_name, "claude-opus-4.6-1m");
      const agentSteps = t.steps.filter((s) => s.source === "agent");
      for (const step of agentSteps) {
        assert.equal(step.model_name, "claude-opus-4.6-1m");
      }
    });

    it("attaches subagent_trajectory_ref on task tool call observations", async () => {
      const { trajectory: t } = await parseCopilotCli(fixture("copilot-cli-subagent.jsonl"));
      const agentStep = t.steps[1]; // step with task + bash tool calls
      assert.ok(agentStep.observation);
      const taskObs = agentStep.observation!.results.find(
        (r) => r.source_call_id === "task_explore_001"
      );
      assert.ok(taskObs);
      assert.ok(taskObs!.subagent_trajectory_ref);
      assert.equal(taskObs!.subagent_trajectory_ref!.length, 1);
      assert.equal(
        taskObs!.subagent_trajectory_ref![0].trajectory_id,
        "task_explore_001"
      );
      assert.ok(
        taskObs!.subagent_trajectory_ref![0].session_id!.includes("explore-files")
      );
    });

    it("includes subagent model in trajectory ref extra", async () => {
      const { trajectory: t, subagentTrajectories } = await parseCopilotCli(fixture("copilot-cli-subagent.jsonl"));
      assert.ok(subagentTrajectories);
      const sub = subagentTrajectories!.get("task_explore_001")!;
      assert.equal(sub.agent.model_name, "gpt-5.4-mini");
    });

    it("still attaches regular tool observations on the same step", async () => {
      const { trajectory: t } = await parseCopilotCli(fixture("copilot-cli-subagent.jsonl"));
      const agentStep = t.steps[1];
      const bashObs = agentStep.observation!.results.find(
        (r) => r.source_call_id === "tool_main_001"
      );
      assert.ok(bashObs);
      assert.equal(bashObs!.content, "/home/user/project");
      assert.equal(bashObs!.subagent_trajectory_ref, undefined);
    });

    it("returns subagent trajectories separately", async () => {
      const { subagentTrajectories } = await parseCopilotCli(fixture("copilot-cli-subagent.jsonl"));
      assert.ok(subagentTrajectories);
      assert.equal(subagentTrajectories!.size, 1);
      assert.ok(subagentTrajectories!.has("task_explore_001"));
    });

    it("builds subagent trajectory with correct model and steps", async () => {
      const { subagentTrajectories } = await parseCopilotCli(fixture("copilot-cli-subagent.jsonl"));
      const sub = subagentTrajectories!.get("task_explore_001")!;
      assert.equal(sub.agent.model_name, "gpt-5.4-mini");
      assert.equal(sub.steps.length, 2);
      assert.equal(sub.steps[0].step_id, 1);
      assert.equal(sub.steps[1].step_id, 2);
    });

    it("sets trajectory_id on subagent trajectories", async () => {
      const { subagentTrajectories } = await parseCopilotCli(fixture("copilot-cli-subagent.jsonl"));
      const sub = subagentTrajectories!.get("task_explore_001")!;
      assert.equal(sub.trajectory_id, "task_explore_001");
    });

    it("does not return subagentTrajectories when none exist", async () => {
      const { subagentTrajectories } = await parseCopilotCli(fixture("copilot-cli-simple.jsonl"));
      assert.equal(subagentTrajectories, undefined);
    });
  });

  describe("session_id extraction", () => {
    it("extracts session_id from result event", async () => {
      const { trajectory: t } = await parseCopilotCli(fixture("copilot-cli-simple.jsonl"));
      assert.equal(t.session_id, "session-xyz-789");
    });

    it("falls back to session.start when result event is missing", async () => {
      const { trajectory: t } = await parseCopilotCli(fixture("copilot-cli-no-result.jsonl"));
      assert.equal(t.session_id, "start-only-session-001");
    });
  });

  describe("session.shutdown token extraction", () => {
    it("extracts total_prompt_tokens from modelMetrics", async () => {
      const { trajectory: t } = await parseCopilotCli(fixture("copilot-cli-shutdown.jsonl"));
      // (15000 + 12000) + (3000 + 1500) = 31500
      assert.equal(t.final_metrics!.total_prompt_tokens, 31500);
    });

    it("extracts total_completion_tokens from modelMetrics", async () => {
      const { trajectory: t } = await parseCopilotCli(fixture("copilot-cli-shutdown.jsonl"));
      // 80 + 200 = 280
      assert.equal(t.final_metrics!.total_completion_tokens, 280);
    });

    it("extracts total_cached_tokens from modelMetrics", async () => {
      const { trajectory: t } = await parseCopilotCli(fixture("copilot-cli-shutdown.jsonl"));
      // 12000 + 1500 = 13500
      assert.equal(t.final_metrics!.total_cached_tokens, 13500);
    });

    it("prefers result usage for extra metadata when both exist", async () => {
      const { trajectory: t } = await parseCopilotCli(fixture("copilot-cli-shutdown.jsonl"));
      assert.ok(t.final_metrics?.extra);
      assert.equal(t.final_metrics!.extra!.premium_requests, 2);
      assert.equal(t.final_metrics!.extra!.total_api_duration_ms, 5500);
      assert.equal(t.final_metrics!.extra!.session_duration_ms, 10000);
    });

    it("falls back to step-level metrics when session.shutdown is missing", async () => {
      const { trajectory: t } = await parseCopilotCli(fixture("copilot-cli-simple.jsonl"));
      // No session.shutdown, so total_prompt_tokens comes from steps (which have none)
      assert.equal(t.final_metrics!.total_prompt_tokens, undefined);
      assert.equal(t.final_metrics!.total_completion_tokens, 77);
    });
  });
});
