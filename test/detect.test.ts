import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectFormat } from "../src/detect.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..", "..");
const fixture = (name: string) => resolve(projectRoot, "test", "fixtures", name);

describe("detectFormat", () => {
  it("detects Claude Code JSONL", async () => {
    const result = await detectFormat(fixture("claude-code-simple.jsonl"));
    assert.equal(result.format, "claude-code-jsonl");
  });

  it("detects HAR (Anthropic)", async () => {
    const result = await detectFormat(fixture("har-anthropic.har"));
    assert.equal(result.format, "har");
  });

  it("detects HAR (OpenAI Responses)", async () => {
    const result = await detectFormat(fixture("har-openai-responses.har"));
    assert.equal(result.format, "har");
  });

  it("detects HAR (OpenAI Chat)", async () => {
    const result = await detectFormat(fixture("har-openai-chat.har"));
    assert.equal(result.format, "har");
  });

  it("detects Copilot CLI JSONL", async () => {
    const result = await detectFormat(fixture("copilot-cli-simple.jsonl"));
    assert.equal(result.format, "copilot-cli-jsonl");
  });

  it("throws on unknown format", async () => {
    await assert.rejects(
      () => detectFormat(fixture("unknown-format.txt")),
      { message: /Unable to detect input format/ }
    );
  });
});
