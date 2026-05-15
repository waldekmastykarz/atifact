// ATIF v1.7 types

export interface Trajectory {
  schema_version: string;
  session_id?: string;
  trajectory_id?: string;
  agent: Agent;
  steps: Step[];
  notes?: string;
  final_metrics?: FinalMetrics;
  continued_trajectory_ref?: string;
  extra?: Record<string, unknown>;
  subagent_trajectories?: Trajectory[];
}

export interface Agent {
  name: string;
  version: string;
  model_name?: string;
  tool_definitions?: ToolDefinition[];
  extra?: Record<string, unknown>;
}

export interface ToolDefinition {
  type: string;
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface Step {
  step_id: number;
  timestamp?: string;
  source: "system" | "user" | "agent";
  model_name?: string;
  reasoning_effort?: string;
  message: string | ContentPart[];
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  observation?: Observation;
  metrics?: Metrics;
  extra?: Record<string, unknown>;
  llm_call_count?: number;
  is_copied_context?: boolean;
}

export interface ContentPart {
  type: "text" | "image";
  text?: string;
  source?: ImageSource;
}

export interface ImageSource {
  media_type: string;
  path: string;
}

export interface ToolCall {
  tool_call_id: string;
  function_name: string;
  arguments: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface Observation {
  results: ObservationResult[];
}

export interface ObservationResult {
  source_call_id?: string;
  content?: string | ContentPart[];
  subagent_trajectory_ref?: SubagentTrajectoryRef[];
  extra?: Record<string, unknown>;
}

export interface SubagentTrajectoryRef {
  trajectory_id?: string;
  trajectory_path?: string;
  session_id?: string;
  extra?: Record<string, unknown>;
}

export interface Metrics {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  cost_usd?: number;
  prompt_token_ids?: number[];
  completion_token_ids?: number[];
  logprobs?: number[];
  extra?: Record<string, unknown>;
}

export interface FinalMetrics {
  total_prompt_tokens?: number;
  total_completion_tokens?: number;
  total_cached_tokens?: number;
  total_cost_usd?: number;
  total_steps?: number;
  extra?: Record<string, unknown>;
}

// Parser result type — supports multi-file output for subagent trajectories

export interface ParseResult {
  trajectory: Trajectory;
  subagentTrajectories?: Map<string, Trajectory>;
}

// Input format types

export type InputFormat = "har" | "claude-code-jsonl" | "copilot-cli-jsonl";

export interface DetectedFormat {
  format: InputFormat;
  description: string;
}
