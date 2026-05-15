import { readFile } from "node:fs/promises";
import type {
  Trajectory,
  ParseResult,
  Step,
  ToolCall,
  Observation,
  ObservationResult,
  Metrics,
  FinalMetrics,
  Agent,
} from "../types.js";

interface ClaudeCodeInit {
  type: "system";
  subtype: "init";
  session_id: string;
  model: string;
  tools: string[];
  claude_code_version: string;
  cwd?: string;
  agents?: string[];
  skills?: string[];
  [key: string]: unknown;
}

interface ClaudeCodeAssistant {
  type: "assistant";
  message: {
    model: string;
    id: string;
    role: "assistant";
    content: ClaudeContentBlock[];
    stop_reason: string | null;
    usage: ClaudeUsage;
  };
  parent_tool_use_id: string | null;
  session_id: string;
  uuid: string;
}

interface ClaudeContentBlock {
  type: "text" | "tool_use";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  caller?: { type: string };
}

interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  service_tier?: string;
  inference_geo?: string;
}

interface ClaudeCodeUser {
  type: "user";
  message: {
    role: "user";
    content: ClaudeUserContent[];
  };
  tool_use_result?: Record<string, unknown>;
}

interface ClaudeUserContent {
  type: "tool_result" | "text";
  tool_use_id?: string;
  content?: string | { type: string; text: string }[];
  text?: string;
  is_error?: boolean;
}

interface ClaudeCodeResult {
  type: "result";
  subtype: "success" | "error";
  is_error: boolean;
  duration_ms: number;
  duration_api_ms?: number;
  num_turns: number;
  result: string;
  total_cost_usd: number;
  usage?: Record<string, unknown>;
  modelUsage?: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      costUSD: number;
    }
  >;
}

type ClaudeCodeLine =
  | ClaudeCodeInit
  | ClaudeCodeAssistant
  | ClaudeCodeUser
  | ClaudeCodeResult
  | { type: string; [key: string]: unknown };

export async function parseClaudeCode(filePath: string): Promise<ParseResult> {
  const raw = await readFile(filePath, "utf-8");
  const lines = raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as ClaudeCodeLine);

  const initLine = lines.find(
    (l) => l.type === "system" && (l as ClaudeCodeInit).subtype === "init"
  ) as ClaudeCodeInit | undefined;

  const resultLine = lines.find(
    (l) => l.type === "result"
  ) as ClaudeCodeResult | undefined;

  if (!initLine) {
    throw new Error("No system/init line found in Claude Code JSONL");
  }

  const agent = buildAgent(initLine);
  const steps = buildSteps(lines);
  const finalMetrics = buildFinalMetrics(resultLine, steps);

  return {
    trajectory: {
      schema_version: "ATIF-v1.7",
      session_id: initLine.session_id,
      agent,
      steps,
      final_metrics: finalMetrics,
      notes: `Converted from Claude Code CLI logs: ${filePath}`,
    },
  };
}

function buildAgent(init: ClaudeCodeInit): Agent {
  return {
    name: "claude-code",
    version: init.claude_code_version,
    model_name: init.model,
    extra: {
      tools: init.tools,
      ...(init.agents ? { agents: init.agents } : {}),
      ...(init.skills ? { skills: init.skills } : {}),
    },
  };
}

