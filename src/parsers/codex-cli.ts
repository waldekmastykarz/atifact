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

// --- Codex CLI JSONL event types ---

interface CodexThreadStarted {
  type: "thread.started";
  thread_id: string;
}

interface CodexTurnStarted {
  type: "turn.started";
}

interface CodexTurnCompleted {
  type: "turn.completed";
  usage?: CodexUsage;
}

interface CodexUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

interface CodexItemStarted {
  type: "item.started";
  item: CodexItem;
}

interface CodexItemCompleted {
  type: "item.completed";
  item: CodexItem;
}

type CodexItem =
  | CodexAgentMessage
  | CodexCommandExecution
  | CodexFileChange
  | CodexCollabToolCall;

interface CodexAgentMessage {
  id: string;
  type: "agent_message";
  text: string;
}

interface CodexCommandExecution {
  id: string;
  type: "command_execution";
  command: string;
  aggregated_output: string;
  exit_code: number | null;
  status: "in_progress" | "completed" | "failed";
}

interface CodexFileChangeEntry {
  path: string;
  kind: "add" | "delete" | "update";
}

interface CodexFileChange {
  id: string;
  type: "file_change";
  changes: CodexFileChangeEntry[];
  status: "in_progress" | "completed" | "failed";
}

interface CodexAgentState {
  status: string;
  message: string | null;
}

interface CodexCollabToolCall {
  id: string;
  type: "collab_tool_call";
  tool: string;
  sender_thread_id: string;
  receiver_thread_ids: string[];
  prompt: string;
  agents_states: Record<string, CodexAgentState>;
  status: "in_progress" | "completed";
}

type CodexLine =
  | CodexThreadStarted
  | CodexTurnStarted
  | CodexTurnCompleted
  | CodexItemStarted
  | CodexItemCompleted
  | { type: string; [key: string]: unknown };

export async function parseCodexCli(filePath: string): Promise<ParseResult> {
  const raw = await readFile(filePath, "utf-8");
  const lines = raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as CodexLine);

  const threadStarted = lines.find(
    (l) => l.type === "thread.started"
  ) as CodexThreadStarted | undefined;

  const turnCompleted = lines.find(
    (l) => l.type === "turn.completed"
  ) as CodexTurnCompleted | undefined;

  const sessionId = threadStarted?.thread_id;

  // Collect completed items
  const completedItems = lines
    .filter((l) => l.type === "item.completed")
    .map((l) => (l as CodexItemCompleted).item);

  // Identify subagent spawn calls
  const subagentCalls = completedItems.filter(
    (item): item is CodexCollabToolCall =>
      item.type === "collab_tool_call" && item.tool === "spawn_agent"
  );

  // Build subagent trajectories (stub refs — Codex doesn't inline subagent content)
  const subagentTrajectories = buildSubagentTrajectories(
    subagentCalls,
    sessionId
  );

  const agent = buildAgent();
  const steps = buildSteps(completedItems, subagentTrajectories);
  const finalMetrics = buildFinalMetrics(turnCompleted, steps);

  const trajectory: Trajectory = {
    schema_version: "ATIF-v1.7",
    session_id: sessionId,
    agent,
    steps,
    final_metrics: finalMetrics,
    notes: `Converted from Codex CLI logs: ${filePath}`,
  };

  return {
    trajectory,
    subagentTrajectories:
      subagentTrajectories.size > 0 ? subagentTrajectories : undefined,
  };
}

function buildAgent(): Agent {
  return {
    name: "codex-cli",
    version: "1.0.0",
  };
}

function buildSteps(
  items: CodexItem[],
  subagentTrajectories: Map<string, Trajectory>
): Step[] {
  const steps: Step[] = [];
  let stepId = 1;

  for (const item of items) {
    switch (item.type) {
      case "agent_message": {
        steps.push({
          step_id: stepId++,
          source: "agent",
          message: item.text,
        });
        break;
      }

      case "command_execution": {
        // Model a command execution as an agent step with a tool call + observation
        const toolCall: ToolCall = {
          tool_call_id: item.id,
          function_name: "command_execution",
          arguments: { command: item.command },
        };

        const observation: ObservationResult = {
          source_call_id: item.id,
          content: item.aggregated_output || undefined,
          extra: {
            exit_code: item.exit_code,
            status: item.status,
          },
        };

        steps.push({
          step_id: stepId++,
          source: "agent",
          message: "",
          tool_calls: [toolCall],
          observation: { results: [observation] },
        });
        break;
      }

      case "file_change": {
        const toolCall: ToolCall = {
          tool_call_id: item.id,
          function_name: "file_change",
          arguments: {
            changes: item.changes.map((c) => ({
              path: c.path,
              kind: c.kind,
            })),
          },
        };

        steps.push({
          step_id: stepId++,
          source: "agent",
          message: "",
          tool_calls: [toolCall],
        });
        break;
      }

      case "collab_tool_call": {
        if (item.tool !== "spawn_agent") break;

        const toolCall: ToolCall = {
          tool_call_id: item.id,
          function_name: "spawn_agent",
          arguments: { prompt: item.prompt },
        };

        const receiverIds = item.receiver_thread_ids;
        const observations: ObservationResult[] = [];

        for (const receiverId of receiverIds) {
          const subTrajectory = subagentTrajectories.get(receiverId);
          observations.push({
            source_call_id: item.id,
            subagent_trajectory_ref: [
              {
                trajectory_id: subTrajectory?.trajectory_id || receiverId,
                session_id: subTrajectory?.session_id || receiverId,
              },
            ],
          });
        }

        const step: Step = {
          step_id: stepId++,
          source: "agent",
          message: "",
          tool_calls: [toolCall],
        };

        if (observations.length > 0) {
          step.observation = { results: observations };
        }

        steps.push(step);
        break;
      }
    }
  }

  // Re-number step_ids sequentially
  for (let i = 0; i < steps.length; i++) {
    steps[i].step_id = i + 1;
  }

  return steps;
}

function buildSubagentTrajectories(
  subagentCalls: CodexCollabToolCall[],
  parentSessionId: string | undefined
): Map<string, Trajectory> {
  const trajectories = new Map<string, Trajectory>();

  for (const call of subagentCalls) {
    for (const receiverId of call.receiver_thread_ids) {
      const subSessionId = parentSessionId
        ? `${parentSessionId}:${receiverId}`
        : receiverId;

      trajectories.set(receiverId, {
        schema_version: "ATIF-v1.7",
        session_id: subSessionId,
        trajectory_id: receiverId,
        agent: {
          name: "codex-cli-subagent",
          version: "1.0.0",
        },
        steps: [],
        notes: `Subagent trajectory stub for thread "${receiverId}" (Codex CLI does not inline subagent content)`,
      });
    }
  }

  return trajectories;
}

function buildFinalMetrics(
  turnCompleted: CodexTurnCompleted | undefined,
  steps: Step[]
): FinalMetrics {
  const fm: FinalMetrics = {
    total_steps: steps.length,
  };

  if (turnCompleted?.usage) {
    const u = turnCompleted.usage;
    fm.total_prompt_tokens = u.input_tokens + u.cached_input_tokens;
    fm.total_completion_tokens = u.output_tokens;
    fm.total_cached_tokens = u.cached_input_tokens || undefined;

    if (u.reasoning_output_tokens > 0) {
      fm.extra = {
        reasoning_output_tokens: u.reasoning_output_tokens,
      };
    }
  }

  return fm;
}
