// @effect-diagnostics nodeBuiltinImport:off - Exercises a standalone fixture at its process boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeStream from "node:stream";
import * as NodeURL from "node:url";

import { assert, it } from "@effect/vitest";

it("publishes complete replay status before a reply lets the parent stop the agent", async () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "acp-replay-status-"));
  const statusPath = NodePath.join(directory, "status.json");
  const transcript = {
    scenario: "stop-after-reply",
    entries: [
      {
        type: "expect_outbound",
        frame: { kind: "request", method: "probe", params: "<any>" },
      },
      { type: "emit_inbound", frame: { kind: "response", method: "probe", result: {} } },
    ],
  };
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      "--require",
      NodeURL.fileURLToPath(new URL("./fixtures/acpReplayStatusBarrier.cjs", import.meta.url)),
      "--experimental-strip-types",
      NodeURL.fileURLToPath(new URL("./acp-replay-agent.ts", import.meta.url)),
    ],
    {
      env: {
        ...process.env,
        T3_ACP_REPLAY_TRANSCRIPT: Buffer.from(JSON.stringify(transcript)).toString("base64"),
        T3_ACP_REPLAY_STATUS_PATH: statusPath,
      },
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
    },
  );
  const barrier = child.stdio[3];
  const release = child.stdio[4];
  if (
    !child.stdin ||
    !child.stdout ||
    !(barrier instanceof NodeStream.Readable) ||
    !(release instanceof NodeStream.Writable)
  ) {
    child.kill();
    throw new Error("Replay test pipes are unavailable.");
  }
  const controller = new AbortController();
  const lines = NodeReadline.createInterface({ input: barrier });
  const reply = NodeEvents.EventEmitter.once(child.stdout, "data", { signal: controller.signal });
  const paused = NodeEvents.EventEmitter.once(lines, "line", { signal: controller.signal });
  const exited = NodeEvents.EventEmitter.once(child, "exit");
  const settled = Promise.allSettled([reply, paused, exited]);
  child.once("exit", () => controller.abort());
  child.once("error", (cause) => controller.abort(cause));
  child.stderr?.resume();

  try {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "probe", params: {} })}\n`,
    );
    const [phase] = await paused;

    // Readers must retain the preceding JSON while the next publication is interrupted.
    assert.deepEqual(JSON.parse(NodeFS.readFileSync(statusPath, "utf8")), {
      scenario: transcript.scenario,
      cursor: 1,
      total: 2,
    });
    if (phase === "before") release.write("x");
    else assert.equal(phase, "after");
    await reply;
    child.kill("SIGTERM");
    await exited;

    assert.deepEqual(JSON.parse(NodeFS.readFileSync(statusPath, "utf8")), {
      scenario: transcript.scenario,
      cursor: 2,
      total: 2,
    });
  } finally {
    controller.abort();
    child.kill("SIGTERM");
    await exited;
    await settled;
    lines.close();
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
