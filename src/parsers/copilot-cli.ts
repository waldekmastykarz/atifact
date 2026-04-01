import { readFile } from "node:fs/promises";
import type {
  Trajectory,
  ParseResult,
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
    parentToolCallId?: string;
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
    parentToolCallId?: string;
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

export async function parseCopilotCli(filePath: string): Promise<ParseResult> {
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

  // Prefer model from session.tools_updated; fall back to first main-agent tool.execution_complete
  const model =
    toolsUpdated?.data.model ||
    [...toolResults.values()].find(
      (r) => r.data.model && !r.data.parentToolCallId
    )?.data.model;
  const sessionId = resultLine?.sessionId || "unknown";

  // Collect subagent parentToolCallIds
  const subagentParentIds = new Set<string>();
  for (const line of lines) {
    if (line.type === "assistant.message") {
      const msg = line as CopilotAssistantMessage;
      if (msg.data.parentToolCallId) {
        subagentParentIds.add(msg.data.parentToolCallId);
      }
    }
  }

  // Build subagent trajectories
  const subagentTrajectories = buildSubagentTrajectories(
    lines,
    subagentParentIds,
    deltaContent,
    toolResults,
    sessionId
  );

  const agent = buildAgent(model);
  const steps = buildSteps(
    lines,
    deltaContent,
    toolResults,
    model,
    subagentParentIds,
    subagentTrajectories
  );
  const finalMetrics = buildFinalMetrics(resultLine, steps);

  const trajectory: Trajectory = {
    schema_version: "ATIF-v1.6",
    session_id: sessionId,
    agent,
    steps,
    final_metrics: finalMetrics,
    notes: `Converted from Copilot CLI logs: ${filePath}`,
  };

  return {
    trajectory,
    subagentTrajectories:
      subagentTrajectories.size > 0 ? subagentTrajectories : undefined,
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
  model: string | undefined,
  subagentParentIds: Set<string>,
  subagentTrajectories: Map<string, Trajectory>
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

      // Skip subagent messages — they belong to their own trajectory
      if (msg.data.parentToolCallId) continue;

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
        const isSubagentTask = subagentParentIds.has(tc.tool_call_id);

        if (isSubagentTask) {
          // Attach subagent trajectory reference
          const subTrajectory = subagentTrajectories.get(tc.tool_call_id);
          const result = toolResults.get(tc.tool_call_id);
          const obs: ObservationResult = {
            source_call_id: tc.tool_call_id,
            content: result?.data.result?.content || undefined,
            subagent_trajectory_ref: [
              {
                session_id: subTrajectory?.session_id || tc.tool_call_id,
              },
            ],
          };
          observations.push(obs);
        } else {
          const result = toolResults.get(tc.tool_call_id);
          if (result?.data.result) {
            observations.push({
              source_call_id: tc.tool_call_id,
              content: result.data.result.content || undefined,
            });
          }
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

function buildSubagentTrajectories(
  lines: CopilotLine[],
  subagentParentIds: Set<string>,
  deltaContent: Map<string, string>,
  toolResults: Map<string, CopilotToolExecutionComplete>,
  parentSessionId: string
): Map<string, Trajectory> {
  const trajectories = new Map<string, Trajectory>();

  for (const parentId of subagentParentIds) {
    // Find the task tool request to get subagent metadata
    let taskName: string | undefined;
    let agentType: string | undefined;
    for (const line of lines) {
      if (line.type === "assistant.message") {
        const msg = line as CopilotAssistantMessage;
        const req = msg.data.toolRequests?.find(
          (r) => r.toolCallId === parentId
        );
        if (req) {
          taskName =
            (req.arguments.name as string) ||
            (req.arguments.description as string);
          agentType = req.arguments.agent_type as string;
          break;
        }
      }
    }

    // Collect subagent assistant.message events
    const subMessages = lines.filter(
      (l) =>
        l.type === "assistant.message" &&
        (l as CopilotAssistantMessage).data.parentToolCallId === parentId
    ) as CopilotAssistantMessage[];

    // Collect subagent tool results
    const subToolResults = new Map<string, CopilotToolExecutionComplete>();
    for (const line of lines) {
      if (line.type === "tool.execution_complete") {
        const result = line as CopilotToolExecutionComplete;
        if (result.data.parentToolCallId === parentId) {
          subToolResults.set(result.data.toolCallId, result);
        }
      }
    }

    // Determine subagent model from its tool completions
    const subModel = [...subToolResults.values()].find(
      (r) => r.data.model
    )?.data.model;

    // Build steps for this subagent
    const steps: Step[] = [];
    let stepId = 1;

    for (const msg of subMessages) {
      const accumulated = deltaContent.get(msg.data.messageId);
      const text = accumulated || msg.data.content || "";

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

      const observations: ObservationResult[] = [];
      for (const tc of toolCalls) {
        const result = subToolResults.get(tc.tool_call_id);
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
        model_name: subModel,
        message: text,
      };

      if (msg.data.reasoningText) {
        step.reasoning_content = msg.data.reasoningText;
      }
      if (toolCalls.length > 0) step.tool_calls = toolCalls;
      if (observations.length > 0) step.observation = { results: observations };

      const metrics = extractMetrics(msg.data.outputTokens);
      if (metrics) step.metrics = metrics;

      steps.push(step);
    }

    // Re-number step_ids
    for (let i = 0; i < steps.length; i++) {
      steps[i].step_id = i + 1;
    }

    const subSessionId = `${parentSessionId}:${taskName || parentId}`;

    trajectories.set(parentId, {
      schema_version: "ATIF-v1.6",
      session_id: subSessionId,
      agent: {
        name: agentType || "copilot-cli-subagent",
        version: "1.0.0",
        model_name: subModel,
      },
      steps,
      notes: `Subagent trajectory for task "${taskName || parentId}"`,
    });
  }

  return trajectories;
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
