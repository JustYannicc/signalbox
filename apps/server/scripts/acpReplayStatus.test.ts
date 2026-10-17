// @effect-diagnostics nodeBuiltinImport:off -- exercises failure of the standalone fixture's status file write.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { type AcpReplayStatusFileSystem, writeAcpReplayStatus } from "./acpReplayStatus.ts";

it("preserves the last complete status when the next write is interrupted", () => {
  const replayDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "acp-replay-status-"));
  const statusPath = NodePath.join(replayDir, "status.json");
  const completedStatus = { scenario: "completed", cursor: 2, total: 2 };
  const completedJson = JSON.stringify(completedStatus);
  NodeFS.writeFileSync(statusPath, completedJson, "utf8");

  try {
    const interruptedWrite = new Error("injected status write interruption");
    const failingFileSystem: AcpReplayStatusFileSystem = {
      writeFileSync(path) {
        NodeFS.writeFileSync(path, '{"scenario":"partial', "utf8");
        throw interruptedWrite;
      },
      renameSync: NodeFS.renameSync,
      rmSync: NodeFS.rmSync,
    };

    assert.throws(
      () =>
        writeAcpReplayStatus(
          statusPath,
          JSON.stringify({ scenario: "next", cursor: 3, total: 3 }),
          failingFileSystem,
        ),
      /injected status write interruption/,
    );

    const preservedJson = NodeFS.readFileSync(statusPath, "utf8");
    assert.strictEqual(preservedJson, completedJson);
    assert.deepEqual(JSON.parse(preservedJson), completedStatus);

    const nextStatus = { scenario: "next", cursor: 3, total: 3 };
    const nextJson = JSON.stringify(nextStatus);
    writeAcpReplayStatus(statusPath, nextJson);

    const replacedJson = NodeFS.readFileSync(statusPath, "utf8");
    assert.strictEqual(replacedJson, nextJson);
    assert.deepEqual(JSON.parse(replacedJson), nextStatus);
  } finally {
    NodeFS.rmSync(replayDir, { recursive: true, force: true });
  }
});
