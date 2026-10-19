import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import {
  makeBoxdMachines,
  type BoxdMachineClient,
  type BoxdMachineRecord,
} from "../BoxdMachines.ts";
import { SqliteBoxdReservations } from "../SqliteBoxdReservations.ts";
import { SqliteMachineCommandJournal } from "../SqliteMachineCommandJournal.ts";
import type { DriveRef, RecipeHash } from "../Computer.ts";
import type { MachineCommandJournal, MachineCommandRecord } from "../MachineCommandJournal.ts";
import {
  createMachineFixture,
  machineCommand,
  machineOutputBytes,
  machineOutputPath,
} from "./helpers/machineFixture.ts";
import { createTestFilesystem } from "./helpers/filesystem.ts";

const now = 1_800_000_000_000;
const baseLease = {
  id: "warm-base",
  sourceRef: "recipe:snapshot",
  expiresAt: 1_900_000_000_000,
} as const;

function boxdFake() {
  const machines = new Map<string, BoxdMachineRecord>();
  let creates = 0;
  let deletes = 0;
  let readinessWaits = 0;
  let failCreate: Error | undefined;
  const client: BoxdMachineClient = {
    machines: {
      async create(input) {
        creates += 1;
        if (failCreate) throw failCreate;
        const id = `boxd-${creates}`;
        machines.set(input.name, {
          id,
          name: input.name,
          status: "pending",
          shared: false,
          networking: { isolated: true, networks: [] },
          deleteAt: null,
        });
        return { id };
      },
      async fork(_source, input) {
        creates += 1;
        if (failCreate) throw failCreate;
        const id = `boxd-${creates}`;
        machines.set(input.name, {
          id,
          name: input.name,
          status: "pending",
          shared: false,
          networking: { isolated: true, networks: [] },
          deleteAt: null,
        });
        return { id };
      },
      async get(name) {
        return machines.get(name) ?? null;
      },
      async waitUntilReady(id) {
        readinessWaits += 1;
        const machine = [...machines.values()].find(
          (candidate) => candidate.id === id || candidate.name === id,
        );
        if (!machine) throw new Error(`Missing fake machine ${id}`);
        const ready = { ...machine, status: "running" };
        machines.set(machine.name, ready);
        return ready;
      },
      async delete(id) {
        deletes += 1;
        for (const [name, machine] of machines) if (machine.id === id) machines.delete(name);
      },
      async setDeleteAfter(name, seconds) {
        const machine = machines.get(name);
        if (machine)
          machines.set(name, {
            ...machine,
            deleteAt:
              seconds === 0 ? null : DateTime.toDate(DateTime.makeUnsafe(now + seconds * 1_000)),
          });
      },
      proxies: {
        async setPort() {},
        async list() {
          return [{ isDefault: true, port: 65535, portMode: "locked" }];
        },
      },
    },
  };
  return {
    client,
    counts: () => ({ creates, deletes, readinessWaits }),
    failNextCreate(error: Error) {
      failCreate = error;
    },
    addMachine(name: string, id = "boxd-late") {
      machines.set(name, {
        id,
        name,
        status: "running",
        shared: false,
        networking: { isolated: true, networks: [] },
        deleteAt: null,
      });
    },
  };
}

function makeMachine(
  client: BoxdMachineClient,
  storage: ReturnType<typeof createTestFilesystem>["storage"],
) {
  const reservations = new SqliteBoxdReservations(storage, () => "reservation-one");
  const machine = makeBoxdMachines(
    client,
    reservations,
    { org: "test-org", image: "runner-image", vcpu: 1, memory: "4G" },
    () => now,
  );
  return { machine, reservations };
}

function currentRecord(journal: SqliteMachineCommandJournal) {
  const record = journal.read("machine-op-1");
  if (!record) throw new Error("missing machine journal record");
  return record;
}

