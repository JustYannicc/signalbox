import { describe, expect, it } from "vite-plus/test";
import type { BaseLease } from "../Computer.ts";
import type { MachineCommandRecord } from "../MachineCommandJournal.ts";
import { SqliteMachineCommandJournal } from "../SqliteMachineCommandJournal.ts";
import { createMachineFixture } from "./helpers/machineFixture.ts";
import { createTestFilesystem } from "./helpers/filesystem.ts";

const before = { repository: "drive-repository", fork: "thread-fork", commit: "before" };
const base: BaseLease = {
  id: "warm-base",
  sourceRef: "recipe:snapshot",
  expiresAt: 1_900_000_000_000,
  retention: "until-release",
};
const legacyBase: BaseLease = {
  id: "legacy-base",
  sourceRef: "recipe:legacy-snapshot",
  expiresAt: 1_900_000_000_000,
};
const createInput = (operationId: string, lease: BaseLease = base) => ({
  operationId,
  drive: "drive:one",
  recipeHash: "recipe:one",
  base: lease,
  expiresAt: lease.expiresAt,
});

describe("SqliteMachineCommandJournal", () => {
  it("persists an interrupted command for inspection without replaying it on reopen", async () => {
    const fixture = createTestFilesystem();
    try {
      const first = new SqliteMachineCommandJournal(fixture.storage);
      const records: MachineCommandRecord[] = [
        { operationId: "interrupted-op", phase: "checkpoint" },
        {
          operationId: "interrupted-op",
          phase: "create",
          before,
          base,
          createInput: createInput("interrupted-op"),
        },
        {
          operationId: "interrupted-op",
          phase: "execute",
          before,
          base,
          createInput: createInput("interrupted-op"),
          machine: { id: "local-machine-1", generation: 7 },
        },
      ];
      for (const record of records) await first.write(record);

      const reopened = new SqliteMachineCommandJournal(fixture.storage);
      const commands = createMachineFixture({ journal: reopened });

      expect(reopened.pending()).toEqual([records.at(-1)]);
      expect(reopened.read("interrupted-op")).toEqual(records.at(-1));
      expect(commands.createCalls).toHaveLength(0);
      expect(commands.spawnCalls).toHaveLength(0);
      expect(commands.events).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it("round-trips the durable hold marker and keeps legacy Base records readable", async () => {
    const fixture = createTestFilesystem();
    try {
      const journal = new SqliteMachineCommandJournal(fixture.storage);
      await journal.write({ operationId: "supported-op", phase: "checkpoint" });
      await journal.write({
        operationId: "supported-op",
        phase: "create",
        before,
        base,
        createInput: createInput("supported-op"),
      });
      await journal.write({ operationId: "legacy-op", phase: "checkpoint" });
      await journal.write({
        operationId: "legacy-op",
        phase: "create",
        before,
        base: legacyBase,
        createInput: createInput("legacy-op", legacyBase),
      });

      const reopened = new SqliteMachineCommandJournal(fixture.storage);
      expect(reopened.read("supported-op")?.base?.retention).toBe("until-release");
      expect(reopened.read("supported-op")?.createInput?.base).toEqual(base);
      expect(reopened.read("legacy-op")?.base).toEqual(legacyBase);
      expect(reopened.read("legacy-op")?.createInput?.base).toEqual(legacyBase);
    } finally {
      fixture.close();
    }
  });

  it("requires the journaled Base copies to agree on durable retention", async () => {
    const fixture = createTestFilesystem();
    try {
      const journal = new SqliteMachineCommandJournal(fixture.storage);
      const legacyCopy: BaseLease = {
        id: base.id,
        sourceRef: base.sourceRef,
        expiresAt: base.expiresAt,
      };
      await journal.write({ operationId: "retention-op", phase: "checkpoint" });
      await journal.write({
        operationId: "retention-op",
        phase: "create",
        before,
        base,
        createInput: createInput("retention-op"),
      });

      await expect(
        journal.write({
          operationId: "retention-op",
          phase: "create",
          before,
          base,
          createInput: createInput("retention-op", legacyCopy),
        }),
      ).rejects.toThrow("Machine create Base does not match the journaled lease");
      expect(journal.read("retention-op")?.createInput?.base).toEqual(base);
    } finally {
      fixture.close();
    }
  });

  it("rejects checkpoint identity reuse and backward transitions without changing the record", async () => {
    const fixture = createTestFilesystem();
    try {
      const journal = new SqliteMachineCommandJournal(fixture.storage);
      await journal.write({ operationId: "op-one", phase: "checkpoint" });
      await journal.write({
        operationId: "op-one",
        phase: "create",
        before,
        base,
        createInput: createInput("op-one"),
      });

      await expect(journal.write({ operationId: "op-one", phase: "checkpoint" })).rejects.toThrow(
        "identity was reused or its phase moved backwards",
      );
      await expect(
        journal.write({
          operationId: "op-one",
          phase: "prepare",
          before,
          base,
          createInput: createInput("op-one"),
        }),
      ).resolves.toBeUndefined();
      await expect(
        journal.write({
          operationId: "op-one",
          phase: "create",
          before,
          base,
          createInput: createInput("op-one"),
        }),
      ).rejects.toThrow("identity was reused or its phase moved backwards");

      expect(journal.pending()).toEqual([
        {
          operationId: "op-one",
          phase: "prepare",
          before,
          base,
          createInput: createInput("op-one"),
        },
      ]);
    } finally {
      fixture.close();
    }
  });

  it("requires a checkpoint record before transitions and keeps completed rows out of pending", async () => {
    const fixture = createTestFilesystem();
    try {
      const journal = new SqliteMachineCommandJournal(fixture.storage);
      await expect(
        journal.write({
          operationId: "op-two",
          phase: "create",
          before,
          base,
          createInput: createInput("op-two"),
        }),
      ).rejects.toThrow("Machine command must be recorded before external work starts");

      await journal.write({ operationId: "op-two", phase: "checkpoint" });
      await journal.write({
        operationId: "op-two",
        phase: "complete",
        before,
        base,
        createInput: createInput("op-two"),
      });
      expect(journal.pending()).toEqual([]);
      await expect(journal.write({ operationId: "op-two", phase: "checkpoint" })).rejects.toThrow(
        "identity was reused or its phase moved backwards",
      );
    } finally {
      fixture.close();
    }
  });

  it("validates persisted record fields before opening the transaction", async () => {
    const fixture = createTestFilesystem();
    try {
      const journal = new SqliteMachineCommandJournal(fixture.storage);
      const invalid = {
        operationId: "bad-op",
        phase: "not-a-phase",
      } as unknown as MachineCommandRecord;

      await expect(journal.write(invalid)).rejects.toThrow();
      expect(journal.pending()).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it("locks exact machine create inputs once a create phase is recorded", async () => {
    const fixture = createTestFilesystem();
    try {
      const journal = new SqliteMachineCommandJournal(fixture.storage);
      await journal.write({ operationId: "op-three", phase: "checkpoint" });
      await expect(
        journal.write({
          operationId: "op-three",
          phase: "create",
          before,
          base,
          createInput: createInput("op-three"),
        }),
      ).resolves.toBeUndefined();

      await expect(
        journal.write({
          operationId: "op-three",
          phase: "create",
          before,
          base,
          createInput: { ...createInput("op-three"), expiresAt: base.expiresAt + 1 },
        }),
      ).rejects.toThrow("Machine command createInput changed after it was journaled");
      expect(journal.read("op-three")?.createInput).toEqual(createInput("op-three"));
    } finally {
      fixture.close();
    }
  });

  it("locks the provider closure proof once the command is settled", async () => {
    const fixture = createTestFilesystem();
    try {
      const journal = new SqliteMachineCommandJournal(fixture.storage);
      await journal.write({ operationId: "op-four", phase: "checkpoint" });
      await journal.write({
        operationId: "op-four",
        phase: "create",
        before,
        base,
        createInput: createInput("op-four"),
      });
      const settled = {
        operationId: "op-four",
        machineId: "machine-one",
        generation: 4,
        closed: true as const,
      };
      await journal.write({
        operationId: "op-four",
        phase: "execute",
        before,
        base,
        createInput: createInput("op-four"),
        machine: { id: "machine-one", generation: 4 },
      });
      await journal.write({
        operationId: "op-four",
        phase: "commit",
        before,
        base,
        createInput: createInput("op-four"),
        machine: { id: "machine-one", generation: 4 },
        settled,
      });

      await expect(
        journal.write({
          operationId: "op-four",
          phase: "commit",
          before,
          base,
          createInput: createInput("op-four"),
          machine: { id: "machine-one", generation: 4 },
          settled: { ...settled, generation: 5 },
        }),
      ).rejects.toThrow("Machine command settled changed after it was journaled");
      expect(journal.read("op-four")?.settled).toEqual(settled);
    } finally {
      fixture.close();
    }
  });
});
