import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { MachineCommands } from "../../src/computer/MachineCommands.ts";
import type { DriveRef, RecipeHash } from "../../src/computer/Computer.ts";
import type { BoxdMachineClient, BoxdMachineRecord } from "../../src/computer/BoxdMachines.ts";
import { SqliteMachineCommandJournal } from "../../src/computer/SqliteMachineCommandJournal.ts";
import type { MachineWorkspace } from "../../src/computer/MachineWorkspace.ts";
import type { KernelCommand } from "../../src/kernel/KernelCommandForwarder.ts";
import { KernelOpenFlags } from "../../src/kernel/KernelFileSystem.ts";
import { createFacetWorkspace } from "../../src/computer/FacetWorkspace.ts";
import { ProofOwnership } from "./Ownership.ts";
import { createDurableProofBases } from "./DurableBases.ts";
import { createDurableProofRevisionPorts } from "./DurableRevisionPorts.ts";
import { openProofFilesystem, PROOF_INITIAL_REVISION } from "./Filesystem.ts";
import { RESULT_FILE } from "./Command.ts";
import { NESTED_PRIOR_FILE } from "./NestedCommand.ts";
import { recoverComputerBoxdProof } from "./Recovery.ts";
import { sqliteFixture } from "./ProofSqliteFixture.ts";
import { createRecoveryMachineOptions } from "./RecoveryMachine.ts";

const RECOVERY_OWNER = "recovery-wiring";

function testCommand(): KernelCommand {
  return { executable: "/bin/true", argv: ["true"], cwd: "/workspace", env: {} };
}

function machine(name: string, id: string): BoxdMachineRecord {
  return {
    id,
    name,
    status: "running",
    shared: false,
    networking: { isolated: true, networks: [] },
    idle: { destroyAfter: 0 },
    deleteAt: null,
  };
}

function createProviderClient(nativeBytes: Uint8Array) {
  const records = new Map<string, BoxdMachineRecord>();
  let nextId = 1;
  let creates = 0;
  let forks = 0;
  let deletes = 0;
  let vmExecs = 0;
  let quiesces = 0;
  const client: BoxdMachineClient & {
    readonly machines: BoxdMachineClient["machines"] & {
      readonly exec: (
        id: string,
        input: { readonly command: string[]; readonly timeout: number; readonly cwd?: string },
      ) => Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
      readonly files: {
        readonly upload: (id: string, path: string, bytes: Uint8Array) => Promise<number>;
        readonly download: (id: string, path: string) => Promise<Uint8Array>;
      };
    };
  } = {
    machines: {
      async create(input) {
        creates++;
        const id = `recovery-machine-${nextId++}`;
        records.set(input.name, machine(input.name, id));
        return { id };
      },
      async fork(_source, input) {
        forks++;
        const id = `recovery-machine-${nextId++}`;
        records.set(input.name, machine(input.name, id));
        return { id };
      },
      async get(name) {
        return records.get(name) ?? null;
      },
      async delete(id) {
        deletes++;
        for (const [name, row] of records) if (row.id === id) records.delete(name);
      },
      async setDeleteAfter() {},
      proxies: {
        async setPort() {},
        async list() {
          return [{ isDefault: true, port: 65535, portMode: "locked" }];
        },
      },
      async exec(_id, input) {
        vmExecs++;
        const scriptIndex = input.command.indexOf("-c") + 1;
        const script = input.command[scriptIndex];
        if (input.command.includes("quiesce")) {
          quiesces++;
          return {
            exitCode: 0,
            stdout: JSON.stringify({ closed: true, populated: 0, launchFenced: true }),
            stderr: "",
          };
        }
        if (script?.startsWith("# BOXD_PROOF:scan")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              entries: [
                {
                  path: "out.bin",
                  type: "file",
                  size: String(nativeBytes.byteLength),
                  nlink: "1",
                  atimeNs: "1",
                  mtimeNs: "3",
                  ctimeNs: "4",
                  mode: 0o644,
                  uid: 0,
                  gid: 0,
                },
              ],
            }),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      files: {
        async upload(_id, _path, bytes) {
          return bytes.byteLength;
        },
        async download() {
          return nativeBytes.slice();
        },
      },
    },
  };
  return {
    client: client as unknown as ConstructorParameters<typeof ProofOwnership>[2],
    machines: records,
    counts: () => ({ creates, forks, deletes, vmExecs, quiesces }),
  };
}

function changedInode(inode: bigint, bytes: Uint8Array) {
  const snapshot = bytes.slice();
  return {
    inode,
    paths: ["/out.bin"],
    removedPaths: [],
    stat: {
      type: "file" as const,
      size: BigInt(snapshot.byteLength),
      nlink: 1n,
      atimeNs: 2n,
      mtimeNs: 3n,
      ctimeNs: 4n,
    },
    symlinkTarget: null,
    posix: { mode: 0o644, uid: 0, gid: 0 },
    async *readChunks() {
      yield snapshot;
    },
  };
}