function createRecoveryFixture(input: {
  readonly storage: ReturnType<typeof createTestFilesystem>["storage"];
  readonly client: BoxdMachineClient;
  readonly ports: ReturnType<typeof createMachineFixture>["ports"];
  readonly resumedMount?: ReturnType<typeof createMachineFixture>["mount"];
  readonly journal?: MachineCommandJournal;
}) {
  const journal = input.journal ?? new SqliteMachineCommandJournal(input.storage);
  const { machine } = makeMachine(input.client, input.storage);
  const fixture = createMachineFixture({
    journal,
    machine,
    ports: input.ports,
    resume: async ({ operationId, machine: handle, before }) => {
      if (!input.resumedMount) throw new Error("No saved workspace mount in this local fake");
      return {
        mount: input.resumedMount,
        ownership: {
          operationId,
          machineId: handle.id,
          generation: handle.generation,
          before,
        },
      };
    },
  });
  return { fixture, journal };
}

describe("MachineCommands durable restart recovery", () => {
  it("reconciles an unknown Boxd create from its SQLite reservation without dispatching again", async () => {
    const sqlite = createTestFilesystem();
    const provider = boxdFake();
    provider.failNextCreate(new Error("provider create acknowledgement was lost"));
    try {
      const { machine, reservations } = makeMachine(provider.client, sqlite.storage);
      const journal = new SqliteMachineCommandJournal(sqlite.storage);
      const first = createMachineFixture({ baseLease, machine, journal });

      await expect(
        first.commands.spawn(machineCommand, new AbortController().signal),
      ).rejects.toMatchObject({ message: "Command failed and its workspace requires recovery" });
      const pending = currentRecord(journal);
      expect(pending.phase).toBe("create");
      expect(pending.createInput).toEqual({
        operationId: "machine-op-1",
        drive: "drive:test",
        recipeHash: "recipe:test",
        base: baseLease,
        expiresAt: baseLease.expiresAt,
      });
      const reservation = await reservations.lookup({
        operationId: pending.createInput!.operationId,
        drive: pending.createInput!.drive as DriveRef,
        recipeHash: pending.createInput!.recipeHash as RecipeHash,
        base: Option.some(baseLease),
        expiresAt: pending.createInput!.expiresAt,
      });
      expect(reservation.status).toBe("active");
      if (reservation.status !== "active") throw new Error("create reservation was not retained");
      provider.addMachine(reservation.reservation.name);
      expect(provider.counts().creates).toBe(1);
      expect(first.spawnCalls).toHaveLength(0);
      expect(first.events).not.toContain("base.release");

      const recovery = createRecoveryFixture({
        storage: sqlite.storage,
        client: provider.client,
        ports: first.ports,
      });
      await recovery.fixture.commands.recoverPending();

      expect(provider.counts()).toMatchObject({ creates: 1, deletes: 1 });
      expect(first.spawnCalls).toHaveLength(0);
      expect(recovery.fixture.spawnCalls).toHaveLength(0);
      expect(journal.read("machine-op-1")?.phase).toBe("complete");
    } finally {
      sqlite.close();
    }
  });

  it("recovers an uncertain execution from the persisted operation and preserves partial writes", async () => {
    const sqlite = createTestFilesystem();
    const provider = boxdFake();
    try {
      const { machine } = makeMachine(provider.client, sqlite.storage);
      const journal = new SqliteMachineCommandJournal(sqlite.storage);
      const first = createMachineFixture({ baseLease, machine, journal });
      await first.commands.spawn(machineCommand, new AbortController().signal);
      expect(provider.counts().readinessWaits).toBe(1);
      const interrupted = currentRecord(journal);
      expect(interrupted.phase).toBe("execute");
      expect(interrupted.createInput?.expiresAt).toBe(baseLease.expiresAt);

      const recovery = createRecoveryFixture({
        storage: sqlite.storage,
        client: provider.client,
        ports: first.ports,
        resumedMount: first.mount,
      });
      await recovery.fixture.commands.recover("machine-op-1");

      expect(provider.counts().creates).toBe(1);
      expect(first.spawnCalls).toHaveLength(1);
      expect(recovery.fixture.spawnCalls).toHaveLength(0);
      expect(recovery.fixture.appliedBytes).toEqual([machineOutputBytes]);
      expect(journal.read("machine-op-1")?.phase).toBe("complete");
      expect(first.memory.committedTurns).toHaveLength(1);
      const committed = first.memory.committedTurns[0]!.receipt.commit;
      expect(
        first.memory.inspectTree({ ...interrupted.before!, commit: committed })?.[machineOutputPath]
          ?.data,
      ).toEqual(machineOutputBytes);
    } finally {
      sqlite.close();
    }
  });

  it("reapplies a committed revision after restart without recommitting or respawning", async () => {
    const sqlite = createTestFilesystem();
    const provider = boxdFake();
    let firstApply = true;
    try {
      const { machine } = makeMachine(provider.client, sqlite.storage);
      const journal = new SqliteMachineCommandJournal(sqlite.storage);
      const first = createMachineFixture({
        baseLease,
        machine,
        journal,
        apply: async () => {
          if (firstApply) {
            firstApply = false;
            throw new Error("live workspace apply acknowledgement was lost");
          }
        },
      });
      const child = await first.commands.spawn(machineCommand, new AbortController().signal);
      first.closeChild();
      await expect(child.exited).rejects.toThrow("live workspace apply acknowledgement was lost");
      expect(currentRecord(journal).phase).toBe("apply");
      expect(first.memory.committedTurns).toHaveLength(1);

      const recovery = createRecoveryFixture({
        storage: sqlite.storage,
        client: provider.client,
        ports: first.ports,
        resumedMount: first.mount,
      });
      await recovery.fixture.commands.recover("machine-op-1");

      expect(provider.counts().creates).toBe(1);
      expect(first.spawnCalls).toHaveLength(1);
      expect(recovery.fixture.spawnCalls).toHaveLength(0);
      expect(first.commitAttempts).toEqual(["machine-op-1:after"]);
      expect(recovery.fixture.appliedBytes).toEqual([machineOutputBytes]);
      expect(journal.read("machine-op-1")?.phase).toBe("complete");
    } finally {
      sqlite.close();
    }
  });

  it("finishes deleted pending work from the tombstone without rebuilding the VM", async () => {
    const sqlite = createTestFilesystem();
    const provider = boxdFake();
    let failComplete = true;
    try {
      const { machine } = makeMachine(provider.client, sqlite.storage);
      const sqliteJournal = new SqliteMachineCommandJournal(sqlite.storage);
      const journal: MachineCommandJournal = {
        write: async (record: MachineCommandRecord) => {
          if (record.phase === "complete" && failComplete) {
            failComplete = false;
            throw new Error("completion journal write failed after deletion");
          }
          await sqliteJournal.write(record);
        },
        read: (operationId) => sqliteJournal.read(operationId),
        pending: () => sqliteJournal.pending(),
      };
      const first = createMachineFixture({ baseLease, machine, journal });
      const child = await first.commands.spawn(machineCommand, new AbortController().signal);
      first.closeChild();
      await expect(child.exited).rejects.toThrow("completion journal write failed after deletion");
      expect(currentRecord(sqliteJournal).phase).toBe("delete");
      expect(provider.counts()).toMatchObject({ creates: 1, deletes: 1 });

      const recovery = createRecoveryFixture({
        storage: sqlite.storage,
        client: provider.client,
        ports: first.ports,
      });
      await recovery.fixture.commands.recover("machine-op-1");

      expect(provider.counts()).toMatchObject({ creates: 1, deletes: 1 });
      expect(first.spawnCalls).toHaveLength(1);
      expect(recovery.fixture.spawnCalls).toHaveLength(0);
      expect(sqliteJournal.read("machine-op-1")?.phase).toBe("complete");
    } finally {
      sqlite.close();
    }
  });
});
