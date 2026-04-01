import { readFile } from "node:fs/promises";
import type {
  Trajectory,
  Step,
  ToolCall,
  ObservationResult,
  Metrics,
  FinalMetrics,
  Agent,
} from "../types.js";

// --- Copilot CLI JSONL event types ---

interface CopilotToolsUpdated {
  type: "session.tools_updated";
  data: { model: string };
  timestamp: string;
}

interface CopilotUserMessage {
  type: "user.message";
  data: {
    content: string;
    transformedContent?: string;
    attachments?: unknown[];
    interactionId: string;
  };
  timestamp: string;
}

interface CopilotToolRequest {
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  type: string;
  intentionSummary?: string;
}

interface CopilotAssistantMessage {
  type: "assistant.message";
  data: {
    messageId: string;
    content: string;
    toolRequests?: CopilotToolRequest[];
    interactionId: string;
    reasoningText?: string;
    outputTokens?: number;
  };
  timestamp: string;
}

interface CopilotAssistantMessageDelta {
  type: "assistant.message_delta";
  data: {
    messageId: string;
    deltaContent: string;
  };
  timestamp: string;
}

interface CopilotToolExecutionComplete {
  type: "tool.execution_complete";
  data: {
    toolCallId: string;
    model?: string;
    success: boolean;
    result?: {
      content?: string;
      detailedContent?: string;
    };
  };
  timestamp: string;
}

interface CopilotResult {
  type: "result";
  timestamp: string;
  sessionId: string;
  exitCode: number;
  usage?: {
    premiumRequests?: number;
    totalApiDurationMs?: number;
    sessionDurationMs?: number;
    codeChanges?: {
      linesAdded?: number;
      linesRemoved?: number;
      filesModified?: string[];
    };
  };
}

type CopilotLine =
  | CopilotToolsUpdated
  | CopilotUserMessage
  | CopilotAssistantMessage
  | CopilotAssistantMessageDelta
  | CopilotToolExecutionComplete
  | CopilotResult
  | { type: string; [key: string]: unknown };

export async function parseCopilotCli(filePath: string): Promise<Trajectory> {
  const raw = await readFile(filePath, "utf-8");
  const lines = raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as CopilotLine);

  const toolsUpdated = lines.find(
    (l) => l.type === "session.tools_updated"
  ) as CopilotToolsUpdated | undefined;

  const resultLine = lines.find(
    (l) => l.type === "result"
  ) as CopilotResult | undefined;

  // Accumulate message_delta content by messageId
  const deltaContent = new Map<string, string>();
  for (const line of lines) {
    if (line.type === "assistant.message_delta") {
      const delta = line as CopilotAssistantMessageDelta;
      const existing = deltaContent.get(delta.data.messageId) || "";
      deltaContent.set(delta.data.messageId, existing + delta.data.deltaContent);
    }
  }

  // Index tool results by toolCallId
  const toolResults = new Map<string, CopilotToolExecutionComplete>();
  for (const line of lines) {
    if (line.type === "tool.execution_complete") {
      const result = line as CopilotToolExecutionComplete;
      toolResults.set(result.data.toolCallId, result);
    }
  }

  // Prefer model from session.tools_updated; fall back to first tool.execution_complete
  const model =
    toolsUpdated?.data.model ||
    [...toolResults.values()].find((r) => r.data.model)?.data.model;
  const sessionId = resultLine?.sessionId || "unknown";

  const agent = buildAgent(model);
  const steps = buildSteps(lines, deltaContent, toolResults, model);
  const finalMetrics = buildFinalMetrics(resultLine, steps);

  return {
    schema_version: "ATIF-v1.6",
    session_id: sessionId,
    agent,
    steps,
    final_metrics: finalMetrics,
    notes: `Converted from Copilot CLI logs: ${filePath}`,
  };
}

function buildAgent(model: string | undefined): Agent {
  return {
    name: "copilot-cli",
    version: "1.0.0",
    model_name: model,
  };
}

function buildSteps(
  lines: CopilotLine[],
  deltaContent: Map<string, string>,
  toolResults: Map<string, CopilotToolExecutionComplete>,
  model: string | undefined
): Step[] {
  const steps: Step[] = [];
  let stepId = 1;

  for (const line of lines) {
    if (line.type === "user.message") {
      const user = line as CopilotUserMessage;
      steps.push({
        step_id: stepId++,
        timestamp: user.timestamp,
        source: "user",
        message: user.data.content,
      });
    }

    if (line.type === "assistant.message") {
      const msg = line as CopilotAssistantMessage;

      // Build text content: prefer accumulated deltas, fall back to content field
      const accumulated = deltaContent.get(msg.data.messageId);
      const text = accumulated || msg.data.content || "";

      // Extract tool calls
      const toolCalls: ToolCall[] = [];
      if (msg.data.toolRequests) {
        for (const req of msg.data.toolRequests) {
          toolCalls.push({
            tool_call_id: req.toolCallId,
            function_name: req.name,
            arguments: req.arguments,
          });
        }
      }

      // Build observations from tool results
      const observations: ObservationResult[] = [];
      for (const tc of toolCalls) {
        const result = toolResults.get(tc.tool_call_id);
        if (result?.data.result) {
          observations.push({
            source_call_id: tc.tool_call_id,
            content: result.data.result.content || undefined,
          });
        }
      }

      const step: Step = {
        step_id: stepId++,
        timestamp: msg.timestamp,
        source: "agent",
        model_name: model,
        message: text,
      };

      if (msg.data.reasoningText) {
        step.reasoning_content = msg.data.reasoningText;
      }

      if (toolCalls.length > 0) {
        step.tool_calls = toolCalls;
      }

      if (observations.length > 0) {
        step.observation = { results: observations };
      }

      const metrics = extractMetrics(msg.data.outputTokens);
      if (metrics) {
        step.metrics = metrics;
      }

      steps.push(step);
    }
  }

  // Re-number step_ids sequentially
  for (let i = 0; i < steps.length; i++) {
    steps[i].step_id = i + 1;
  }

  return steps;
}

function extractMetrics(outputTokens: number | undefined): Metrics | undefined {
  if (outputTokens === undefined) return undefined;
  return {
    completion_tokens: outputTokens,
  };
}

function buildFinalMetrics(
  result: CopilotResult | undefined,
  steps: Step[]
): FinalMetrics {
  let totalCompletionTokens = 0;
  for (const step of steps) {
    if (step.metrics) {
      totalCompletionTokens += step.metrics.completion_tokens || 0;
    }
  }

  const fm: FinalMetrics = {
    total_completion_tokens: totalCompletionTokens,
    total_steps: steps.length,
  };

  if (result?.usage) {
    fm.extra = {
      ...(result.usage.premiumRequests !== undefined
        ? { premium_requests: result.usage.premiumRequests }
        : {}),
      ...(result.usage.totalApiDurationMs !== undefined
        ? { total_api_duration_ms: result.usage.totalApiDurationMs }
        : {}),
      ...(result.usage.sessionDurationMs !== undefined
        ? { session_duration_ms: result.usage.sessionDurationMs }
        : {}),
      ...(result.usage.codeChanges
        ? { code_changes: result.usage.codeChanges }
        : {}),
    };
  }

  return fm;
}
