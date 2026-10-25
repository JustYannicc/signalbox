/// <reference types="node" />
// @effect-diagnostics nodeBuiltinImport:off -- Executes generated ESM through a separate Node runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { emitLunoraRecovery } from "@signalbox/sync/adapters/lunoraRecovery";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const Report = Schema.fromJsonString(
  Schema.Struct({
    functions: Schema.Number,
    postCommitInstallations: Schema.Number,
    rows: Schema.Number,
    recoveryRouting: Schema.String,
    failedAttempts: Schema.Number,
    pendingJobs: Schema.Number,
  }),
);
const decodeReport = Schema.decodeSync(Report);
const decodeCustodyReport = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      runtime: Schema.Literal("workerd-sqlite"),
      committedRows: Schema.Literal(1),
      committedReceipts: Schema.Literal(1),
      custodySurvivedRestart: Schema.Literal(true),
      duplicateReplayDidNotReschedule: Schema.Literal(true),
      transferredOnce: Schema.Literal(true),
    }),
  ),
);

describe("generated native fence recovery", () => {
  it("commits rows, receipts and native scheduler custody together across restarts", async () => {
    const { stdout } = await execute(process.execPath, [
      new URL("../../recovery-proof/custody.mjs", import.meta.url).pathname,
    ]);
    expect(decodeCustodyReport(stdout.trim())).toEqual({
      runtime: "workerd-sqlite",
      committedRows: 1,
      committedReceipts: 1,
      custodySurvivedRestart: true,
      duplicateReplayDidNotReschedule: true,
      transferredOnce: true,
    });
  });

  it("runs emitted internal functions through native transactions, scheduler and routed RPC", async () => {
    const { stdout } = await execute(process.execPath, [
      new URL("../../recovery-proof/run.mjs", import.meta.url).pathname,
    ]);
    expect(decodeReport(stdout.trim())).toEqual({
      functions: 4,
      postCommitInstallations: 1,
      rows: 1,
      recoveryRouting: "native-system-shard-client",
      failedAttempts: 7,
      pendingJobs: 0,
    });
  });

  it("rejects undefined home encodings and invalid native module identities", () => {
    expect(() =>
      emitLunoraRecovery(Schema.Void, { bindingImport: "./binding", moduleName: "recovery" }),
    ).toThrow("defined JSON value");
    expect(() =>
      emitLunoraRecovery(Schema.String, {
        bindingImport: "./binding",
        moduleName: "invalid/module",
      }),
    ).toThrow("JavaScript identifier");
  });
});
