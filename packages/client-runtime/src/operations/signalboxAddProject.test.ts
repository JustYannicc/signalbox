import { SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addProjectCloneSources,
  addProjectSourceSupport,
  resolveAddProjectAvailability,
} from "./signalboxAddProject.ts";

describe("resolveAddProjectAvailability", () => {
  it("is ready once any environment is connected", () => {
    expect(
      resolveAddProjectAvailability({ catalogReady: true, phases: ["error", "connected"] }),
    ).toBe("ready");
  });

  it("waits while the catalog loads or an environment is connecting", () => {
    expect(resolveAddProjectAvailability({ catalogReady: false, phases: [] })).toBe("connecting");
    expect(resolveAddProjectAvailability({ catalogReady: true, phases: ["connecting"] })).toBe(
      "connecting",
    );
    expect(
      resolveAddProjectAvailability({ catalogReady: true, phases: ["offline", "reconnecting"] }),
    ).toBe("connecting");
  });

  it("asks for a connection only when nothing is on its way", () => {
    expect(resolveAddProjectAvailability({ catalogReady: true, phases: [] })).toBe("unavailable");
    expect(
      resolveAddProjectAvailability({ catalogReady: true, phases: ["offline", "error"] }),
    ).toBe("unavailable");
  });
});

const GITHUB = SourceControlProviderKind.make("github");
const GITLAB = SourceControlProviderKind.make("gitlab");

describe("addProjectSourceSupport", () => {
  it("offers every source on servers that don't report the capabilities", () => {
    const everything = { localFilesystem: true, cloneFromUrl: true };
    expect(addProjectSourceSupport({})).toEqual(everything);
    expect(addProjectSourceSupport(undefined)).toEqual(everything);
  });

  it("drops the sources an environment turns off", () => {
    expect(
      addProjectSourceSupport({
        localFilesystem: false,
        cloneFromUrl: false,
        sourceControlImports: [GITHUB],
      }),
    ).toEqual({ localFilesystem: false, cloneFromUrl: false, sourceControlImports: [GITHUB] });
  });
});

describe("addProjectCloneSources", () => {
  it("leads with Git URL where any URL clones", () => {
    expect(addProjectCloneSources([GITHUB, GITLAB], { cloneFromUrl: true })).toEqual([
      "url",
      GITHUB,
      GITLAB,
    ]);
  });

  it("offers only the hosts the environment imports from", () => {
    expect(
      addProjectCloneSources([GITHUB, GITLAB], {
        cloneFromUrl: false,
        sourceControlImports: [GITHUB],
      }),
    ).toEqual([GITHUB]);
  });
});
