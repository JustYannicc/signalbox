import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { visibleProjectCheckouts } from "./settingsProjectOverview.logic";

function project(id: string, environmentId: string) {
  return { id: ProjectId.make(id), environmentId: EnvironmentId.make(environmentId) };
}

function target(environmentId: string, localFilesystem?: boolean) {
  return {
    environmentId: EnvironmentId.make(environmentId),
    serverConfig: { environment: { capabilities: { localFilesystem } } },
  };
}

describe("visibleProjectCheckouts", () => {
  it("hides Cloud checkouts while retaining self-hosted checkouts", () => {
    const cloud = project("cloud-project", "cloud");
    const selfHosted = project("local-project", "self-hosted");

    expect(
      visibleProjectCheckouts([cloud, selfHosted], [target("cloud", false), target("self-hosted")]),
    ).toEqual([selfHosted]);
  });

  it("shows checkout details while filesystem capability is unknown", () => {
    const selfHosted = project("local-project", "self-hosted");
    expect(visibleProjectCheckouts([selfHosted], [target("self-hosted")])).toEqual([selfHosted]);
  });
});
