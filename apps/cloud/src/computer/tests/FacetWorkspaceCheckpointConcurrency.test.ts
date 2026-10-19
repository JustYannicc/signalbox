import { describe, expect, it } from "vite-plus/test";
import { createFacetWorkspace } from "../FacetWorkspace.ts";
import { base, makeLocalFile, rig } from "./FacetWorkspaceFixture.ts";

const signal = () => new AbortController().signal;
const attemptCount = (fixture: ReturnType<typeof rig>) =>
  Number(
    [...fixture.storage.sql.exec("SELECT COUNT(*) AS count FROM kernel_fs_workspace_attempt")][0]
      ?.count,
  );

describe("facet checkpoint concurrency and recovery", () => {
  it("serializes distinct checkpoint operations and starts the next from the saved revision", async () => {
    const fixture = rig([{ path: "/seed", bytes: new Uint8Array() }]);
    const originalCommitTurn = fixture.persistence.commitTurn;
    let started!: () => void;
    let release!: () => void;
    const firstCommitStarted = new Promise<void>((resolve) => (started = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls: string[] = [];
    try {
      makeLocalFile(fixture.persistence.storage, "/seed", new Uint8Array());
      fixture.persistence.commitTurn = async (input) => {
        calls.push(input.turnId);
        if (input.turnId === "checkpoint-one") {
          started();
          await gate;
        }
        return originalCommitTurn(input);
      };
      const first = fixture.workspace.checkpoint("checkpoint-one", signal());
      await firstCommitStarted;
      const second = fixture.workspace.checkpoint("checkpoint-two", signal());
      release();

      const [firstCommit, secondCommit] = await Promise.all([first, second]);
      expect(secondCommit.commit).not.toBe(firstCommit.commit);
      expect(calls).toEqual(["checkpoint-one", "checkpoint-two"]);
      expect(attemptCount(fixture)).toBe(0);
      expect(
        [...fixture.storage.sql.exec("SELECT commit_id FROM kernel_fs_workspace_state")][0]
          ?.commit_id,
      ).toBe(secondCommit.commit);
    } finally {
      release();
      fixture.persistence.commitTurn = originalCommitTurn;
      fixture.close();
    }
  });

  it("replays a checkpoint attempt after the owner restarts", async () => {
    const fixture = rig([{ path: "/seed", bytes: new Uint8Array() }]);
    const originalCommitTurn = fixture.persistence.commitTurn;
    try {
      makeLocalFile(fixture.persistence.storage, "/seed", new Uint8Array());
      fixture.persistence.commitTurn = async () => {
        throw new Error("interrupted before the persistence snapshot completed");
      };
      await expect(fixture.workspace.checkpoint("restart-checkpoint", signal())).rejects.toThrow(
        "interrupted before the persistence snapshot completed",
      );
      expect(attemptCount(fixture)).toBe(1);

      fixture.persistence.commitTurn = originalCommitTurn;
      const reopened = createFacetWorkspace({
        database: fixture.storage,
        persistence: fixture.persistence,
        filesystem: fixture.filesystem,
        mountPath: "/",
        initial: base,
        mount: async () => {
          throw new Error("Machine mount is outside this test");
        },
      });
      const recovered = await reopened.checkpoint("restart-checkpoint", signal());

      expect(fixture.ports.committedTurns).toHaveLength(1);
      expect(attemptCount(fixture)).toBe(0);
      expect(recovered.commit).toBe(fixture.ports.committedTurns[0]?.receipt.commit);
    } finally {
      fixture.persistence.commitTurn = originalCommitTurn;
      fixture.close();
    }
  });
});
