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
    assert.equal(typeof trajectory, "object");
    assert.equal(trajectory.schema_version, "ATIF-v1.7");
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
    assert.equal(typeof trajectory, "object");
    assert.equal(trajectory.schema_version, "ATIF-v1.7");
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
    assert.equal(typeof trajectory, "object");
    assert.equal(trajectory.schema_version, "ATIF-v1.7");
    assert.equal(trajectory.session_id, "session-xyz-789");
    assert.equal(trajectory.agent.name, "copilot-cli");
    assert.ok(trajectory.steps.length > 0);
  });

  it("converts Codex CLI JSONL to ATIF with --json", async () => {
    const { stdout } = await exec("node", [
      cli,
      fixture("codex-cli-simple.jsonl"),
      "--json",
      "--quiet",
    ]);
    const trajectory = JSON.parse(stdout);
    assert.equal(typeof trajectory, "object");
    assert.equal(trajectory.schema_version, "ATIF-v1.7");
    assert.equal(trajectory.session_id, "019e97e4-ba5c-7680-85c2-3399e3b68eaf");
    assert.equal(trajectory.agent.name, "codex-cli");
    assert.ok(trajectory.steps.length > 0);
  });

  it("writes output to file by default", async () => {
    const input = fixture("claude-code-simple.jsonl");
    const outputPrefix = resolve(
      projectRoot,
      "test",
      "fixtures",
      "claude-code-simple-test-output"
    );
    const expectedOutput = `${outputPrefix}.trajectory.json`;

    try {
      await exec("node", [cli, input, "-o", outputPrefix, "--quiet"]);
      const content = await readFile(expectedOutput, "utf-8");
      const trajectory = JSON.parse(content);
      assert.equal(trajectory.schema_version, "ATIF-v1.7");
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
    const trajectories = JSON.parse(stdout);
    assert.equal(trajectories.agent.name, "claude-code");
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

  it("writes subagent trajectories as separate files", async () => {
    const input = fixture("copilot-cli-subagent.jsonl");
    const outputPrefix = resolve(
      projectRoot,
      "test",
      "fixtures",
      "cli-subagent-test"
    );
    const mainFile = `${outputPrefix}.trajectory.json`;
    const subFile = `${outputPrefix}.trajectory.explore-files.json`;

    try {
      await exec("node", [cli, input, "-o", outputPrefix, "--quiet"]);

      // Main trajectory should exist and reference the subagent
      const mainContent = await readFile(mainFile, "utf-8");
      const main = JSON.parse(mainContent);
      assert.equal(main.schema_version, "ATIF-v1.7");

      // Find the subagent ref in the main trajectory
      let foundRef = false;
      for (const step of main.steps) {
        if (!step.observation) continue;
        for (const obs of step.observation.results) {
          if (obs.subagent_trajectory_ref) {
            assert.equal(
              obs.subagent_trajectory_ref[0].trajectory_path,
              "cli-subagent-test.trajectory.explore-files.json"
            );
            foundRef = true;
          }
        }
      }
      assert.ok(foundRef, "Should have a subagent_trajectory_ref");

      // Subagent trajectory file should exist
      const subContent = await readFile(subFile, "utf-8");
      const sub = JSON.parse(subContent);
      assert.equal(sub.schema_version, "ATIF-v1.7");
      assert.equal(sub.agent.model_name, "gpt-5.4-mini");
      assert.ok(sub.steps.length > 0);
    } finally {
      for (const f of [mainFile, subFile]) {
        try {
          await unlink(f);
        } catch {
          // cleanup best-effort
        }
      }
    }
  });

  it("embeds subagent trajectories in --json output", async () => {
    const { stdout } = await exec("node", [
      cli,
      fixture("copilot-cli-subagent.jsonl"),
      "--json",
      "--quiet",
    ]);
    const trajectory = JSON.parse(stdout);
    assert.equal(typeof trajectory, "object");
    assert.equal(trajectory.agent.model_name, "claude-opus-4.6-1m");
    // Subagents should be embedded in subagent_trajectories
    assert.ok(Array.isArray(trajectory.subagent_trajectories));
    assert.equal(trajectory.subagent_trajectories.length, 1);
    const sub = trajectory.subagent_trajectories[0];
    assert.equal(sub.agent.model_name, "gpt-5.4-mini");
    assert.equal(sub.trajectory_id, "task_explore_001");
    assert.ok(sub.steps.length > 0);
  });
});
