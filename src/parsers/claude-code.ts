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
  agent_id?: string;
  subagent_type?: string;
  task_description?: string;
  timestamp?: string;
}

interface ClaudeContentBlock {
  type: "text" | "tool_use" | "thinking" | "redacted_thinking";
  text?: string;
  thinking?: string;
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
  timestamp?: string;
  parent_tool_use_id?: string | null;
  agent_id?: string;
  subagent_type?: string;
  task_description?: string;
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
  | ClaudeStreamEvent
  | { type: string; [key: string]: unknown };

export async function parseClaudeCode(filePath: string): Promise<ParseResult> {
  const raw = await readFile(filePath, "utf-8");
  return parseClaudeCodeContent(raw, filePath);
}

export function parseClaudeCodeContent(
  content: string,
  sourceName = "in-memory input"
): ParseResult {
  const lines = content
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
  const finalUsageByMessageId = collectFinalUsage(lines);

  // Lines with a parent_tool_use_id belong to a subagent (Agent/Task tool)
  // and must never affect the root trajectory's steps
  const rootLines = lines.filter((l) => !getParentToolUseId(l));
  const completionUnknown = hasUnknownCompletionUsage(
    rootLines,
    finalUsageByMessageId
  );
  const steps = buildSteps(rootLines, finalUsageByMessageId);
  const subagentTrajectories = buildSubagentTrajectories(
    lines,
    initLine,
    steps,
    finalUsageByMessageId
  );
  const finalMetrics = buildFinalMetrics(resultLine, steps, completionUnknown);

  return {
    trajectory: {
      schema_version: "ATIF-v1.8",
      session_id: initLine.session_id,
      agent,
      steps,
      final_metrics: finalMetrics,
      notes: `Converted from Claude Code CLI logs: ${sourceName}`,
    },
    subagentTrajectories:
      subagentTrajectories.size > 0 ? subagentTrajectories : undefined,
  };
}

function getParentToolUseId(line: ClaudeCodeLine): string | undefined {
  if (line.type !== "assistant" && line.type !== "user") return undefined;
  const parentId = (line as ClaudeCodeAssistant | ClaudeCodeUser)
    .parent_tool_use_id;
  return typeof parentId === "string" && parentId ? parentId : undefined;
}

function buildSubagentTrajectories(
  lines: ClaudeCodeLine[],
  init: ClaudeCodeInit,
  rootSteps: Step[],
  finalUsageByMessageId: Map<string, Partial<ClaudeUsage>>
): Map<string, Trajectory> {
  const linesByParent = new Map<string, ClaudeCodeLine[]>();
  for (const line of lines) {
    const parentId = getParentToolUseId(line);
    if (!parentId) continue;
    let group = linesByParent.get(parentId);
    if (!group) {
      group = [];
      linesByParent.set(parentId, group);
    }
    group.push(line);
  }

  const trajectories = new Map<string, Trajectory>();

  for (const [parentId, subLines] of linesByParent) {
    const parentCall = rootSteps
      .flatMap((s) => s.tool_calls || [])
      .find((tc) => tc.tool_call_id === parentId);
    const meta = subLines.find(
      (l) =>
        (l as ClaudeCodeUser).agent_id ||
        (l as ClaudeCodeUser).subagent_type ||
        (l as ClaudeCodeUser).task_description
    ) as ClaudeCodeUser | undefined;

    const taskName =
      meta?.task_description ||
      (parentCall?.arguments.description as string | undefined);
    const agentType =
      meta?.subagent_type ||
      (parentCall?.arguments.subagent_type as string | undefined);
    const model = (
      subLines.find((l) => l.type === "assistant") as
        | ClaudeCodeAssistant
        | undefined
    )?.message.model;

    const completionUnknown = hasUnknownCompletionUsage(
      subLines,
      finalUsageByMessageId
    );
    const steps = buildSteps(subLines, finalUsageByMessageId);
    // parentId keeps names unique when tasks share a description
    const subSessionId = `${init.session_id}:${parentId}`;

    trajectories.set(parentId, {
      schema_version: "ATIF-v1.8",
      session_id: subSessionId,
      trajectory_id: parentId,
      agent: {
        name: agentType || "claude-code-subagent",
        version: init.claude_code_version,
        model_name: model,
        ...(meta?.agent_id ? { extra: { agent_id: meta.agent_id } } : {}),
      },
      steps,
      final_metrics: buildFinalMetrics(undefined, steps, completionUnknown),
      notes: `Subagent trajectory for task "${taskName || parentId}"`,
    });

    // Link the subagent trajectory from the parent's tool call observation
    for (const step of rootSteps) {
      if (!step.tool_calls?.some((tc) => tc.tool_call_id === parentId)) {
        continue;
      }
      if (!step.observation) step.observation = { results: [] };
      let result = step.observation.results.find(
        (r) => r.source_call_id === parentId
      );
      if (!result) {
        result = { source_call_id: parentId };
        step.observation.results.push(result);
      }
      result.subagent_trajectory_ref = [
        {
          trajectory_id: parentId,
          session_id: subSessionId,
        },
      ];
    }
  }

  return trajectories;
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

interface ClaudeStreamEvent {
  type: "stream_event";
  parent_tool_use_id?: string | null;
  event: {
    type: string;
    message?: { id?: string; usage?: Partial<ClaudeUsage> };
    usage?: Partial<ClaudeUsage>;
  };
}

/**
 * With `--include-partial-messages`, `stream_event` lines carry the raw API
 * stream. The `message_delta` event holds the final usage for the response
 * opened by the preceding `message_start`.
 */
function collectFinalUsage(
  lines: ClaudeCodeLine[]
): Map<string, Partial<ClaudeUsage>> {
  const finalUsage = new Map<string, Partial<ClaudeUsage>>();
  // Subagent streams can interleave with the main one, so track the open
  // response per stream (keyed by parent_tool_use_id).
  const openByStream = new Map<
    string,
    { id: string; usage: Partial<ClaudeUsage> | undefined }
  >();

  for (const line of lines) {
    if (line.type !== "stream_event") continue;
    const streamLine = line as ClaudeStreamEvent;
    const event = streamLine.event;
    if (!event) continue;
    const streamKey = streamLine.parent_tool_use_id ?? "";

    if (event.type === "message_start") {
      const id = event.message?.id;
      if (id) {
        openByStream.set(streamKey, { id, usage: event.message?.usage });
      } else {
        openByStream.delete(streamKey);
      }
    } else if (
      event.type === "message_delta" &&
      typeof event.usage?.output_tokens === "number"
    ) {
      const open = openByStream.get(streamKey);
      if (open) {
        finalUsage.set(open.id, { ...open.usage, ...event.usage });
      }
    }
  }

  return finalUsage;
}

/**
 * Returns true when any response (grouped by message.id) has no
 * final output token count, i.e. only placeholder usage was captured.
 */
function hasUnknownCompletionUsage(
  lines: ClaudeCodeLine[],
  finalUsageByMessageId: Map<string, Partial<ClaudeUsage>>
): boolean {
  const knownById = new Map<string, boolean>();
  for (const line of lines) {
    if (line.type !== "assistant") continue;
    const assistant = line as ClaudeCodeAssistant;
    if (!assistant.message.usage) continue;
    const id = assistant.message.id;
    const known =
      finalUsageByMessageId.has(id) || assistant.message.stop_reason != null;
    knownById.set(id, (knownById.get(id) ?? false) || known);
  }
  return [...knownById.values()].some((known) => !known);
}

function buildSteps(
  lines: ClaudeCodeLine[],
  finalUsageByMessageId: Map<string, Partial<ClaudeUsage>>
): Step[] {
  const steps: Step[] = [];

  // Claude Code emits one assistant line per content block of a single API
  // response; all of them share message.id and repeat the same usage. Keep the
  // current agent step open so these lines can be merged into one step.
  let currentStep: Step | null = null;
  let currentMessageId: string | undefined;
  let currentFinalUsage: Partial<ClaudeUsage> | undefined;

  const flush = () => {
    if (currentStep) steps.push(currentStep);
    currentStep = null;
    currentMessageId = undefined;
    currentFinalUsage = undefined;
  };
  // Results can arrive after the owning step was flushed (e.g. separate user
  // messages, or subagent activity before the root result)
  const toolCallsById = new Map<string, ToolCall>();

  for (const line of lines) {
    if (line.type === "system" || line.type === "result") continue;

    if (line.type === "assistant") {
      const assistant = line as ClaudeCodeAssistant;

      const messageId = assistant.message.id;
      const merging =
        currentStep !== null && !!messageId && messageId === currentMessageId;
      const { text, reasoning, toolCalls } = extractAssistantContent(
        assistant,
        merging ? (currentStep as Step | null)?.tool_calls?.length ?? 0 : 0
      );
      for (const tc of toolCalls) toolCallsById.set(tc.tool_call_id, tc);

      if (merging && currentStep) {
        const step: Step = currentStep;
        step.message = `${step.message}${text}`;
        if (reasoning) {
          step.reasoning_content = `${step.reasoning_content ?? ""}${reasoning}`;
        }
        if (toolCalls.length > 0) {
          step.tool_calls = [...(step.tool_calls ?? []), ...toolCalls];
        }
        // Usage is repeated on every line of the response; count it once,
        // preferring a snapshot that carries final output tokens.
        const metrics = extractMetrics(assistant.message, currentFinalUsage);
        if (
          metrics &&
          (metrics.completion_tokens !== undefined ||
            step.metrics?.completion_tokens === undefined)
        ) {
          step.metrics = metrics;
        }
        continue;
      }

      flush();

      // Final streamed usage (if any) belongs to the response, not each line.
      const finalUsage = messageId
        ? finalUsageByMessageId.get(messageId)
        : undefined;
      if (messageId) finalUsageByMessageId.delete(messageId);
      const metrics = extractMetrics(assistant.message, finalUsage);

      const step: Step = {
        step_id: 0,
        ...(assistant.timestamp ? { timestamp: assistant.timestamp } : {}),
        source: "agent",
        model_name: assistant.message.model,
        message: text,
      };

      if (reasoning) step.reasoning_content = reasoning;
      if (toolCalls.length > 0) step.tool_calls = toolCalls;
      if (metrics) step.metrics = metrics;

      currentStep = step;
      currentMessageId = messageId;
      currentFinalUsage = finalUsage;
    }

    if (line.type === "user") {
      const user = line as ClaudeCodeUser;

      const content = user.message.content;

      // Check if this is a tool result
      const hasToolResult = content.some((c) => c.type === "tool_result");
      if (hasToolResult) recordToolCallResults(toolCallsById, content);

      if (hasToolResult) {
        // Attach observations to the current agent step. Results for parallel
        // tool calls may arrive on separate lines, so keep the step open.
        const step = currentStep as Step | null;
        if (step?.tool_calls) {
          const observations = extractObservations(content);
          if (observations.length > 0) {
            step.observation = {
              results: [...(step.observation?.results ?? []), ...observations],
            };
          }
        }
      } else {
        flush();

        // Regular user message
        const text = content
          .filter((c) => c.type === "text")
          .map((c) => c.text || "")
          .join("\n");

        if (text) {
          steps.push({
            step_id: 0,
            ...(user.timestamp ? { timestamp: user.timestamp } : {}),
            source: "user",
            message: text,
          });
        }
      }
    }
  }

  flush();

  // Number step_ids sequentially
  for (let i = 0; i < steps.length; i++) {
    steps[i].step_id = i + 1;
  }

  return steps;
}

function extractAssistantContent(
  assistant: ClaudeCodeAssistant,
  toolCallOffset = 0
): {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
} {
  let text = "";
  let reasoning = "";
  const toolCalls: ToolCall[] = [];

  for (const block of assistant.message.content) {
    if (block.type === "text" && block.text) {
      text += block.text;
    } else if (block.type === "thinking" && block.thinking) {
      reasoning += block.thinking;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        tool_call_id: block.id || `call_${toolCallOffset + toolCalls.length}`,
        function_name: block.name || "unknown",
        arguments: block.input || {},
      });
    }
  }

