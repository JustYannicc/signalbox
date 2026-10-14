import { SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { addProjectCloneSources, addProjectSourceSupport } from "./signalboxAddProject.logic";

const GITHUB = SourceControlProviderKind.make("github");
const GITLAB = SourceControlProviderKind.make("gitlab");

describe("addProjectSourceSupport", () => {
  it("offers every source on servers that don't report the capabilities", () => {
    const everything = { localFilesystem: true, cloneFromUrl: true, sourceControlImports: null };
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
    expect(
      addProjectCloneSources([GITHUB, GITLAB], { cloneFromUrl: true, sourceControlImports: null }),
    ).toEqual(["url", GITHUB, GITLAB]);
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
