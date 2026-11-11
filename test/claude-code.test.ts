import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseClaudeCode, parseClaudeCodeContent } from "../src/parsers/claude-code.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..", "..");
const fixture = (name: string) => resolve(projectRoot, "test", "fixtures", name);

describe("parseClaudeCode", () => {
  describe("simple conversation", () => {
    it("produces a valid ATIF trajectory", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-simple.jsonl"));
      assert.equal(t.schema_version, "ATIF-v1.8");
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

  describe("Agent tool subagents", () => {
    const load = () => parseClaudeCode(fixture("claude-code-agent-tool.jsonl"));

    it("keeps subagent lines out of the root steps", async () => {
      const { trajectory: t } = await load();
      assert.deepEqual(
        t.steps.map((s) => s.source),
        ["user", "agent", "agent", "agent"]
      );
      assert.equal(t.steps.filter((s) => s.source === "user").length, 1);
      const rootCallIds = t.steps.flatMap((s) => s.tool_calls || []).map((tc) => tc.tool_call_id);
      assert.deepEqual(rootCallIds, ["toolu_read_root", "toolu_agent"]);
    });

    it("attaches the Agent tool result and links the subagent trajectory", async () => {
      const { trajectory: t } = await load();
      const agentStep = t.steps[2];
      assert.equal(agentStep.tool_calls![0].function_name, "Agent");
      const result = agentStep.observation!.results[0];
      assert.equal(result.source_call_id, "toolu_agent");
      assert.equal(result.content, "The file contains: hello");
      assert.deepEqual(result.subagent_trajectory_ref, [
        { trajectory_id: "toolu_agent", session_id: "sess-agent789:toolu_agent" },
      ]);
    });

    it("emits the subagent's prompt, tool calls, and results as its own trajectory", async () => {
      const { subagentTrajectories } = await load();
      assert.equal(subagentTrajectories?.size, 1);
      const sub = subagentTrajectories!.get("toolu_agent")!;
      assert.equal(sub.trajectory_id, "toolu_agent");
      assert.equal(sub.agent.name, "general-purpose");
      assert.equal(sub.agent.model_name, "claude-haiku-5-5");
      assert.deepEqual(sub.steps.map((s) => s.source), ["user", "agent", "agent"]);
      assert.equal(sub.steps[0].message, "Read the file /work/a.txt and return its content.");
      assert.equal(sub.steps[1].tool_calls![0].tool_call_id, "toolu_read_sub");
      assert.equal(sub.steps[1].observation!.results[0].content, "1\thello\n2\t");
      assert.equal(sub.steps[2].message, "The file contains: hello");
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

  describe("streamed usage", () => {
    it("uses final output_tokens from message_delta stream events", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-streamed-usage.jsonl"));
      const agentSteps = t.steps.filter((s) => s.source === "agent");
      assert.deepEqual(
        agentSteps.map((s) => s.metrics?.completion_tokens),
        [170, 88]
      );
      assert.equal(agentSteps[1].metrics!.prompt_tokens, 8 + 25523 + 226);
    });

    it("counts streamed usage once when a response spans several lines", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-streamed-usage.jsonl"));
      const total = t.steps.reduce((sum, s) => sum + (s.metrics?.completion_tokens || 0), 0);
      assert.equal(total, 170 + 88);
    });

    it("omits placeholder completion_tokens from message_start usage", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-placeholder-usage.jsonl"));
      const agentSteps = t.steps.filter((s) => s.source === "agent");
      assert.equal(agentSteps.length, 2);
      for (const step of agentSteps) {
        assert.ok(step.metrics);
        assert.equal(step.metrics!.completion_tokens, undefined);
      }
    });

    it("uses result usage for final metrics when modelUsage is absent", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-placeholder-usage.jsonl"));
      assert.equal(t.final_metrics!.total_completion_tokens, 258);
      assert.equal(t.final_metrics!.total_prompt_tokens, 18 + 25523 + 25749);
      assert.equal(t.final_metrics!.total_cached_tokens, 25523);
    });

    it("omits total completion tokens when an interrupted capture has unknown step usage", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-interrupted-usage.jsonl"));
      assert.equal(t.final_metrics!.total_completion_tokens, undefined);
    });

    it("sums known streamed usage when an interrupted capture repeats message IDs", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-streamed-interrupted.jsonl"));
      assert.equal(t.final_metrics!.total_completion_tokens, 170 + 88);
    });

    it("keeps main-agent streamed usage when subagent stream events interleave", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-streamed-subagent.jsonl"));
      const agentSteps = t.steps.filter((s) => s.source === "agent");
      assert.equal(agentSteps[0].metrics!.completion_tokens, 170);
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

  describe("one API response split across lines", () => {
    it("merges lines sharing message.id into one agent step", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-split-message.jsonl"));
      assert.deepEqual(t.steps.map((s) => s.step_id), [1, 2]);
      assert.deepEqual(t.steps.map((s) => s.source), ["agent", "agent"]);
      assert.deepEqual(
        t.steps[0].tool_calls!.map((c) => c.tool_call_id),
        ["toolu_01PE7iTRUEYvRBBX7GYPgZdn", "toolu_02"]
      );
      assert.equal(t.steps[1].message, "Hello.");
    });

    it("attaches tool results from separate lines to the merged step", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-split-message.jsonl"));
      assert.deepEqual(
        t.steps[0].observation!.results.map((r) => r.source_call_id),
        ["toolu_01PE7iTRUEYvRBBX7GYPgZdn", "toolu_02"]
      );
    });

    it("counts each response's usage once", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-split-message.jsonl"));
      assert.equal(t.steps[0].metrics!.prompt_tokens, 25533);
      assert.equal(t.steps[1].metrics!.prompt_tokens, 25757);
      assert.equal(t.final_metrics!.total_prompt_tokens, 51290);
      assert.equal(t.final_metrics!.total_steps, 2);
    });

    it("ignores subagent user lines between blocks of the same response", () => {
      const usage = { input_tokens: 10, output_tokens: 3 };
      const assistant = (content: unknown[]) =>
        JSON.stringify({
          type: "assistant",
          message: { model: "m", id: "msg_1", role: "assistant", content, usage },
          parent_tool_use_id: null,
        });
      const jsonl = [
        JSON.stringify({ type: "system", subtype: "init", session_id: "s", model: "m", tools: [], claude_code_version: "1" }),
        assistant([{ type: "tool_use", id: "toolu_task", name: "Task", input: {} }]),
        JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Subagent prompt" }] }, parent_tool_use_id: "toolu_task" }),
        JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_nested", content: "nested" }] }, parent_tool_use_id: "toolu_task" }),
        assistant([{ type: "text", text: "Done." }]),
        JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_task", content: "ok" }] }, parent_tool_use_id: null }),
      ].join("\n");

      const { trajectory: t } = parseClaudeCodeContent(jsonl);
      assert.equal(t.steps.length, 1);
      assert.equal(t.steps[0].message, "Done.");
      assert.deepEqual(
        t.steps[0].observation!.results.map((r) => r.source_call_id),
        ["toolu_task"]
      );
    });

    it("keeps fallback tool call ids unique across merged lines", () => {
      const assistant = (name: string) =>
        JSON.stringify({
          type: "assistant",
          message: {
            model: "m",
            id: "msg_1",
            role: "assistant",
            content: [{ type: "tool_use", name, input: {} }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          parent_tool_use_id: null,
        });
      const jsonl = [
        JSON.stringify({ type: "system", subtype: "init", session_id: "s", model: "m", tools: [], claude_code_version: "1" }),
        assistant("Read"),
        assistant("Bash"),
      ].join("\n");

      const { trajectory: t } = parseClaudeCodeContent(jsonl);
      assert.deepEqual(
        t.steps[0].tool_calls!.map((c) => c.tool_call_id),
        ["call_0", "call_1"]
      );
    });
  });

  describe("rate_limit_event prefix", () => {
    it("parses when init line is not the first line", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-rate-limit-prefix.jsonl"));
      assert.equal(t.schema_version, "ATIF-v1.8");
      assert.equal(t.session_id, "sess-abc123");
      assert.equal(t.agent.name, "claude-code");
    });

    it("produces the same steps as the simple fixture", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-rate-limit-prefix.jsonl"));
      const sources = t.steps.map((s) => s.source);
      assert.deepEqual(sources, ["user", "agent", "agent"]);
    });
  });

  describe("step timestamps", () => {
    const jsonl = [
      { type: "system", subtype: "init", session_id: "s1", model: "m", tools: [], claude_code_version: "2.1.212" },
      { type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] }, parent_tool_use_id: null, timestamp: "2026-11-11T13:00:11.000Z" },
      { type: "assistant", message: { model: "m", id: "msg_1", role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } }, parent_tool_use_id: null, timestamp: "2026-11-11T13:00:11.934Z" },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "hello" }] }, parent_tool_use_id: null, timestamp: "2026-11-11T13:00:11.947Z" },
      { type: "assistant", message: { model: "m", id: "msg_2", role: "assistant", content: [{ type: "text", text: "Hello." }], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } }, parent_tool_use_id: null, timestamp: "2026-11-11T13:00:13.166Z" },
      { type: "result", subtype: "success", num_turns: 2 },
    ].map((l) => JSON.stringify(l)).join("\n");

    it("sets each step's timestamp from its source line", () => {
      const { trajectory: t } = parseClaudeCodeContent(jsonl);
      assert.deepEqual(
        t.steps.map((s) => s.timestamp),
        ["2026-11-11T13:00:11.000Z", "2026-11-11T13:00:11.934Z", "2026-11-11T13:00:13.166Z"]
      );
    });

    it("omits timestamp when the source line has none", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-simple.jsonl"));
      for (const step of t.steps) assert.equal("timestamp" in step, false);
    });
  });

  describe("thinking blocks", () => {
    it("maps thinking text to reasoning_content", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-thinking.jsonl"));
      const reasoning = t.steps.map((s) => s.reasoning_content).filter(Boolean);
      assert.deepEqual(reasoning, [
        "The user wants me to read a.txt.",
        "The file contains the word hello.",
      ]);
    });

    it("keeps thinking out of the message and alongside text", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-thinking.jsonl"));
      const last = t.steps[t.steps.length - 1];
      assert.equal(last.message, "Hello.");
      assert.equal(last.reasoning_content, "The file contains the word hello.");
    });

    it("omits reasoning_content when there is no thinking", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-simple.jsonl"));
      assert.ok(t.steps.every((s) => s.reasoning_content === undefined));
    });
  });

  describe("tool call results", () => {
    it("marks tool calls with is_error results as failures", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-tool-error.jsonl"));
      const call = t.steps[1].tool_calls!.find((c) => c.tool_call_id === "toolu_missing")!;
      assert.deepEqual(call.extra, { "microsoft.vally": { tool_call_result: "failure" } });
      assert.equal(
        t.steps[1].observation!.results.find((r) => r.source_call_id === "toolu_missing")!.content,
        "File does not exist. Note: your current working directory is /work"
      );
    });

    it("marks tool calls without is_error as successes", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-tool-error.jsonl"));
      const call = t.steps[1].tool_calls!.find((c) => c.tool_call_id === "toolu_ok")!;
      assert.deepEqual(call.extra, { "microsoft.vally": { tool_call_result: "success" } });
    });

    it("records outcomes for results arriving after the step was flushed", async () => {
      const { trajectory: t } = await parseClaudeCode(fixture("claude-code-tool-error-split.jsonl"));
      const calls = new Map(t.steps.flatMap((s) => s.tool_calls ?? []).map((c) => [c.tool_call_id, c]));
      const status = (id: string) =>
        (calls.get(id)!.extra?.["microsoft.vally"] as Record<string, unknown>).tool_call_result;
      // Second result in a separate user message
      assert.equal(status("toolu_a"), "success");
      assert.equal(status("toolu_b"), "failure");
      // Subagent activity precedes the root result
      assert.equal(status("toolu_agent"), "failure");
      assert.ok(!calls.has("toolu_sub"));
    });
  });
});