  return { text, reasoning, toolCalls };
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

// Records each tool call's outcome using the Vally ATIF tool evidence
// convention: extra["microsoft.vally"].tool_call_result.
function recordToolCallResults(
  toolCallsById: Map<string, ToolCall>,
  content: ClaudeUserContent[]
): void {
  for (const c of content) {
    if (c.type !== "tool_result" || !c.tool_use_id) continue;
    const call = toolCallsById.get(c.tool_use_id);
    if (!call) continue;
    const existing = call.extra?.["microsoft.vally"];
    call.extra = {
      ...call.extra,
      "microsoft.vally": {
        ...(existing && typeof existing === "object" ? existing : {}),
        tool_call_result: c.is_error === true ? "failure" : "success",
      },
    };
  }
}

function extractMetrics(
  message: ClaudeCodeAssistant["message"],
  finalUsage: Partial<ClaudeUsage> | undefined
): Metrics | undefined {
  const usage: Partial<ClaudeUsage> | undefined = finalUsage
    ? { ...message.usage, ...finalUsage }
    : message.usage;
  if (!usage) return undefined;

  // Assistant lines streamed by Claude Code carry the usage snapshot taken at
  // `message_start` (stop_reason is still null), where output_tokens is only a
  // placeholder. Only trust it when it's final.
  const hasFinalOutputTokens =
    finalUsage !== undefined || message.stop_reason != null;

  const cachedTokens = usage.cache_read_input_tokens || 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens || 0;

  const metrics: Metrics = {
    prompt_tokens: (usage.input_tokens || 0) + cachedTokens + cacheCreationTokens,
    cached_tokens: cachedTokens,
  };

  if (hasFinalOutputTokens && typeof usage.output_tokens === "number") {
    metrics.completion_tokens = usage.output_tokens;
  }

  if (cacheCreationTokens > 0) {
    metrics.extra = { cache_creation_input_tokens: cacheCreationTokens };
  }

  return metrics;
}

function buildFinalMetrics(
  result: ClaudeCodeResult | undefined,
  steps: Step[],
  completionUnknown: boolean
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

  const resultUsage = result?.usage as Partial<ClaudeUsage> | undefined;
  if (resultUsage && typeof resultUsage.output_tokens === "number") {
    const cachedTokens = resultUsage.cache_read_input_tokens || 0;
    return {
      total_prompt_tokens:
        (resultUsage.input_tokens || 0) +
        cachedTokens +
        (resultUsage.cache_creation_input_tokens || 0),
      total_completion_tokens: resultUsage.output_tokens,
      total_cached_tokens: cachedTokens,
      total_cost_usd: result?.total_cost_usd,
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
    // Omit rather than report a partial total when any step's output is unknown
    total_completion_tokens: completionUnknown
      ? undefined
      : totalCompletionTokens,
    total_cached_tokens: totalCachedTokens,
    total_cost_usd: result?.total_cost_usd,
    total_steps: steps.length,
  };
}
