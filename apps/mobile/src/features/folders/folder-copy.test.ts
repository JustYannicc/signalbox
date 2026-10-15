import type { MenuAction } from "@react-native-menu/menu";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  PERSONAL_CONTEXT_ID,
  SignalboxContextId,
  type SignalboxContextsSnapshot,
} from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";

import { buildHomeListFilterMenu } from "../home/home-list-filter-menu";
import {
  folderCopy,
  folderWording,
  scratchCopy,
  scratchLevelName,
  withFolderFilterActionsCopy,
  withFolderFilterMenuCopy,
  withScratchScopeTitles,
} from "./folder-copy";

const UPSTREAM_STRINGS = [
  "Project",
  "All projects",
  "Show threads from every project",
  "Choose a project",
  "Opens the project picker",
  "Choose another project or create a new task.",
  "Choose a project for the 2 images you shared",
];

describe("project copy where folders exist", () => {
  it("keeps upstream's words where no environment has folders", () => {
    const wording = folderWording({ withFolders: 0, total: 2 });
    for (const text of UPSTREAM_STRINGS) expect(folderCopy(text, wording)).toBe(text);
  });

  it("says folder where every environment has them", () => {
    const wording = folderWording({ withFolders: 1, total: 1 });
    expect(folderCopy("All projects", wording)).toBe("All folders");
    expect(folderCopy("Show threads from every project", wording)).toBe(
      "Show threads from every folder",
    );
    expect(folderCopy("Choose a project", wording)).toBe("Choose a folder");
    expect(folderCopy("Opens the project picker", wording)).toBe("Opens the folder picker");
    expect(folderCopy("Choose another project or create a new task.", wording)).toBe(
      "Choose another folder or create a new task.",
    );
    expect(folderCopy("Choose a project for the image you shared", wording)).toBe(
      "Choose a folder for the image you shared",
    );
  });

  it("uses words that fit both while they're mixed", () => {
    const wording = folderWording({ withFolders: 1, total: 2 });
    for (const text of UPSTREAM_STRINGS) {
      expect(folderCopy(text, wording)).not.toMatch(/project|folder/i);
    }
  });

  it("leaves text it doesn't know alone, like a project's own name", () => {
    expect(folderCopy("signalbox", "folders")).toBe("signalbox");
  });
});

describe("the thread list's filter menus", () => {
  const noop = () => {};
  const projects = [{ key: "a", label: "Project" }];

  it("rewords the project filter but not the projects in it", () => {
    const menu = withFolderFilterMenuCopy(
      buildHomeListFilterMenu({
        environments: [],
        projects,
        selectedEnvironmentId: null,
        selectedProjectKey: null,
        onEnvironmentChange: noop,
        onProjectChange: noop,
        showsEnvironments: false,
      }),
      (text) => folderCopy(text, "folders"),
    );
    expect(menu.items).toMatchObject([
      {
        type: "submenu",
        title: "Folder",
        items: [
          { title: "All folders", subtitle: "Show threads from every folder" },
          { title: "Project" },
        ],
      },
    ]);
  });

  it("rewords Android's project filter by its ids", () => {
    const actions: MenuAction[] = [
      { id: "environment", title: "Environment" },
      {
        id: "project",
        title: "Project",
        subactions: [
          { id: "project:all", title: "All projects" },
          { id: "project:a", title: "Project" },
        ],
      },
    ];
    expect(withFolderFilterActionsCopy(actions, (text) => folderCopy(text, "folders"))).toEqual([
      { id: "environment", title: "Environment" },
      {
        id: "project",
        title: "Folder",
        subactions: [
          { id: "project:all", title: "All folders" },
          { id: "project:a", title: "Project" },
        ],
      },
    ]);
  });
});

describe("starting without a project", () => {
  const scratchId = ProjectId.make("scratch");
  const owners: SignalboxContextsSnapshot = {
    contexts: [
      { id: PERSONAL_CONTEXT_ID, kind: "personal", name: "Personal", projectIds: [] },
      {
        id: SignalboxContextId.make("org_1"),
        kind: "organization",
        name: "Acme",
        projectIds: [scratchId],
      },
    ],
  };

  it("keeps upstream's No project without folders", () => {
    expect(scratchLevelName(null, scratchId)).toBeNull();
    expect(scratchCopy(null).title).toBe("No project");
  });

  it("names the owner whose scratch project it is", () => {
    expect(scratchLevelName(owners, scratchId)).toBe("Acme");
  });

  it("names Personal before the scratch project exists", () => {
    expect(scratchLevelName(owners, null)).toBe("Personal");
  });

  it("starts at that level rather than without a home", () => {
    expect(scratchCopy("Personal")).toEqual({
      title: "Personal",
      subtitle: "Start a task in Personal",
      start: "Start in Personal",
      failed: "Could not start in Personal",
    });
  });
});

describe("the thread list's group for threads without a project", () => {
  const environmentId = EnvironmentId.make("cloud");
  const scratchId = ProjectId.make("scratch");
  const owners: SignalboxContextsSnapshot = {
    contexts: [
      { id: PERSONAL_CONTEXT_ID, kind: "personal", name: "Personal", projectIds: [scratchId] },
    ],
  };
  const scratch = {
    title: "No project",
    representative: { environmentId, id: scratchId, isScratch: true as const },
  };
  const drive = {
    title: "No project",
    representative: { environmentId, id: ProjectId.make("drive") },
  };

  it("takes its owner's name where folders exist", () => {
    expect(withScratchScopeTitles([scratch, drive], () => owners).map((s) => s.title)).toEqual([
      "Personal",
      "No project",
    ]);
  });

  it("stays the same list without folders", () => {
    const scopes = [scratch, drive];
    expect(withScratchScopeTitles(scopes, () => undefined)).toBe(scopes);
  });
});