function buildSteps(lines: ClaudeCodeLine[]): Step[] {
  const steps: Step[] = [];
  let stepId = 1;

  // Track pending tool calls from assistant messages so we can pair them
  // with subsequent user tool_result messages
  let pendingToolCalls: ToolCall[] = [];
  let pendingAssistantStep: Step | null = null;

  for (const line of lines) {
    if (line.type === "system" || line.type === "result") continue;

    if (line.type === "assistant") {
      // If there's a pending assistant step without observations, flush it
      if (pendingAssistantStep) {
        steps.push(pendingAssistantStep);
        stepId++;
        pendingAssistantStep = null;
        pendingToolCalls = [];
      }

      const assistant = line as ClaudeCodeAssistant;

      // Skip subagent (Task) messages — they're internal
      if (assistant.parent_tool_use_id) continue;

      const { text, toolCalls } = extractAssistantContent(assistant);
      const metrics = extractMetrics(assistant.message.usage);

      const step: Step = {
        step_id: stepId,
        source: "agent",
        model_name: assistant.message.model,
        message: text,
      };

      if (toolCalls.length > 0) step.tool_calls = toolCalls;
      if (metrics) step.metrics = metrics;

      if (toolCalls.length > 0) {
        // Hold this step — wait for tool results
        pendingAssistantStep = step;
        pendingToolCalls = toolCalls;
      } else {
        steps.push(step);
        stepId++;
      }
    }

    if (line.type === "user") {
      const user = line as ClaudeCodeUser;
      const content = user.message.content;

      // Check if this is a tool result
      const hasToolResult = content.some((c) => c.type === "tool_result");

      if (hasToolResult && pendingAssistantStep) {
        // Attach observations to the pending assistant step
        const observations = extractObservations(content);
        if (observations.length > 0) {
          pendingAssistantStep.observation = { results: observations };
        }
        steps.push(pendingAssistantStep);
        stepId++;
        pendingAssistantStep = null;
        pendingToolCalls = [];
      } else if (!hasToolResult) {
        // Flush any pending assistant step
        if (pendingAssistantStep) {
          steps.push(pendingAssistantStep);
          stepId++;
          pendingAssistantStep = null;
          pendingToolCalls = [];
        }

        // Regular user message
        const text = content
          .filter((c) => c.type === "text")
          .map((c) => c.text || "")
          .join("\n");

        if (text) {
          steps.push({
            step_id: stepId,
            source: "user",
            message: text,
          });
          stepId++;
        }
      }
    }
  }

  // Flush any remaining pending step
  if (pendingAssistantStep) {
    steps.push(pendingAssistantStep);
  }

  // Re-number step_ids sequentially
  for (let i = 0; i < steps.length; i++) {
    steps[i].step_id = i + 1;
  }

  return steps;
}

function extractAssistantContent(assistant: ClaudeCodeAssistant): {
  text: string;
  toolCalls: ToolCall[];
} {
  let text = "";
  const toolCalls: ToolCall[] = [];

  for (const block of assistant.message.content) {
    if (block.type === "text" && block.text) {
      text += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        tool_call_id: block.id || `call_${toolCalls.length}`,
        function_name: block.name || "unknown",
        arguments: block.input || {},
      });
    }
  }

  return { text, toolCalls };
}

function extractObservations(
  content: ClaudeUserContent[]
): ObservationResult[] {
  const results: ObservationResult[] = [];

  for (const c of content) {
    if (c.type !== "tool_result") continue;

    let text = "";
    if (typeof c.content === "string") {
      text = c.content;
    } else if (Array.isArray(c.content)) {
      text = c.content
        .filter((r) => r.type === "text")
        .map((r) => r.text)
        .join("\n");
    }

    results.push({
      source_call_id: c.tool_use_id,
      content: text || undefined,
    });
  }

  return results;
}

function extractMetrics(usage: ClaudeUsage): Metrics {
  const cachedTokens = usage.cache_read_input_tokens || 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens || 0;

  const metrics: Metrics = {
    prompt_tokens: usage.input_tokens + cachedTokens + cacheCreationTokens,
    completion_tokens: usage.output_tokens,
    cached_tokens: cachedTokens,
  };

  if (cacheCreationTokens > 0) {
    metrics.extra = { cache_creation_input_tokens: cacheCreationTokens };
  }

  return metrics;
}

function buildFinalMetrics(
  result: ClaudeCodeResult | undefined,
  steps: Step[]
): FinalMetrics {
  if (result?.modelUsage) {
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCachedTokens = 0;

    for (const [, usage] of Object.entries(result.modelUsage)) {
      totalPromptTokens +=
        usage.inputTokens +
        (usage.cacheReadInputTokens || 0) +
        (usage.cacheCreationInputTokens || 0);
      totalCompletionTokens += usage.outputTokens;
      totalCachedTokens += usage.cacheReadInputTokens || 0;
    }

    return {
      total_prompt_tokens: totalPromptTokens,
      total_completion_tokens: totalCompletionTokens,
      total_cached_tokens: totalCachedTokens,
      total_cost_usd: result.total_cost_usd,
      total_steps: steps.length,
    };
  }

  // Fallback: sum from steps
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalCachedTokens = 0;

  for (const step of steps) {
    if (step.metrics) {
      totalPromptTokens += step.metrics.prompt_tokens || 0;
      totalCompletionTokens += step.metrics.completion_tokens || 0;
      totalCachedTokens += step.metrics.cached_tokens || 0;
    }
  }

  return {
    total_prompt_tokens: totalPromptTokens,
    total_completion_tokens: totalCompletionTokens,
    total_cached_tokens: totalCachedTokens,
    total_cost_usd: result?.total_cost_usd,
    total_steps: steps.length,
  };
}
