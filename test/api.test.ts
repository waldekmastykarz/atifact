import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  convert,
  convertFile,
  detectFileFormat,
  detectFormat,
} from "../src/api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..", "..");
const fixture = (name: string) => resolve(projectRoot, "test", "fixtures", name);

describe("programmatic API", () => {
  it("detects and converts in-memory text", async () => {
    const content = await readFile(fixture("claude-code-simple.jsonl"), "utf-8");

    assert.equal(detectFormat(content).format, "claude-code-jsonl");
    const { trajectory } = await convert(content);

    assert.equal(trajectory.schema_version, "ATIF-v1.7");
    assert.equal(trajectory.session_id, "sess-abc123");
    assert.equal(trajectory.notes, "Converted from Claude Code CLI logs: in-memory input");
  });

  it("accepts Uint8Array input and a source name", async () => {
    const content = await readFile(fixture("vally-simple.json"));
    const { trajectory } = await convert(content, { sourceName: "request body" });

    assert.equal(trajectory.agent.name, "copilot-sdk");
    assert.equal(trajectory.notes, "Converted from Vally trajectory: request body");
  });

  it("supports forced formats", async () => {
    const content = await readFile(fixture("har-with-utility.har"), "utf-8");
    const { trajectory } = await convert(content, {
      format: "har",
      utilityModels: ["gpt-4o-mini"],
    });

    assert.equal(trajectory.agent.name, "copilot-chat");
    assert.ok(trajectory.steps.length > 0);
  });

  it("converts Codex content", async () => {
    const content = await readFile(fixture("codex-cli-simple.jsonl"), "utf-8");
    const { trajectory } = await convert(content);

    assert.equal(trajectory.agent.name, "codex-cli");
    assert.equal(trajectory.session_id, "019e97e4-ba5c-7680-85c2-3399e3b68eaf");
  });

  it("provides file convenience functions with equivalent output", async () => {
    const filePath = fixture("copilot-cli-simple.jsonl");
    const content = await readFile(filePath, "utf-8");
    const fromMemory = await convert(content, { sourceName: filePath });
    const fromFile = await convertFile(filePath);

    assert.deepEqual(fromFile, fromMemory);
    assert.equal((await detectFileFormat(filePath)).format, "copilot-cli-jsonl");
  });

  it("rejects unknown in-memory input without exiting the process", async () => {
    await assert.rejects(() => convert("not a supported format"), {
      message: /Unable to detect input format for: in-memory input/,
    });
  });
});