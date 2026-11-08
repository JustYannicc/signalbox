// @effect-diagnostics nodeBuiltinImport:off - exercise Alchemy's filesystem store across separate CLI processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { expect, it } from "@effect/vitest";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const require = NodeModule.createRequire(import.meta.url);
const moduleUrl = (name: string) => JSON.stringify(require.resolve(name));

const driver = `
import * as assert from "node:assert/strict";
import * as Effect from ${moduleUrl("effect/Effect")};
import * as NodeServices from ${moduleUrl("@effect/platform-node/NodeServices")};
import { localState } from ${moduleUrl("alchemy/State/LocalState")};
import { State } from ${moduleUrl("alchemy/State/State")};

await Effect.runPromise(Effect.gen(function* () {
  const store = yield* yield* State;
  assert.equal(store.id, "local");
  const key = { stack: "DisposableProbe", stage: "test-stage", fqn: "Probe" };
  if (process.argv[1] === "write") {
    yield* store.set({ ...key, value: {
      resourceType: "Test.Worker", logicalId: "Probe", fqn: "Probe",
      instanceId: "fixture", providerVersion: 1, status: "created",
      downstream: [], bindings: [], props: {}, attr: { id: "owned-worker" },
    }});
  } else {
    assert.deepEqual(yield* store.list(key), ["Probe"]);
    assert.equal((yield* store.get(key)).attr.id, "owned-worker");
    yield* store.delete(key);
    yield* store.deleteStack(key);
    assert.deepEqual(yield* store.listStacks(), []);
  }
}).pipe(Effect.provide(localState()), Effect.provide(NodeServices.layer)));
`;

it("a separate cleanup process reads and removes the probe's job-local state", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "alchemy-probe-state-"));
  try {
    await execFile(process.execPath, ["--input-type=module", "-e", driver, "write"], {
      cwd: directory,
    });
    expect(
      await NodeFSP.readdir(NodePath.join(directory, ".alchemy/state/DisposableProbe")),
    ).toEqual(["test-stage"]);
    await execFile(process.execPath, ["--input-type=module", "-e", driver, "cleanup"], {
      cwd: directory,
    });
    expect(await NodeFSP.readdir(NodePath.join(directory, ".alchemy/state"))).toEqual([]);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
