import { EnvironmentId, ProjectId, type DesktopCaptureOwner } from "@t3tools/contracts";
import type { CaptureDestination } from "@t3tools/client-runtime/capture/destinations";
import { describe, expect, it } from "vite-plus/test";
import { captureFolderSnapshotsResolved, captureOwnerIsAvailable } from "./captureCoordinatorState";

const environmentId = EnvironmentId.make("environment-one");
const owner: DesktopCaptureOwner = {
  environmentId,
  ownerProjectId: ProjectId.make("project-one"),
};

describe("desktop capture coordinator state", () => {
  it("waits for folder and context snapshots but accepts a resolved empty snapshot", () => {
    expect(captureFolderSnapshotsResolved(new Map(), new Map())).toBe(false);
    expect(
      captureFolderSnapshotsResolved(new Map([[environmentId, { snapshot: null }]]), new Map()),
    ).toBe(false);
    expect(
      captureFolderSnapshotsResolved(
        new Map([[environmentId, { snapshot: [] }]]),
        new Map([[environmentId, {}]]),
      ),
    ).toBe(true);
  });

  it("keeps folder recovery scoped to an owner with at least one current destination", () => {
    const top: CaptureDestination = {
      key: "environment-one:project-one:top",
      ...owner,
      folderId: null,
      label: "Top level",
      detail: null,
      inPlace: "at the top level",
    };
    const other: CaptureDestination = {
      ...top,
      key: "environment-two:project-two:top",
      environmentId: EnvironmentId.make("environment-two"),
      ownerProjectId: ProjectId.make("project-two"),
    };

    expect(captureOwnerIsAvailable(owner, [top])).toBe(true);
    expect(captureOwnerIsAvailable(owner, [other])).toBe(false);
    expect(captureOwnerIsAvailable(undefined, [top])).toBe(false);
  });
});
