import { SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { addProjectCloneSources, addProjectSourceSupport } from "./signalboxAddProject.logic";

const GITHUB = SourceControlProviderKind.make("github");
const GITLAB = SourceControlProviderKind.make("gitlab");

describe("addProjectSourceSupport", () => {
  it("offers every source on servers that don't report the capabilities", () => {
    expect(addProjectSourceSupport({})).toEqual({ localFilesystem: true, cloneFromUrl: true });
    expect(addProjectSourceSupport(undefined)).toEqual({
      localFilesystem: true,
      cloneFromUrl: true,
    });
  });

  it("drops the sources an environment turns off", () => {
    expect(addProjectSourceSupport({ localFilesystem: false, cloneFromUrl: false })).toEqual({
      localFilesystem: false,
      cloneFromUrl: false,
    });
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

  it("offers only the hosts where only they import", () => {
    expect(addProjectCloneSources([GITHUB], { cloneFromUrl: false })).toEqual([GITHUB]);
  });
});
