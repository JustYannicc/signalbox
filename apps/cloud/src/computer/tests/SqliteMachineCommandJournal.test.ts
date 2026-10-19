import { describe, expect, it } from "vite-plus/test";
import type { BaseLease } from "../Computer.ts";
import type { MachineCommandRecord } from "../MachineCommandJournal.ts";
import { SqliteMachineCommandJournal } from "../adapters/SqliteMachineCommandJournal.ts";
import { createMachineFixture } from "./helpers/machineFixture.ts";
import { createTestFilesystem } from "./helpers/filesystem.ts";

const before = { repository: "drive-repository", fork: "thread-fork", commit: "before" };
const base: BaseLease = {
  id: "warm-base",
  sourceRef: "recipe:snapshot",
  expiresAt: 1_900_000_000_000,
};

describe("SqliteMachineCommandJournal", () => {
  it("persists an interrupted command for inspection without replaying it on reopen", async () => {
    const fixture = createTestFilesystem();
    try {
      const first = new SqliteMachineCommandJournal(fixture.storage);
      const records: MachineCommandRecord[] = [
        { operationId: "interrupted-op", phase: "checkpoint" },
        { operationId: "interrupted-op", phase: "create", before, base },
        {
          operationId: "interrupted-op",
          phase: "execute",
          before,
          base,
          machine: { id: "local-machine-1", generation: 7 },
        },
      ];
      for (const record of records) await first.write(record);

      const reopened = new SqliteMachineCommandJournal(fixture.storage);
      const commands = createMachineFixture({ journal: reopened });

      expect(reopened.pending()).toEqual([records.at(-1)]);
      expect(commands.createCalls).toHaveLength(0);
      expect(commands.spawnCalls).toHaveLength(0);
      expect(commands.events).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it("rejects checkpoint identity reuse and backward transitions without changing the record", async () => {
    const fixture = createTestFilesystem();
    try {
      const journal = new SqliteMachineCommandJournal(fixture.storage);
      await journal.write({ operationId: "op-one", phase: "checkpoint" });
      await journal.write({ operationId: "op-one", phase: "create", before, base });

      await expect(journal.write({ operationId: "op-one", phase: "checkpoint" })).rejects.toThrow(
        "identity was reused or its phase moved backwards",
      );
      await expect(
        journal.write({ operationId: "op-one", phase: "prepare", before, base }),
      ).resolves.toBeUndefined();
      await expect(
        journal.write({ operationId: "op-one", phase: "create", before, base }),
      ).rejects.toThrow("identity was reused or its phase moved backwards");

      expect(journal.pending()).toEqual([
        { operationId: "op-one", phase: "prepare", before, base },
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
        journal.write({ operationId: "op-two", phase: "create", before, base }),
      ).rejects.toThrow("Machine command must be recorded before external work starts");

      await journal.write({ operationId: "op-two", phase: "checkpoint" });
      await journal.write({ operationId: "op-two", phase: "complete", before, base });
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
});
