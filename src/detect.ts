import { readFile } from "node:fs/promises";
import type { DetectedFormat } from "./types.js";

export async function detectFormat(filePath: string): Promise<DetectedFormat> {
  const content = await readFile(filePath, "utf-8");
  const firstLine = content.trimStart().slice(0, 4096);

  // JSONL: first line is a JSON object with type/subtype fields (Claude Code format)
  if (looksLikeClaudeCodeJsonl(firstLine)) {
    return {
      format: "claude-code-jsonl",
      description: "Claude Code CLI logs (JSONL)",
    };
  }

  // HAR: JSON object with log.version and log.entries
  if (looksLikeHar(firstLine)) {
    return { format: "har", description: "HTTP Archive (HAR)" };
  }

  throw new Error(
    `Unable to detect input format for: ${filePath}\n` +
      `Supported formats: HAR (.har), Claude Code CLI logs (.jsonl)`
  );
}

function looksLikeClaudeCodeJsonl(firstLine: string): boolean {
  try {
    const first = JSON.parse(firstLine.split("\n")[0]);
    return (
      first.type === "system" &&
      first.subtype === "init" &&
      typeof first.session_id === "string"
    );
  } catch {
    return false;
  }
}

function looksLikeHar(content: string): boolean {
  try {
    // Check for HAR structure markers without parsing the whole file
    return (
      content.includes('"log"') &&
      (content.includes('"version"') || content.includes('"entries"'))
    );
  } catch {
    return false;
  }
}
