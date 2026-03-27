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
      const t = await parseCopilotCli(fixture("copilot-cli-simple.jsonl"));
      assert.equal(t.schema_version, "ATIF-v1.6");
      assert.equal(t.session_id, "session-xyz-789");
    });

    it("builds the agent from session metadata", async () => {
      const t = await parseCopilotCli(fixture("copilot-cli-simple.jsonl"));
      assert.equal(t.agent.name, "copilot-cli");
      assert.equal(t.agent.model_name, "claude-sonnet-4.6");
    });

    it("extracts user, agent steps in order", async () => {
      const t = await parseCopilotCli(fixture("copilot-cli-simple.jsonl"));
      const sources = t.steps.map((s) => s.source);
      assert.deepEqual(sources, ["user", "agent", "agent"]);
    });

    it("numbers steps sequentially starting from 1", async () => {
      const t = await parseCopilotCli(fixture("copilot-cli-simple.jsonl"));
      const ids = t.steps.map((s) => s.step_id);
      assert.deepEqual(ids, [1, 2, 3]);
    });

    it("extracts user message text", async () => {
      const t = await parseCopilotCli(fixture("copilot-cli-simple.jsonl"));
      const userStep = t.steps.find((s) => s.source === "user")!;
      assert.equal(userStep.message, "List the files in the current directory");
    });

    it("extracts tool calls from assistant messages", async () => {
      const t = await parseCopilotCli(fixture("copilot-cli-simple.jsonl"));
      const agentWithTool = t.steps[1];
      assert.ok(agentWithTool.tool_calls);
      assert.equal(agentWithTool.tool_calls!.length, 1);
      assert.equal(agentWithTool.tool_calls![0].function_name, "bash");
      assert.equal(agentWithTool.tool_calls![0].tool_call_id, "tooluse_abc123");
      assert.deepEqual(agentWithTool.tool_calls![0].arguments, { command: "ls -la" });
    });

    it("attaches observations from tool results", async () => {
      const t = await parseCopilotCli(fixture("copilot-cli-simple.jsonl"));
      const agentWithTool = t.steps[1];
      assert.ok(agentWithTool.observation);
      assert.equal(agentWithTool.observation!.results.length, 1);
      assert.equal(agentWithTool.observation!.results[0].source_call_id, "tooluse_abc123");
      assert.ok(
        (agentWithTool.observation!.results[0].content as string).includes("README.md")
      );
    });

    it("extracts reasoning content", async () => {
      const t = await parseCopilotCli(fixture("copilot-cli-simple.jsonl"));
      const agentStep = t.steps[1];
      assert.equal(
        agentStep.reasoning_content,
        "The user wants to list files. I'll use bash."
      );
    });

    it("accumulates message_delta content for final response", async () => {
      const t = await parseCopilotCli(fixture("copilot-cli-simple.jsonl"));
      const finalStep = t.steps[2];
      assert.ok((finalStep.message as string).includes("Here are the files"));
      assert.ok((finalStep.message as string).includes("README.md"));
    });

    it("extracts metrics from outputTokens", async () => {
      const t = await parseCopilotCli(fixture("copilot-cli-simple.jsonl"));
      const agentStep = t.steps[1];
      assert.ok(agentStep.metrics);
      assert.equal(agentStep.metrics!.completion_tokens, 42);
    });

    it("computes final metrics", async () => {
      const t = await parseCopilotCli(fixture("copilot-cli-simple.jsonl"));
      assert.ok(t.final_metrics);
      assert.equal(t.final_metrics!.total_completion_tokens, 77);
      assert.equal(t.final_metrics!.total_steps, 3);
    });

    it("includes usage data in final_metrics extra", async () => {
      const t = await parseCopilotCli(fixture("copilot-cli-simple.jsonl"));
      assert.ok(t.final_metrics?.extra);
      assert.equal(t.final_metrics!.extra!.premium_requests, 1);
      assert.equal(t.final_metrics!.extra!.total_api_duration_ms, 15000);
      assert.equal(t.final_metrics!.extra!.session_duration_ms, 16000);
    });

    it("preserves timestamps", async () => {
      const t = await parseCopilotCli(fixture("copilot-cli-simple.jsonl"));
      const userStep = t.steps[0];
      assert.equal(userStep.timestamp, "2026-03-27T14:42:09.511Z");
    });
  });
});
