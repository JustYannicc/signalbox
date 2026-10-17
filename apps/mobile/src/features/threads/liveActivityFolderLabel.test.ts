import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ACME_FILES,
  DRIVE,
  PERSONAL_FILES,
  owners,
  snapshot,
} from "../folders/folder-fixtures.test-support";
import { liveActivityFolderLabel } from "./liveActivityFolderLabel";

describe("liveActivityFolderLabel", () => {
  it("uses a thread's explicit folder, including its top-level home", () => {
    expect(
      liveActivityFolderLabel(snapshot, owners, {
        id: ThreadId.make("filed"),
        projectId: PERSONAL_FILES,
      }),
    ).toBe("Clients");
    expect(
      liveActivityFolderLabel(snapshot, owners, {
        id: ThreadId.make("unfiled"),
        projectId: DRIVE,
      }),
    ).toBe("Top level");
  });

  it("falls back to the project's folder and returns null when the home is unknown", () => {
    expect(
      liveActivityFolderLabel(snapshot, owners, {
        id: ThreadId.make("project-home"),
        projectId: DRIVE,
      }),
    ).toBe("Northwind");
    expect(
      liveActivityFolderLabel(snapshot, owners, {
        id: ThreadId.make("missing"),
        projectId: ProjectId.make("missing"),
      }),
    ).toBeNull();
    expect(
      liveActivityFolderLabel(snapshot, owners, {
        id: ThreadId.make("organization"),
        projectId: ACME_FILES,
      }),
    ).toBe("Acme");
  });
});
