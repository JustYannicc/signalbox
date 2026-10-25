import { captureDestinations } from "@t3tools/client-runtime/capture/destinations";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { FolderId, type SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";
import { expect, it } from "vite-plus/test";

it("keeps each destination's owner and environment when folders share a name", () => {
  const personal = SignalboxContextId.make("personal");
  const work = SignalboxContextId.make("org-work");
  const personalProject = ProjectId.make("scratch");
  const workProject = ProjectId.make("context:org-work");
  const snapshot: SignalboxFoldersSnapshot = {
    revision: 0,
    top: {},
    folders: [
      {
        id: FolderId.make("personal-notes"),
        name: "Notes",
        parentId: null,
        ownerId: personal,
        position: 0,
      },
      {
        id: FolderId.make("work-notes"),
        name: "Notes",
        parentId: null,
        ownerId: work,
        position: 0,
      },
    ],
    threadHomes: [],
    projectHomes: [],
    pools: { top: null, folders: [] },
  };
  const environmentId = EnvironmentId.make("capture-environment");
  const choices = captureDestinations([
    {
      environmentId,
      snapshot,
      contexts: {
        contexts: [
          { id: personal, name: "Personal", kind: "personal", projectIds: [personalProject] },
          { id: work, name: "Work", kind: "organization", projectIds: [workProject] },
          {
            id: SignalboxContextId.make("unavailable"),
            name: "Unavailable",
            kind: "organization",
            projectIds: [],
          },
        ],
      },
    },
  ]);

  expect(
    choices.map((choice) => [choice.label, choice.folderId, choice.ownerProjectId, choice.detail]),
  ).toEqual([
    ["Top level", null, personalProject, null],
    ["Work", null, workProject, null],
    ["Notes", "personal-notes", personalProject, null],
    ["Notes", "work-notes", workProject, "Work"],
  ]);
  expect(choices.every((choice) => choice.environmentId === environmentId)).toBe(true);
  expect(new Set(choices.map((choice) => choice.key)).size).toBe(choices.length);
});
