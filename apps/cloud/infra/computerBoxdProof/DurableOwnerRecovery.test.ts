import { describe, expect, it } from "@effect/vitest";
import { SqliteMachineCommandJournal } from "../../src/computer/SqliteMachineCommandJournal.ts";
import { createDurableProofRevisionPorts } from "./DurableRevisionPorts.ts";
import { sqliteFixture } from "./ProofSqliteFixture.ts";
import {
  createExternalState,
  createFreshOwner,
  inspectBaseLeases,
  leaveExecutionPending,
  ownerBefore,
  ownerBeforeBytes,
  ownerOperationId,
  ownerOutputBytes,
  seedBefore,
} from "./DurableOwnerRecoveryFixture.ts";

describe("durable Computer owner replacement", () => {
  it("recovers an execute cut through fresh adapters and the same SQLite journal", async () => {
    const sqlite = sqliteFixture();
    const external = createExternalState();
    try {
      seedBefore(sqlite.storage);
      const interrupted = await leaveExecutionPending(sqlite.storage, external);
      expect(interrupted?.phase).toBe("execute");
      expect(interrupted?.before).toEqual(ownerBefore);
      expect(interrupted?.base?.retention).toBe("until-release");
      expect(external.commandStarts).toBe(1);

      const replacement = createFreshOwner(sqlite.storage, external);
      await expect(replacement.recoverPending()).rejects.toThrow(
        "Runner closure ownership is unknown",
      );
      expect(new SqliteMachineCommandJournal(sqlite.storage).read(ownerOperationId)?.phase).toBe(
        "execute",
      );
      expect(inspectBaseLeases(sqlite.storage, external)).toEqual({
        acquired: 1,
        released: 0,
        held: 1,
      });
      expect(external.forkCalls).toBe(1);
      expect(external.applyCalls).toBe(0);

      external.commandClosed = true;
      const commitOwner = createFreshOwner(sqlite.storage, external, { loseCommitAck: true });
      await expect(commitOwner.recoverPending()).rejects.toThrow(
        "Command workspace revision could not be committed",
      );
      const afterAckLoss = new SqliteMachineCommandJournal(sqlite.storage).read(ownerOperationId);
      expect(afterAckLoss?.phase).toBe("commit");
      expect(afterAckLoss?.after).toBeUndefined();
      expect(
        createDurableProofRevisionPorts(sqlite.storage).inspectTree(ownerBefore)?.["/out.bin"]
          ?.data,
      ).toEqual(ownerBeforeBytes);
      expect(inspectBaseLeases(sqlite.storage, external).held).toBe(1);

      const applyOwner = createFreshOwner(sqlite.storage, external, { loseApplyAck: true });
      await expect(applyOwner.recoverPending()).rejects.toThrow(
        "Workspace apply acknowledgement was lost",
      );
      const afterApplyAckLoss = new SqliteMachineCommandJournal(sqlite.storage).read(
        ownerOperationId,
      );
      expect(afterApplyAckLoss?.phase).toBe("apply");
      expect(afterApplyAckLoss?.after).toEqual({ ...ownerBefore, commit: "durable-proof-2" });
      expect(external.applied).toMatchObject({
        before: ownerBefore.commit,
        after: "durable-proof-2",
        path: "/out.bin",
        inode: 73n,
        bytes: ownerOutputBytes,
      });
      expect(external.deleteCalls).toBe(0);
      expect(external.baseReleaseCalls).toBe(0);
      expect(inspectBaseLeases(sqlite.storage, external).held).toBe(1);

      const finalOwner = createFreshOwner(sqlite.storage, external, { recoveryOnly: true });
      await finalOwner.recoverPending();
      const completed = new SqliteMachineCommandJournal(sqlite.storage).read(ownerOperationId);
      expect(completed?.phase).toBe("complete");
      expect(completed?.before).toEqual(ownerBefore);
      expect(completed?.after).toEqual({ ...ownerBefore, commit: "durable-proof-2" });
      const after = completed?.after;
      if (!after) throw new Error("Recovery did not persist its Drive revision");
      const revisions = createDurableProofRevisionPorts(sqlite.storage);
      expect(revisions.inspectTree(ownerBefore)?.["/out.bin"]?.data).toEqual(ownerBeforeBytes);
      expect(revisions.inspectTree(after)?.["/out.bin"]).toMatchObject({
        inode: 73n,
        data: ownerOutputBytes,
      });
      expect(revisions.committedTurns).toHaveLength(1);
      expect(revisions.committedTurns[0]?.receipt).toEqual({ commit: "durable-proof-2" });
      expect(external.applied).toEqual({
        before: ownerBefore.commit,
        after: "durable-proof-2",
        path: "/out.bin",
        inode: 73n,
        bytes: ownerOutputBytes,
      });
      expect(external.mountIds).toEqual([1, 2, 3, 4]);
      expect(external.applyCalls).toBe(1);
      expect(external.applyAttempts).toBe(2);
      expect(external.commandStarts).toBe(1);
      expect(external.forkCalls).toBe(1);
      expect(external.deleteCalls).toBe(1);
      expect(external.baseReleaseCalls).toBe(1);

      await finalOwner.recoverPending();
      expect(external.applyCalls).toBe(1);
      expect(external.deleteCalls).toBe(1);
      expect(external.baseReleaseCalls).toBe(1);
      expect(external.commandStarts).toBe(1);
    } finally {
      sqlite.close();
    }
  });
});
