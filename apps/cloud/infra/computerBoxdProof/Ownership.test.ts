import { describe, expect, it } from "vite-plus/test";
import * as Option from "effect/Option";
import type { BaseLease } from "../../src/computer/Computer.ts";
import {
  boxdMachineClient,
  type BoxdMachineClient,
  type BoxdMachineRecord,
} from "../../src/computer/BoxdMachines.ts";
import { sqliteFixture } from "./ProofSqliteFixture.ts";
import { ProofOwnership, type ProofState } from "./Ownership.ts";

type ProofStorage = ReturnType<typeof sqliteFixture>["storage"] & {
  get: (key: string) => Promise<unknown>;
  put: (key: string, value: unknown) => Promise<void>;
  getAlarm: () => Promise<number | null>;
  setAlarm: (timestamp: number) => Promise<void>;
  deleteAlarm: () => Promise<void>;
};

function makeStorage(events: string[]) {
  const sqlite = sqliteFixture();
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage = Object.assign(sqlite.storage, {
    async get(key: string) {
      events.push(`storage:get:${key}`);
      return values.get(key);
    },
    async put(key: string, value: unknown) {
      events.push(`storage:put:${key}`);
      values.set(key, value);
      if (key === "proof-state" && (value as ProofState).cleanupConfirmed) {
        events.push("storage:confirmed");
      }
    },
    async getAlarm() {
      return alarm;
    },
    async setAlarm(timestamp: number) {
      events.push("storage:set-alarm");
      alarm = timestamp;
    },
    async deleteAlarm() {
      events.push("storage:delete-alarm");
      alarm = null;
    },
  }) as ProofStorage;

  return {
    storage: storage as unknown as ConstructorParameters<typeof ProofOwnership>[0],
    read: (key: string) => values.get(key),
    alarm: () => alarm,
    close: sqlite.close,
  };
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

function boxdFake(
  events: string[],
  observeCreate?: (input: Parameters<BoxdMachineClient["machines"]["create"]>[0]) => Promise<void>,
) {
  const machines = new Map<string, BoxdMachineRecord>();
  let creates = 0;
  let forks = 0;
  let deletes = 0;
  let nextId = 1;
  let forkFailure: Error | undefined;
  const client: BoxdMachineClient = {
    machines: {
      async create(input) {
        creates += 1;
        events.push(`provider:create:${input.name}`);
        await observeCreate?.(input);
        const id = `boxd-${nextId++}`;
        machines.set(input.name, machine(input.name, id));
        return { id };
      },
      async fork(_source, input) {
        forks += 1;
        events.push(`provider:fork:${input.name}`);
        if (forkFailure) {
          const error = forkFailure;
          forkFailure = undefined;
          throw error;
        }
        const id = `boxd-${nextId++}`;
        machines.set(input.name, machine(input.name, id));
        return { id };
      },
      async get(name) {
        const found = machines.get(name) ?? null;
        events.push(`provider:get:${name}:${found ? "present" : "absent"}`);
        return found;
      },
      async delete(id) {
        deletes += 1;
        events.push(`provider:delete:${id}`);
        for (const [name, found] of machines) {
          if (found.id === id) machines.delete(name);
        }
      },
      async setDeleteAfter() {},
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
    machines,
    counts: () => ({ creates, forks, deletes }),
    failNextFork(error: Error) {
      forkFailure = error;
    },
  };
}

function lease(sourceRef: string, expiresAt: number): BaseLease {
  return { id: "proof-lease-1", sourceRef, expiresAt, retention: "until-release" };
}

function ownershipClient(client: BoxdMachineClient) {
  return client as unknown as ReturnType<typeof boxdMachineClient>;
}

async function journalFork(ownership: ProofOwnership, base: BaseLease) {
  await ownership.journal.write({ operationId: ownership.commandOperation, phase: "checkpoint" });
  await ownership.journal.write({
    operationId: ownership.commandOperation,
    phase: "create",
    before: { repository: "proof-drive", fork: "proof-thread", commit: "before" },
    base,
    createInput: {
      operationId: ownership.commandOperation,
      drive: ownership.drive,
      recipeHash: ownership.recipeHash,
      base,
      expiresAt: base.expiresAt,
    },
  });
}

async function createSource(ownership: ProofOwnership) {
  const input = await ownership.prepareSourceInput();
  const source = await ownership.source.create(input, new AbortController().signal);
  return { input, source };
}

describe("boxd proof ownership", () => {
  it("saves the source allocation and arms its alarm before source create dispatch", async () => {
    const events: string[] = [];
    const stateAtDispatch: { state: ProofState | undefined; alarm: number | null | undefined } = {
      state: undefined,
      alarm: undefined,
    };
    const storage = makeStorage(events);
    const provider = boxdFake(events, async () => {
      stateAtDispatch.state = (await storage.read("proof-state")) as ProofState | undefined;
      stateAtDispatch.alarm = storage.alarm();
    });
    try {
      const ownership = new ProofOwnership(
        storage.storage,
        "owner-order",
        ownershipClient(provider.client),
      );
      const input = await ownership.prepareSourceInput();
      await ownership.source.create(input, new AbortController().signal);

      const dispatch = events.indexOf(`provider:create:computer-${ownership.sourceOperation}`);
      expect(events.indexOf("storage:set-alarm")).toBeGreaterThanOrEqual(0);
      expect(events.indexOf("storage:set-alarm")).toBeLessThan(dispatch);
      expect(events.indexOf("storage:put:proof-state")).toBeLessThan(dispatch);
      expect(stateAtDispatch.state?.sourceExpiresAt).toBe(input.expiresAt);
      expect(stateAtDispatch.alarm).toBeGreaterThanOrEqual(input.expiresAt);
    } finally {
      storage.close();
    }
  });

  it("reopens cleanup as lookup-only and confirms both exact provider absences first", async () => {
    const events: string[] = [];
    const storage = makeStorage(events);
    const provider = boxdFake(events);
    try {
      const first = new ProofOwnership(
        storage.storage,
        "owner-restart",
        ownershipClient(provider.client),
      );
      const { input, source } = await createSource(first);
      const base = lease(source.id, input.expiresAt);
      await journalFork(first, base);
      const fork = await first.commands.create(
        {
          operationId: first.commandOperation,
          drive: first.drive,
          recipeHash: first.recipeHash,
          base: Option.some(base),
          expiresAt: base.expiresAt,
        },
        new AbortController().signal,
      );

      const sourceName = `computer-${first.sourceOperation}`;
      const forkName = `computer-${first.commandOperation}`;
      const restart = events.length;
      const reopened = new ProofOwnership(
        storage.storage,
        "owner-restart",
        ownershipClient(provider.client),
      );
      expect(await reopened.cleanup(new AbortController().signal)).toBe(true);

      const confirmed = events.indexOf("storage:confirmed", restart);
      const sourceAbsent = events.lastIndexOf(`provider:get:${sourceName}:absent`);
      const forkAbsent = events.lastIndexOf(`provider:get:${forkName}:absent`);
      expect(sourceAbsent).toBeGreaterThan(events.indexOf(`provider:delete:${source.id}`, restart));
      expect(forkAbsent).toBeGreaterThan(events.indexOf(`provider:delete:${fork.id}`, restart));
      expect(sourceAbsent).toBeLessThan(confirmed);
      expect(forkAbsent).toBeLessThan(confirmed);
      expect(provider.machines.size).toBe(0);
      expect((await reopened.read()).cleanupConfirmed).toBe(true);
      expect(storage.alarm()).toBeNull();
      expect(provider.counts()).toEqual({ creates: 1, forks: 1, deletes: 2 });
      expect(
        events
          .slice(restart)
          .some(
            (event) => event.startsWith("provider:create:") || event.startsWith("provider:fork:"),
          ),
      ).toBe(false);
    } finally {
      storage.close();
    }
  });

  it("keeps the source and retries lookup when a fork dispatch stays ambiguous", async () => {
    const events: string[] = [];
    const storage = makeStorage(events);
    const provider = boxdFake(events);
    try {
      const first = new ProofOwnership(
        storage.storage,
        "owner-ambiguous",
        ownershipClient(provider.client),
      );
      const { input, source } = await createSource(first);
      const base = lease(source.id, input.expiresAt);
      await journalFork(first, base);
      provider.failNextFork(new Error("fork acknowledgement was lost"));

      await expect(
        first.commands.create(
          {
            operationId: first.commandOperation,
            drive: first.drive,
            recipeHash: first.recipeHash,
            base: Option.some(base),
            expiresAt: base.expiresAt,
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ disposition: "unknown" });
      const restart = events.length;
      const originalAlarm = storage.alarm();
      if (originalAlarm === null) throw new Error("Source cleanup alarm was not set");
      const reopened = new ProofOwnership(
        storage.storage,
        "owner-ambiguous",
        ownershipClient(provider.client),
      );
      expect(await reopened.cleanup(new AbortController().signal)).toBe(false);

      expect(provider.machines.has(`computer-${first.sourceOperation}`)).toBe(true);
      expect(provider.machines.has(`computer-${first.commandOperation}`)).toBe(false);
      expect((await reopened.read()).cleanupConfirmed).toBe(false);
      expect((await reopened.read()).checks.providerCleanup).toBe("failed");
      const retryAlarm = storage.alarm();
      if (retryAlarm === null) throw new Error("Ambiguous cleanup did not arm a retry");
      expect(retryAlarm).toBeGreaterThan(0);
      expect(retryAlarm).toBeLessThan(originalAlarm);
      expect(provider.counts()).toEqual({ creates: 1, forks: 1, deletes: 0 });
      expect(
        events
          .slice(restart)
          .some(
            (event) => event.startsWith("provider:create:") || event.startsWith("provider:fork:"),
          ),
      ).toBe(false);
      expect(events.slice(restart)).toContain(
        `provider:get:computer-${first.commandOperation}:absent`,
      );
    } finally {
      storage.close();
    }
  });
});
