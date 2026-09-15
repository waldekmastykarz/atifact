import { readFile } from "node:fs/promises";
import { detectContentFormat } from "./detect.js";
import { parseHarContent } from "./parsers/har.js";
import { parseClaudeCodeContent } from "./parsers/claude-code.js";
import { parseCopilotCliContent } from "./parsers/copilot-cli.js";
import { parseCodexCliContent } from "./parsers/codex-cli.js";
import { parseVallyContent } from "./parsers/vally.js";
import type { DetectedFormat, InputFormat, ParseResult } from "./types.js";

export interface ConvertOptions {
  format?: InputFormat;
  utilityModels?: readonly string[];
  sourceName?: string;
}

export function detectFormat(input: string | Uint8Array): DetectedFormat {
  return detectContentFormat(toText(input));
}

export async function detectFileFormat(filePath: string): Promise<DetectedFormat> {
  const content = await readFile(filePath, "utf-8");
  return detectContentFormat(content, filePath);
}

export async function convert(
  input: string | Uint8Array,
  options: ConvertOptions = {}
): Promise<ParseResult> {
  const content = toText(input);
  const format = options.format ?? detectContentFormat(content, options.sourceName).format;
  const sourceName = options.sourceName ?? "in-memory input";

  switch (format) {
    case "har":
      return parseHarContent(
        content,
        { utilityModels: [...(options.utilityModels ?? [])] },
        sourceName
      );
    case "claude-code-jsonl":
      return parseClaudeCodeContent(content, sourceName);
    case "copilot-cli-jsonl":
      return parseCopilotCliContent(content, sourceName);
    case "codex-cli-jsonl":
      return parseCodexCliContent(content, sourceName);
    case "vally-json":
      return parseVallyContent(content, sourceName);
  }
}

export async function convertFile(
  filePath: string,
  options: ConvertOptions = {}
): Promise<ParseResult> {
  const content = await readFile(filePath, "utf-8");
  return convert(content, {
    ...options,
    sourceName: options.sourceName ?? filePath,
  });
}

function toText(input: string | Uint8Array): string {
  return typeof input === "string" ? input : Buffer.from(input).toString("utf-8");
}

export type {
  Agent,
  AudioSource,
  ContentPart,
  DetectedFormat,
  FinalMetrics,
  ImageSource,
  InputFormat,
  Metrics,
  Observation,
  ObservationResult,
  ParseResult,
  Step,
  SubagentTrajectoryRef,
  ToolCall,
  ToolDefinition,
  Trajectory,
} from "./types.js";