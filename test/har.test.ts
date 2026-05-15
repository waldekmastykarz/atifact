import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHar } from "../src/parsers/har.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..", "..");
const fixture = (name: string) => resolve(projectRoot, "test", "fixtures", name);

describe("parseHar — Anthropic Messages API", () => {
  it("produces a valid ATIF trajectory", async () => {
    const { trajectory: t } = await parseHar(fixture("har-anthropic.har"));
    assert.equal(t.schema_version, "ATIF-v1.7");
    assert.equal(t.session_id, "req-har-001");
  });

  it("extracts system prompt", async () => {
    const { trajectory: t } = await parseHar(fixture("har-anthropic.har"));
    const system = t.steps.find((s) => s.source === "system");
    assert.ok(system);
    assert.equal(system!.message, "You are a helpful assistant.");
  });

  it("extracts user message", async () => {
    const { trajectory: t } = await parseHar(fixture("har-anthropic.har"));
    const user = t.steps.find((s) => s.source === "user");
    assert.ok(user);
    assert.equal(user!.message, "Hello, what is 2+2?");
  });

  it("extracts agent response from SSE events", async () => {
    const { trajectory: t } = await parseHar(fixture("har-anthropic.har"));
    const agent = t.steps.find((s) => s.source === "agent");
    assert.ok(agent);
    assert.equal(agent!.message, "2+2 equals 4.");
    assert.equal(agent!.model_name, "claude-sonnet-4-20250514");
  });

  it("extracts tool definitions from request", async () => {
    const { trajectory: t } = await parseHar(fixture("har-anthropic.har"));
    assert.ok(t.agent.tool_definitions);
    assert.equal(t.agent.tool_definitions!.length, 1);
    assert.equal(t.agent.tool_definitions![0].function.name, "calculator");
  });

  it("extracts metrics from SSE usage events", async () => {
    const { trajectory: t } = await parseHar(fixture("har-anthropic.har"));
    const agent = t.steps.find((s) => s.source === "agent")!;
    assert.ok(agent.metrics);
    assert.equal(agent.metrics!.prompt_tokens, 50);
    assert.equal(agent.metrics!.completion_tokens, 10);
  });

  it("numbers steps sequentially", async () => {
    const { trajectory: t } = await parseHar(fixture("har-anthropic.har"));
    const ids = t.steps.map((s) => s.step_id);
    for (let i = 0; i < ids.length; i++) {
      assert.equal(ids[i], i + 1);
    }
  });
});

describe("parseHar — OpenAI Responses API", () => {
  it("produces a valid ATIF trajectory", async () => {
    const { trajectory: t } = await parseHar(fixture("har-openai-responses.har"));
    assert.equal(t.schema_version, "ATIF-v1.7");
  });

  it("extracts editor version from headers", async () => {
    const { trajectory: t } = await parseHar(fixture("har-openai-responses.har"));
    assert.equal(t.agent.version, "copilot-1.0.0");
  });

  it("extracts system prompt", async () => {
    const { trajectory: t } = await parseHar(fixture("har-openai-responses.har"));
    const system = t.steps.find((s) => s.source === "system");
    assert.ok(system);
    assert.equal(system!.message, "You are a coding assistant.");
  });

  it("extracts agent response", async () => {
    const { trajectory: t } = await parseHar(fixture("har-openai-responses.har"));
    const agent = t.steps.find((s) => s.source === "agent");
    assert.ok(agent);
    assert.ok((agent!.message as string).includes("Hello, World!"));
  });

  it("extracts reasoning effort", async () => {
    const { trajectory: t } = await parseHar(fixture("har-openai-responses.har"));
    const agent = t.steps.find((s) => s.source === "agent");
    assert.ok(agent);
    assert.equal(agent!.reasoning_effort, "high");
  });

  it("extracts tool definitions", async () => {
    const { trajectory: t } = await parseHar(fixture("har-openai-responses.har"));
    assert.ok(t.agent.tool_definitions);
    assert.equal(t.agent.tool_definitions![0].function.name, "run_code");
  });

  it("extracts metrics with cached tokens", async () => {
    const { trajectory: t } = await parseHar(fixture("har-openai-responses.har"));
    const agent = t.steps.find((s) => s.source === "agent")!;
    assert.ok(agent.metrics);
    assert.equal(agent.metrics!.prompt_tokens, 30);
    assert.equal(agent.metrics!.completion_tokens, 20);
    assert.equal(agent.metrics!.cached_tokens, 5);
  });
});

