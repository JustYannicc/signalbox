import { ProjectId, ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { FolderId, type SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../../state/signalboxFolders", () => ({ environmentFoldersAtom: {} }));

import { draftFiledAway } from "./draftFiling";

const SCRATCH = ProjectId.make("scratch");
const draft = {
  environmentId: "cloud" as EnvironmentId,
  threadId: ThreadId.make("draft-thread"),
  projectId: SCRATCH,
};
const snapshot = (filed: boolean): SignalboxFoldersSnapshot => ({
  revision: 1,
  top: {},
  folders: [],
  threadHomes: filed ? [{ threadId: draft.threadId, folderId: FolderId.make("notes") }] : [],
  projectHomes: [{ projectId: SCRATCH, folderId: null }],
  pools: { top: null, folders: [] },
});

describe("draftFiledAway", () => {
  it("never holds a draft back where the environment keeps no folders", () => {
    expect(draftFiledAway(undefined, draft)).toBe(false);
  });

  it("reads the folders once they've arrived", () => {
    expect(draftFiledAway({ snapshot: snapshot(true), error: null }, draft)).toBe(true);
    expect(draftFiledAway({ snapshot: snapshot(false), error: null }, draft)).toBe(false);
  });

  // Opening the app runs "/" before the folders arrive; reusing then put the draft in its folder.
  it("treats a draft as filed while the folders haven't arrived", () => {
    expect(draftFiledAway({ snapshot: null, error: null }, draft)).toBe(true);
  });
});
