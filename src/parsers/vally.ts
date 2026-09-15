import { readFile } from "node:fs/promises";
import type {
  Agent,
  FinalMetrics,
  Metrics,
  ObservationResult,
  ParseResult,
  Step,
  ToolCall,
  Trajectory,
} from "../types.js";

interface VallyEvent {
  type: string;
  timestamp?: string;
  turn?: number;
  agentId?: string;
  data: Record<string, unknown>;
}

interface VallyTrajectory {
  id: string;
  stimulus: Record<string, unknown>;
  events: VallyEvent[];
  metrics: Record<string, unknown>;
  output: string;
  workDir: string;
  metadata: {
    model: string;
    skillsLoaded: string[];
    executor: string;
    sessionID: string;
    startedAt?: string;
    completedAt?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface AgentStepBuilder {
  step: Step;
  turn?: number;
  explicitBoundary: boolean;
  toolCallsById: Map<string, ToolCall>;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  llmCallCount: number;
  costs: unknown[];
}

export async function parseVally(filePath: string): Promise<ParseResult> {
  const raw = await readFile(filePath, "utf-8");
  const input = validateVallyTrajectory(JSON.parse(raw));
  const agent = buildAgent(input);
  const subagentIds = collectSubagentIds(input.events);
  const subagentTrajectories = new Map<string, Trajectory>();

  for (const agentId of subagentIds) {
    const subagentSteps = buildSteps(input.events, agentId);
    if (subagentSteps.length === 0) {
      subagentSteps.push({
        step_id: 1,
        source: "system",
        message: "Vally trajectory contains no events for this subagent",
        extra: { vally: { placeholder: true, agent_id: agentId } },
      });
    }
    subagentTrajectories.set(agentId, {
      schema_version: "ATIF-v1.7",
      session_id: `${input.metadata.sessionID}:${agentId}`,
      trajectory_id: agentId,
      agent: {
        name: agentId,
        version: "unknown",
        model_name: input.metadata.model,
      },
      steps: subagentSteps,
      notes: `Converted from Vally subagent events: ${filePath}`,
    });
  }

  const steps = buildSteps(input.events, undefined, subagentTrajectories);
  if (steps.length === 0) {
    steps.push({
      step_id: 1,
      source: "system",
      message: "Vally trajectory contains no root-agent events",
      extra: { vally: { placeholder: true } },
    });
  }
  appendFinalOutput(steps, input.output);

  const trajectory: Trajectory = {
    schema_version: "ATIF-v1.7",
    session_id: input.metadata.sessionID || input.id,
    trajectory_id: input.id !== input.metadata.sessionID ? input.id : undefined,
    agent,
    steps,
    final_metrics: buildFinalMetrics(input.metrics, steps),
    notes: `Converted from Vally trajectory: ${filePath}`,
    extra: { vally: buildVallyExtra(input) },
  };

  return {
    trajectory,
    subagentTrajectories:
      subagentTrajectories.size > 0 ? subagentTrajectories : undefined,
  };
}

function validateVallyTrajectory(value: unknown): VallyTrajectory {
  if (!isRecord(value)) throw new Error("Vally trajectory must be a JSON object");
  if (typeof value.id !== "string") throw new Error("Vally trajectory id must be a string");
  if (!isRecord(value.stimulus)) throw new Error("Vally trajectory stimulus must be an object");
  if (!Array.isArray(value.events)) throw new Error("Vally trajectory events must be an array");
  if (!isRecord(value.metrics)) throw new Error("Vally trajectory metrics must be an object");
  if (typeof value.output !== "string") throw new Error("Vally trajectory output must be a string");
  if (typeof value.workDir !== "string") throw new Error("Vally trajectory workDir must be a string");
  if (!isRecord(value.metadata)) throw new Error("Vally trajectory metadata must be an object");
  if (typeof value.metadata.sessionID !== "string") {
    throw new Error("Vally trajectory metadata.sessionID must be a string");
  }
  if (typeof value.metadata.executor !== "string" || typeof value.metadata.model !== "string") {
    throw new Error("Vally trajectory metadata must include executor and model strings");
  }
  for (const [index, event] of value.events.entries()) {
    if (!isRecord(event) || typeof event.type !== "string" || !isRecord(event.data)) {
      throw new Error(`Vally trajectory events[${index}] must have type and data`);
    }
  }
  return value as unknown as VallyTrajectory;
}

function buildAgent(input: VallyTrajectory): Agent {
  return {
    name: input.metadata.executor,
    version: "unknown",
    model_name: input.metadata.model,
    extra: {
      vally: {
        skills_loaded: input.metadata.skillsLoaded,
      },
    },
  };
}

function collectSubagentIds(events: VallyEvent[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.agentId) ids.add(event.agentId);
    if (event.type === "tool_call" && Array.isArray(event.data.launchedAgentIds)) {
      for (const id of event.data.launchedAgentIds) {
        if (typeof id === "string") ids.add(id);
      }
    }
  }
  return [...ids];
}

function buildSteps(
  events: VallyEvent[],
  agentId: string | undefined,
  subagents?: Map<string, Trajectory>
): Step[] {
  const steps: Step[] = [];
  const toolOwners = new Map<string, AgentStepBuilder>();
  let current: AgentStepBuilder | undefined;

  const pushCurrent = (): void => {
    if (!current) return;
    finalizeAgentStep(current);
    steps.push(current.step);
    current = undefined;
  };

  const ensureCurrent = (event: VallyEvent): AgentStepBuilder => {
    if (
      current &&
      !current.explicitBoundary &&
      event.turn !== undefined &&
      current.turn !== event.turn
    ) {
      pushCurrent();
    }
    if (!current) current = newAgentStep(event);
    return current;
  };

  for (const event of events) {
    if (event.agentId !== agentId) continue;

    switch (event.type) {
      case "turn_start":
        pushCurrent();
        current = newAgentStep(event, true);
        current.step.extra = withEventContext(current.step.extra, event, {
          turn_id: stringValue(event.data.turnId),
        });
        break;
      case "turn_end":
        pushCurrent();
        break;
      case "user_message":
        pushCurrent();
        steps.push({
          step_id: 0,
          timestamp: event.timestamp,
          source: "user",
          message: stringValue(event.data.content),
          extra: withEventContext(undefined, event, {
            agent_mode: event.data.agent_mode,
          }),
        });
        break;
      case "assistant_message":
        appendMessage(ensureCurrent(event).step, stringValue(event.data.content));
        break;
      case "reasoning":
        appendReasoning(ensureCurrent(event).step, stringValue(event.data.content));
        break;
      case "tool_call": {
        const builder = ensureCurrent(event);
        const toolCallId = stringValue(event.data.toolCallId);
        const toolCall: ToolCall = {
          tool_call_id: toolCallId,
          function_name: stringValue(event.data.toolName),
          arguments: normalizeArguments(event.data.arguments),
          extra: compactRecord({
            turn_id: event.data.turnId,
            simulated: event.data.simulated,
          }),
        };
        builder.step.tool_calls ??= [];
        builder.step.tool_calls.push(toolCall);
        builder.toolCallsById.set(toolCallId, toolCall);
        toolOwners.set(toolCallId, builder);
        addSubagentRefs(builder.step, event, subagents);
        break;
      }
      case "tool_result": {
        const callId = stringValue(event.data.toolCallId);
        const builder = toolOwners.get(callId) ?? ensureCurrent(event);
        const result: ObservationResult = {
          source_call_id: callId,
          content: stringifyResult(event.data.result),
          extra: compactRecord({
            success: event.data.success,
            tool_name: event.data.toolName,
            result: event.data.result,
          }),
        };
        builder.step.observation ??= { results: [] };
        builder.step.observation.results.push(result);
        break;
      }
      case "token_usage":
        addTokenUsage(ensureCurrent(event), event.data);
        break;
      case "cost_unavailable": {
        const builder = ensureCurrent(event);
        builder.step.extra = withEventContext(builder.step.extra, event, {
          cost_unavailable: event.data,
        });
        break;
      }
      case "system":
        pushCurrent();
        steps.push(systemEventStep(event));
        break;
      case "skill_activation":
        pushCurrent();
        steps.push({
          step_id: 0,
          timestamp: event.timestamp,
          source: "system",
          message: `Activated skill: ${stringValue(event.data.name)}`,
          extra: withEventContext(undefined, event, { skill_activation: event.data }),
        });
        break;
      case "error":
        pushCurrent();
        steps.push({
          step_id: 0,
          timestamp: event.timestamp,
          source: "system",
          message: stringValue(event.data.message),
          extra: withEventContext(undefined, event, { error: event.data }),
        });
        break;
      case "custom":
        pushCurrent();
        steps.push({
          step_id: 0,
          timestamp: event.timestamp,
          source: "system",
          message: customEventMessage(event.data),
          extra: withEventContext(undefined, event, { custom: event.data }),
        });
        break;
      default:
        pushCurrent();
        steps.push({
          step_id: 0,
          timestamp: event.timestamp,
          source: "system",
          message: `Vally event: ${event.type}`,
          extra: withEventContext(undefined, event, {
            event_type: event.type,
            data: event.data,
          }),
        });
    }
  }

  pushCurrent();
  for (let index = 0; index < steps.length; index++) steps[index].step_id = index + 1;
  return steps;
}

function newAgentStep(event: VallyEvent, explicitBoundary = false): AgentStepBuilder {
  return {
    step: {
      step_id: 0,
      timestamp: event.timestamp,
      source: "agent",
      message: "",
      extra: withEventContext(undefined, event),
    },
    turn: event.turn,
    explicitBoundary,
    toolCallsById: new Map(),
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    llmCallCount: 0,
    costs: [],
  };
}

function appendFinalOutput(steps: Step[], output: string): void {
  if (!output) return;
  const lastAgentMessage = [...steps]
    .reverse()
    .find((step) => step.source === "agent" && typeof step.message === "string" && step.message);
  if (lastAgentMessage?.message === output) return;
  steps.push({
    step_id: steps.length + 1,
    source: "agent",
    message: output,
    extra: { vally: { synthesized_from_output: true } },
  });
}

function finalizeAgentStep(builder: AgentStepBuilder): void {
  if (builder.llmCallCount === 0) return;
  const metrics: Metrics = {
    prompt_tokens: builder.inputTokens,
    completion_tokens: builder.outputTokens,
    cached_tokens: builder.cacheReadTokens || undefined,
    cache_write_tokens: builder.cacheWriteTokens || undefined,
  };
  if (builder.costs.length > 0) metrics.extra = { provider_costs: builder.costs };
  builder.step.metrics = metrics;
  builder.step.llm_call_count = builder.llmCallCount;
}

function addTokenUsage(builder: AgentStepBuilder, data: Record<string, unknown>): void {
  builder.inputTokens += numberValue(data.inputTokens);
  builder.outputTokens += numberValue(data.outputTokens);
  builder.cacheReadTokens += numberValue(data.cacheReadTokens);
  builder.cacheWriteTokens += numberValue(data.cacheWriteTokens);
  builder.llmCallCount++;
  if (data.cost !== undefined) builder.costs.push(data.cost);
  const model = typeof data.model === "string" ? data.model : undefined;
  if (model && !builder.step.model_name) builder.step.model_name = model;
}

function addSubagentRefs(
  step: Step,
  event: VallyEvent,
  subagents: Map<string, Trajectory> | undefined
): void {
  if (!subagents || !Array.isArray(event.data.launchedAgentIds)) return;
  const ids = event.data.launchedAgentIds.filter(
    (value): value is string => typeof value === "string"
  );
  if (ids.length === 0) return;
  step.observation ??= { results: [] };
  step.observation.results.push({
    source_call_id: stringValue(event.data.toolCallId),
    subagent_trajectory_ref: ids.map((id) => ({
      trajectory_id: id,
      session_id: subagents.get(id)?.session_id,
    })),
  });
}

function systemEventStep(event: VallyEvent): Step {
  const eventType = stringValue(event.data.eventType);
  const message =
    typeof event.data.message === "string" ? event.data.message : `System event: ${eventType}`;
  const results: ObservationResult[] = [];
  if (typeof event.data.observation === "string") {
    results.push({ content: event.data.observation });
  }
  return {
    step_id: 0,
    timestamp: event.timestamp,
    source: "system",
    message,
    observation: results.length > 0 ? { results } : undefined,
    extra: withEventContext(undefined, event, {
      context_management: {
        type: eventType,
        ...(isRecord(event.data.details) ? event.data.details : {}),
      },
    }),
  };
}

function buildFinalMetrics(metrics: Record<string, unknown>, steps: Step[]): FinalMetrics {
  const tokenUsage = isRecord(metrics.tokenUsage) ? metrics.tokenUsage : {};
  return {
    total_prompt_tokens: optionalNumber(tokenUsage.inputTokens),
    total_completion_tokens: optionalNumber(tokenUsage.outputTokens),
    total_cached_tokens: optionalNumber(tokenUsage.cacheReadTokens),
    total_cache_write_tokens: optionalNumber(tokenUsage.cacheWriteTokens),
    total_steps: steps.length,
    extra: {
      vally: metrics,
    },
  };
}

function buildVallyExtra(input: VallyTrajectory): Record<string, unknown> {
  const { id: _id, events: _events, metrics: _metrics, metadata, ...rest } = input;
  return {
    ...rest,
    metadata,
  };
}

function normalizeArguments(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { value: value ?? null };
}

function stringifyResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value);
}

function appendMessage(step: Step, content: string): void {
  const existing = typeof step.message === "string" ? step.message : "";
  step.message = existing ? `${existing}\n${content}` : content;
}

function appendReasoning(step: Step, content: string): void {
  step.reasoning_content = step.reasoning_content
    ? `${step.reasoning_content}\n${content}`
    : content;
}

function withEventContext(
  existing: Record<string, unknown> | undefined,
  event: VallyEvent,
  values: Record<string, unknown> = {}
): Record<string, unknown> | undefined {
  const vally = compactRecord({ turn: event.turn, agent_id: event.agentId, ...values });
  if (Object.keys(vally).length === 0) return existing;
  return { ...existing, vally: { ...(isRecord(existing?.vally) ? existing.vally : {}), ...vally } };
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function customEventMessage(data: Record<string, unknown>): string {
  return typeof data.message === "string" ? data.message : JSON.stringify(data);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}