describe("parseHar — OpenAI Chat Completions", () => {
  it("produces a valid ATIF trajectory", async () => {
    const { trajectory: t } = await parseHar(fixture("har-openai-chat.har"));
    assert.equal(t.schema_version, "ATIF-v1.7");
  });

  it("extracts system prompt", async () => {
    const { trajectory: t } = await parseHar(fixture("har-openai-chat.har"));
    const system = t.steps.find((s) => s.source === "system");
    assert.ok(system);
    assert.equal(system!.message, "You are helpful.");
  });

  it("extracts user message", async () => {
    const { trajectory: t } = await parseHar(fixture("har-openai-chat.har"));
    const user = t.steps.find((s) => s.source === "user");
    assert.ok(user);
    assert.equal(user!.message, "Say hi");
  });

  it("extracts agent response from streaming deltas", async () => {
    const { trajectory: t } = await parseHar(fixture("har-openai-chat.har"));
    const agent = t.steps.find((s) => s.source === "agent");
    assert.ok(agent);
    assert.equal(agent!.message, "Hi there!");
  });

  it("extracts metrics", async () => {
    const { trajectory: t } = await parseHar(fixture("har-openai-chat.har"));
    const agent = t.steps.find((s) => s.source === "agent")!;
    assert.ok(agent.metrics);
    assert.equal(agent.metrics!.prompt_tokens, 15);
    assert.equal(agent.metrics!.completion_tokens, 5);
  });

  it("computes final metrics", async () => {
    const { trajectory: t } = await parseHar(fixture("har-openai-chat.har"));
    assert.ok(t.final_metrics);
    assert.equal(t.final_metrics!.total_prompt_tokens, 15);
    assert.equal(t.final_metrics!.total_completion_tokens, 5);
  });
});

describe("parseHar — multi-turn deduplication", () => {
  it("emits system prompt only once across exchanges", async () => {
    const { trajectory: t } = await parseHar(fixture("har-anthropic-multiturn.har"));
    const systemSteps = t.steps.filter((s) => s.source === "system");
    assert.equal(systemSteps.length, 1);
    assert.equal(systemSteps[0].message, "You are a helpful assistant.");
  });

  it("extracts the initial user message from first exchange", async () => {
    const { trajectory: t } = await parseHar(fixture("har-anthropic-multiturn.har"));
    const userSteps = t.steps.filter((s) => s.source === "user");
    assert.ok(userSteps.length >= 1);
    assert.equal(userSteps[0].message, "List files in the project");
  });

  it("extracts tool calls from first agent response", async () => {
    const { trajectory: t } = await parseHar(fixture("har-anthropic-multiturn.har"));
    const agentSteps = t.steps.filter((s) => s.source === "agent");
    assert.ok(agentSteps[0].tool_calls);
    assert.equal(agentSteps[0].tool_calls![0].function_name, "list_files");
    assert.equal(agentSteps[0].tool_calls![0].tool_call_id, "toolu_call_01");
  });

  it("attaches tool results from exchange N to agent step from exchange N-1", async () => {
    const { trajectory: t } = await parseHar(fixture("har-anthropic-multiturn.har"));
    const agentSteps = t.steps.filter((s) => s.source === "agent");
    // First agent step should have observations from second exchange
    assert.ok(agentSteps[0].observation);
    assert.equal(agentSteps[0].observation!.results.length, 1);
    assert.equal(agentSteps[0].observation!.results[0].source_call_id, "toolu_call_01");
    assert.ok(
      (agentSteps[0].observation!.results[0].content as string).includes("README.md")
    );
  });

  it("does not attach replayed tool results to agent steps without matching tool calls", async () => {
    const { trajectory: t } = await parseHar(fixture("har-anthropic-multiturn.har"));
    const agentSteps = t.steps.filter((s) => s.source === "agent");
    // Second agent step has no tool_calls — it must not get observations
    // from replayed history containing toolu_call_01
    assert.equal(agentSteps[1].tool_calls, undefined);
    assert.equal(agentSteps[1].observation, undefined);
    // Third agent step also has no tool_calls
    assert.equal(agentSteps[2].tool_calls, undefined);
    assert.equal(agentSteps[2].observation, undefined);
  });

  it("extracts new user message from third exchange", async () => {
    const { trajectory: t } = await parseHar(fixture("har-anthropic-multiturn.har"));
    const userSteps = t.steps.filter((s) => s.source === "user");
    // Only genuinely new user messages should appear — no duplicates
    assert.equal(userSteps.length, 2);
    assert.equal(userSteps[0].message, "List files in the project");
    assert.equal(userSteps[1].message, "Now show me the README");
  });

  it("produces correct step count and order", async () => {
    const { trajectory: t } = await parseHar(fixture("har-anthropic-multiturn.har"));
    // Deduplicated: exchange 2 has no new user message (just tool results)
    const sources = t.steps.map((s) => s.source);
    assert.deepEqual(sources, ["system", "user", "agent", "agent", "user", "agent"]);
  });

  it("numbers steps sequentially", async () => {
    const { trajectory: t } = await parseHar(fixture("har-anthropic-multiturn.har"));
    const ids = t.steps.map((s) => s.step_id);
    for (let i = 0; i < ids.length; i++) {
      assert.equal(ids[i], i + 1);
    }
  });

  it("computes final metrics across all exchanges", async () => {
    const { trajectory: t } = await parseHar(fixture("har-anthropic-multiturn.har"));
    assert.ok(t.final_metrics);
    assert.ok(t.final_metrics!.total_prompt_tokens! > 0);
    assert.ok(t.final_metrics!.total_completion_tokens! > 0);
  });
});

