import { readFile } from "node:fs/promises";
import type { DetectedFormat } from "./types.js";

export async function detectFormat(filePath: string): Promise<DetectedFormat> {
  const content = await readFile(filePath, "utf-8");
  const firstLine = content.trimStart().slice(0, 4096);

  // JSONL: early lines contain a system/init JSON object (Claude Code format)
  if (looksLikeClaudeCodeJsonl(firstLine)) {
    return {
      format: "claude-code-jsonl",
      description: "Claude Code CLI logs (JSONL)",
    };
  }

  // JSONL: Codex CLI exec --json format (thread.started / item.* events)
  if (looksLikeCodexCliJsonl(firstLine)) {
    return {
      format: "codex-cli-jsonl",
      description: "Codex CLI logs (JSONL)",
    };
  }

  // JSONL: Copilot CLI stream format (session.* or user.message events)
  if (looksLikeCopilotCliJsonl(firstLine)) {
    return {
      format: "copilot-cli-jsonl",
      description: "Copilot CLI logs (JSONL)",
    };
  }

  // HAR: JSON object with log.version and log.entries
  if (looksLikeHar(firstLine)) {
    return { format: "har", description: "HTTP Archive (HAR)" };
  }

  throw new Error(
    `Unable to detect input format for: ${filePath}\n` +
      `Supported formats: HAR (.har), Claude Code CLI logs (.jsonl), Copilot CLI logs (.jsonl), Codex CLI logs (.jsonl)`
  );
}

function looksLikeClaudeCodeJsonl(content: string): boolean {
  try {
    // Check first few lines — the init line may not be the very first
    // (e.g. rate_limit_event can precede it)
    const lines = content.split("\n").slice(0, 10);
    return lines.some((line) => {
      try {
        const parsed = JSON.parse(line);
        return (
          parsed.type === "system" &&
          parsed.subtype === "init" &&
          typeof parsed.session_id === "string"
        );
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function looksLikeCopilotCliJsonl(firstLine: string): boolean {
  try {
    const first = JSON.parse(firstLine.split("\n")[0]);
    return (
      typeof first.type === "string" &&
      (first.type.startsWith("session.") || first.type === "user.message") &&
      typeof first.timestamp === "string"
    );
  } catch {
    return false;
  }
}

function looksLikeCodexCliJsonl(content: string): boolean {
  try {
    const lines = content.split("\n").slice(0, 5);
    return lines.some((line) => {
      try {
        const parsed = JSON.parse(line);
        return (
          parsed.type === "thread.started" &&
          typeof parsed.thread_id === "string"
        );
      } catch {
        return false;
      }
    });
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