function createProofStorage() {
  const sqlite = sqliteFixture();
  const values = new Map<string, unknown>();
  const storage = Object.assign(sqlite.storage, {
    async get(key: string) {
      return values.get(key);
    },
    async put(key: string, value: unknown) {
      values.set(key, value);
    },
    async setAlarm() {},
    async deleteAlarm() {},
  });
  return {
    database: sqlite.storage,
    storage: storage as unknown as ConstructorParameters<typeof ProofOwnership>[0],
    read: (key: string) => values.get(key),
    close: sqlite.close,
  };
}

describe("computer Boxd proof recovery wiring", () => {
  it("rejects every command-side capability on a replacement owner", async () => {
    const sqlite = sqliteFixture();
    const ports = createDurableProofRevisionPorts(sqlite.storage);
    const signal = new AbortController().signal;
    const handle = { id: "machine", generation: 1, release: async () => {} };
    const mount: MachineWorkspace = {
      async checkpoint() {
        return PROOF_INITIAL_REVISION;
      },
      async prepare() {
        throw new Error("fixture prepare is unavailable");
      },
      async apply() {},
    };
    const options = createRecoveryMachineOptions({
      drive: "proof-drive" as DriveRef,
      recipeHash: "proof-recipe" as RecipeHash,
      bases: { release: async () => {} },
      machines: { reconcile: async () => ({ status: "unknown" }) },
      workspace: mount,
      runtime: {
        async rebind(input) {
          return {
            owner: {
              operationId: input.operationId,
              machineId: input.machine.id,
              generation: input.machine.generation,
            },
            async quiesce() {
              return {
                operationId: input.operationId,
                machineId: input.machine.id,
                generation: input.machine.generation,
                closed: true as const,
              };
            },
            async dispose() {},
          };
        },
      },
      hydration: ports.hydration,
      journal: new SqliteMachineCommandJournal(sqlite.storage),
      recoverySignal: signal,
    });
    try {
      expect(() => options.nextOperationId()).toThrow(
        "Recovery cannot allocate a command identity",
      );
      await expect(options.bases.acquire()).rejects.toThrow("Recovery cannot acquire a Base");
      await expect(
        options.machines.create(
          {
            operationId: "new-command",
            drive: "proof-drive" as DriveRef,
            recipeHash: "proof-recipe" as RecipeHash,
            base: Option.none(),
            expiresAt: 1_900_000_000_000,
          },
          signal,
        ),
      ).rejects.toThrow("Recovery cannot create a machine");
      await expect(
        options.runtime.attach({
          operationId: "new-command",
          machine: handle,
          workspace: { canonicalCwd: async (command) => command.cwd },
          policy: { authorize: async () => {} },
          signal,
        }),
      ).rejects.toThrow("Recovery cannot attach a command runtime");
      await expect(
        options.ports.commits.commit({
          at: PROOF_INITIAL_REVISION,
          turnId: "new-command:after",
          changedInodes: [],
          signal,
        }),
      ).rejects.toThrow("Apply recovery cannot recommit the command");
      await expect(new MachineCommands(options).spawn(testCommand(), signal)).rejects.toThrow(
        "Recovery cannot allocate a command identity",
      );
      expect(options.journal.pending()).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it.effect("reopens a SQLite durable bracket through a recovery-only owner without replay", () => {
    const proofStorage = createProofStorage();
    const state = openProofFilesystem(proofStorage.database);
    const held = (() => {
      state.filesystem.mkdir("/workspace");
      state.write("/workspace/out.bin", NESTED_PRIOR_FILE);
      return state.filesystem.open("/workspace/out.bin", KernelOpenFlags.O_RDONLY);
    })();
    const inode = state.filesystem.fstat(held).ino;
    const revisions = createDurableProofRevisionPorts(proofStorage.database);
    const provider = createProviderClient(RESULT_FILE);
    return Effect.gen(function* () {
      revisions.seedFile(PROOF_INITIAL_REVISION, "/out.bin", NESTED_PRIOR_FILE);
      const beforeResult = yield* Effect.promise(() =>
        revisions.commits.commit({
          at: PROOF_INITIAL_REVISION,
          turnId: `${RECOVERY_OWNER}-before`,
          changedInodes: [changedInode(inode, NESTED_PRIOR_FILE)],
          signal: new AbortController().signal,
        }),
      );
      if (beforeResult.status !== "ok") throw new Error("Could not seed the before revision");
      const before = { ...PROOF_INITIAL_REVISION, commit: beforeResult.value.commit };
      const afterResult = yield* Effect.promise(() =>
        revisions.commits.commit({
          at: before,
          turnId: `${RECOVERY_OWNER}-after`,
          changedInodes: [changedInode(inode, RESULT_FILE)],
          signal: new AbortController().signal,
        }),
      );
      if (afterResult.status !== "ok") throw new Error("Could not seed the after revision");
      const after = { ...before, commit: afterResult.value.commit };
      createFacetWorkspace({
        database: proofStorage.database,
        persistence: state.persistence,
        filesystem: state.filesystem,
        mountPath: "/workspace",
        initial: before,
        mount: async () => {
          throw new Error("The recovered fixture cannot mount a fresh workspace");
        },
      });

      const owner = new ProofOwnership(proofStorage.storage, RECOVERY_OWNER, provider.client);
      const sourceInput = yield* Effect.promise(() => owner.prepareSourceInput());
      const source = yield* Effect.promise(() =>
        owner.source.create(sourceInput, new AbortController().signal),
      );
      const leases = createDurableProofBases(proofStorage.database, {
        drive: owner.drive,
        recipeHash: owner.recipeHash,
        sourceRef: source.id,
        verifyHeldSource: () => owner.verifySource(source.id),
        now: () => 1_900_000_000_000,
        nextLeaseId: () => `${RECOVERY_OWNER}-lease`,
      });
      const base = yield* leases.bases.acquire(owner.drive, owner.recipeHash);
      if (Option.isNone(base)) throw new Error("Could not seed the retained Base lease");
      const machine = yield* Effect.promise(() =>
        owner.commands.create(
          {
            operationId: owner.commandOperation,
            drive: owner.drive,
            recipeHash: owner.recipeHash,
            base,
            expiresAt: base.value.expiresAt,
          },
          new AbortController().signal,
        ),
      );
      const createInput = {
        operationId: owner.commandOperation,
        drive: owner.drive,
        recipeHash: owner.recipeHash,
        base: base.value,
        expiresAt: base.value.expiresAt,
      };
      yield* Effect.promise(() =>
        owner.journal.write({ operationId: owner.commandOperation, phase: "checkpoint" }),
      );
      yield* Effect.promise(() =>
        owner.journal.write({
          operationId: owner.commandOperation,
          phase: "create",
          before,
          base: base.value,
          createInput,
        }),
      );
      yield* Effect.promise(() =>
        owner.journal.write({
          operationId: owner.commandOperation,
          phase: "apply",
          before,
          after,
          base: base.value,
          createInput,
          machine: { id: machine.id, generation: machine.generation },
        }),
      );

      const commitsBeforeRecovery = revisions.committedTurns.length;
      const providerCallsBeforeRecovery = provider.counts();
      yield* Effect.promise(() =>
        recoverComputerBoxdProof({
          ownership: owner,
          endpoint: "wss://proof.invalid/api/computer/runner",
          signal: new AbortController().signal,
          expected: {
            operationId: owner.commandOperation,
            before,
            after,
            inode,
            sourceRef: source.id,
          },
        }),
      );

      expect(owner.journal.read(owner.commandOperation)?.phase).toBe("complete");
      expect(provider.machines.has(`computer-${owner.commandOperation}`)).toBe(false);
      expect(state.filesystem.fstat(held).ino).toBe(inode);
      expect(state.read(held)).toEqual(RESULT_FILE);
      expect(revisions.inspectTree(before)?.["/out.bin"]?.data).toEqual(NESTED_PRIOR_FILE);
      expect(revisions.inspectTree(after)?.["/out.bin"]?.data).toEqual(RESULT_FILE);
      expect(leases.inspect()).toEqual({ acquired: 1, released: 1, held: 0 });
      expect(revisions.committedTurns).toHaveLength(commitsBeforeRecovery);
      expect(provider.counts()).toEqual({
        creates: providerCallsBeforeRecovery.creates,
        forks: providerCallsBeforeRecovery.forks,
        deletes: providerCallsBeforeRecovery.deletes + 1,
        vmExecs: providerCallsBeforeRecovery.vmExecs + 3,
        quiesces: providerCallsBeforeRecovery.quiesces + 1,
      });
      const proofState = proofStorage.read("proof-state") as {
        readonly checks: Record<string, string>;
      };
      expect(proofState.checks).toMatchObject({
        replacementReopenedDurableBracket: "passed",
        replacementBeforeImmutable: "passed",
        replacementAfterCommitStable: "passed",
        replacementOriginalInodeApplied: "passed",
        replacementResultBytesMatch: "passed",
        replacementNoReplay: "passed",
        replacementBaseLeaseReleased: "passed",
        replacementMachineAbsent: "passed",
        replacementJournalComplete: "passed",
        commandResult: "skipped",
        nativeCommandBytesAndExit: "skipped",
        commandStdoutBytesMatch: "skipped",
        commandStderrBytesMatch: "skipped",
        commandExitCode17: "skipped",
        commandSignalZero: "skipped",
        commandCoreDumpedFalse: "skipped",
        heldInodeRevisionAssertion: "skipped",
        sameOpenInodeApplied: "skipped",
        nestedPriorWriteAndRootContinuation: "skipped",
      });
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          state.filesystem.close(held);
          state.close();
          proofStorage.close();
        }),
      ),
    );
  });
});