describe("parseHar — utility call filtering", () => {
  it("excludes utility model calls from trajectory steps", async () => {
    const { trajectory: t } = await parseHar(fixture("har-with-utility.har"));
    const agentSteps = t.steps.filter((s) => s.source === "agent");
    // Only the main Anthropic call should produce an agent step
    assert.equal(agentSteps.length, 1);
    assert.equal(agentSteps[0].model_name, "claude-sonnet-4-20250514");
  });

  it("uses the primary (non-utility) model as agent model_name", async () => {
    const { trajectory: t } = await parseHar(fixture("har-with-utility.har"));
    assert.equal(t.agent.model_name, "claude-sonnet-4-20250514");
  });

  it("does not include gpt-4o-mini content in steps", async () => {
    const { trajectory: t } = await parseHar(fixture("har-with-utility.har"));
    for (const step of t.steps) {
      if (step.source === "agent") {
        assert.notEqual(step.model_name, "gpt-4o-mini");
      }
    }
  });
});

describe("parseHar — Anthropic thinking blocks", () => {
  it("extracts reasoning_content from thinking blocks", async () => {
    const { trajectory: t } = await parseHar(fixture("har-anthropic-thinking.har"));
    const agent = t.steps.find((s) => s.source === "agent")!;
    assert.ok(agent.reasoning_content);
    assert.ok(agent.reasoning_content!.includes("345"));
  });

  it("extracts message text separately from thinking", async () => {
    const { trajectory: t } = await parseHar(fixture("har-anthropic-thinking.har"));
    const agent = t.steps.find((s) => s.source === "agent")!;
    assert.equal(agent.message, "15 * 23 = 345");
  });
});

describe("parseHar — OpenAI Chat streaming tool calls", () => {
  it("extracts streaming tool calls from chat completions", async () => {
    const { trajectory: t } = await parseHar(fixture("har-openai-chat-tools.har"));
    const agent = t.steps.find((s) => s.source === "agent")!;
    assert.ok(agent.tool_calls);
    assert.equal(agent.tool_calls!.length, 1);
    assert.equal(agent.tool_calls![0].function_name, "get_weather");
    assert.equal(agent.tool_calls![0].tool_call_id, "call_def");
    assert.deepEqual(agent.tool_calls![0].arguments, { city: "London" });
  });

  it("extracts cached tokens from prompt_tokens_details", async () => {
    const { trajectory: t } = await parseHar(fixture("har-openai-chat-tools.har"));
    const agent = t.steps.find((s) => s.source === "agent")!;
    assert.ok(agent.metrics);
    assert.equal(agent.metrics!.cached_tokens, 10);
  });
});

describe("parseHar — error handling", () => {
  it("throws when HAR has no LLM API calls", async () => {
    await assert.rejects(
      () => parseHar(fixture("har-no-llm-calls.har")),
      { message: /No LLM API calls found/ }
    );
  });
});
