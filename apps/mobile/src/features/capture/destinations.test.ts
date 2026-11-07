import { describe, expect, it } from "vite-plus/test";

import { resolveCaptureTargetSelection, resolveCaptureTargets } from "./destinations";
import {
  ACME_FILES,
  DRIVE,
  ENVIRONMENT,
  PERSONAL_FILES,
  owners,
  snapshot,
} from "../folders/folder-fixtures.test-support";

describe("resolveCaptureTargets", () => {
  it("defaults to the personal top level and keeps each folder's project context", () => {
    const { targets, personal } = resolveCaptureTargets(
      new Map([[ENVIRONMENT, { snapshot, owners }]]),
      [
        { environmentId: ENVIRONMENT, id: PERSONAL_FILES },
        { environmentId: ENVIRONMENT, id: ACME_FILES },
        { environmentId: ENVIRONMENT, id: DRIVE },
      ],
    );

    expect(personal?.destination.label).toBe("Top level");
    expect(personal?.start.projectId).toBe(PERSONAL_FILES);
    expect(
      targets.find((target) => target.destination.label === "Work / Clients")?.start,
    ).toMatchObject({ projectId: PERSONAL_FILES, file: true });
    expect(
      targets.find((target) => target.destination.label === "Work / Clients / Northwind")?.start,
    ).toMatchObject({ projectId: DRIVE, file: false });
  });

  it("has no default when the personal project is unavailable", () => {
    const { personal } = resolveCaptureTargets(new Map([[ENVIRONMENT, { snapshot, owners }]]), [
      { environmentId: ENVIRONMENT, id: ACME_FILES },
    ]);

    expect(personal).toBeNull();
  });
});

describe("resolveCaptureTargetSelection", () => {
  const { targets, personal } = resolveCaptureTargets(
    new Map([[ENVIRONMENT, { snapshot, owners }]]),
    [
      { environmentId: ENVIRONMENT, id: PERSONAL_FILES },
      { environmentId: ENVIRONMENT, id: ACME_FILES },
      { environmentId: ENVIRONMENT, id: DRIVE },
    ],
  );

  it("does not fall back to the current account's personal target when the latched target is gone", () => {
    if (!personal) throw new Error("fixture has no personal target");
    expect(
      resolveCaptureTargetSelection(targets, "previous-account:personal:top", null),
    ).toBeNull();
  });

  it("uses an explicit valid destination and leaves a missing explicit pick unresolved", () => {
    if (!personal) throw new Error("fixture has no personal target");
    const otherTarget = targets.find(
      (target) => target.destination.key !== personal.destination.key,
    );
    if (!otherTarget) throw new Error("fixture has no alternate target");
    expect(
      resolveCaptureTargetSelection(
        targets,
        "previous-account:personal:top",
        otherTarget.destination.key,
      ),
    ).toBe(otherTarget);
    expect(
      resolveCaptureTargetSelection(targets, personal.destination.key, "removed-folder"),
    ).toBeNull();
  });
});
