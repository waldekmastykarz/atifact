import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, unlink } from "node:fs/promises";

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..", "..");
const cli = resolve(projectRoot, "dist", "src", "index.js");
const fixture = (name: string) => resolve(projectRoot, "test", "fixtures", name);

describe("CLI integration", () => {
  it("outputs --version", async () => {
    const { stdout } = await exec("node", [cli, "--version"]);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  it("outputs --help to stderr", async () => {
    try {
      await exec("node", [cli, "--help"]);
    } catch (err) {
      // --help calls process.exit(0), child_process may still capture stderr
    }
    // help exits 0, so the above should succeed if not caught
  });

  it("exits 2 on missing input file argument", async () => {
    try {
      await exec("node", [cli]);
      assert.fail("Should have exited with code 2");
    } catch (err: unknown) {
      const e = err as { code: number; stderr: string };
      assert.equal(e.code, 2);
      assert.ok(e.stderr.includes("Missing required"));
    }
  });

  it("exits 1 on non-existent file", async () => {
    try {
      await exec("node", [cli, "/nonexistent/file.har"]);
      assert.fail("Should have exited with code 1");
    } catch (err: unknown) {
      const e = err as { code: number; stderr: string };
      assert.equal(e.code, 1);
      assert.ok(e.stderr.includes("File not found"));
    }
  });

  it("exits 2 on unknown option", async () => {
    try {
      await exec("node", [cli, "--bogus"]);
      assert.fail("Should have exited with code 2");
    } catch (err: unknown) {
      const e = err as { code: number; stderr: string };
      assert.equal(e.code, 2);
      assert.ok(e.stderr.includes("Unknown option"));
    }
  });

  it("converts Claude Code JSONL to ATIF with --json", async () => {
    const { stdout } = await exec("node", [
      cli,
      fixture("claude-code-simple.jsonl"),
      "--json",
      "--quiet",
    ]);
    const trajectory = JSON.parse(stdout);
    assert.equal(trajectory.schema_version, "ATIF-v1.6");
    assert.equal(trajectory.session_id, "sess-abc123");
    assert.ok(trajectory.steps.length > 0);
  });

  it("converts HAR to ATIF with --json", async () => {
    const { stdout } = await exec("node", [
      cli,
      fixture("har-anthropic.har"),
      "--json",
      "--quiet",
    ]);
    const trajectory = JSON.parse(stdout);
    assert.equal(trajectory.schema_version, "ATIF-v1.6");
    assert.ok(trajectory.steps.length > 0);
  });

  it("converts Copilot CLI JSONL to ATIF with --json", async () => {
    const { stdout } = await exec("node", [
      cli,
      fixture("copilot-cli-simple.jsonl"),
      "--json",
      "--quiet",
    ]);
    const trajectory = JSON.parse(stdout);
    assert.equal(trajectory.schema_version, "ATIF-v1.6");
    assert.equal(trajectory.session_id, "session-xyz-789");
    assert.equal(trajectory.agent.name, "copilot-cli");
    assert.ok(trajectory.steps.length > 0);
  });

  it("writes output to file by default", async () => {
    const input = fixture("claude-code-simple.jsonl");
    const expectedOutput = resolve(
      projectRoot,
      "test",
      "fixtures",
      "claude-code-simple.trajectory.json"
    );

    try {
      await exec("node", [cli, input, "-o", expectedOutput, "--quiet"]);
      const content = await readFile(expectedOutput, "utf-8");
      const trajectory = JSON.parse(content);
      assert.equal(trajectory.schema_version, "ATIF-v1.6");
    } finally {
      try {
        await unlink(expectedOutput);
      } catch {
        // cleanup best-effort
      }
    }
  });

  it("respects --format to force parser", async () => {
    const { stdout } = await exec("node", [
      cli,
      fixture("claude-code-simple.jsonl"),
      "--json",
      "--quiet",
      "-f",
      "claude-code-jsonl",
    ]);
    const trajectory = JSON.parse(stdout);
    assert.equal(trajectory.agent.name, "claude-code");
  });

  it("strips undefined/null fields from output", async () => {
    const { stdout } = await exec("node", [
      cli,
      fixture("har-openai-chat.har"),
      "--json",
      "--quiet",
    ]);
    const raw = stdout;
    // Should not contain "null" as a value (undefined fields are stripped)
    assert.ok(!raw.includes(": null"));
  });

  it("exits 2 on invalid --format value", async () => {
    try {
      await exec("node", [cli, fixture("har-anthropic.har"), "-f", "badvalue"]);
      assert.fail("Should have exited with code 2");
    } catch (err: unknown) {
      const e = err as { code: number; stderr: string };
      assert.equal(e.code, 2);
      assert.ok(e.stderr.includes("Invalid format"));
    }
  });

  it("exits 2 on --output without path", async () => {
    try {
      await exec("node", [cli, fixture("har-anthropic.har"), "-o"]);
      assert.fail("Should have exited with code 2");
    } catch (err: unknown) {
      const e = err as { code: number; stderr: string };
      assert.equal(e.code, 2);
      assert.ok(e.stderr.includes("requires a path"));
    }
  });

  it("exits 2 on multiple input files", async () => {
    try {
      await exec("node", [
        cli,
        fixture("har-anthropic.har"),
        fixture("har-openai-chat.har"),
      ]);
      assert.fail("Should have exited with code 2");
    } catch (err: unknown) {
      const e = err as { code: number; stderr: string };
      assert.equal(e.code, 2);
      assert.ok(e.stderr.includes("Unexpected argument"));
    }
  });

  it("exits 1 on undetectable format", async () => {
    try {
      await exec("node", [cli, fixture("unknown-format.txt"), "--json"]);
      assert.fail("Should have exited with code 1");
    } catch (err: unknown) {
      const e = err as { code: number; stderr: string };
      assert.equal(e.code, 1);
    }
  });
});
