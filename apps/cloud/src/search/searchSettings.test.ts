import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";

import { descriptor, serverConfig } from "../environment.ts";
import { searchSettings } from "./searchSettings.ts";

describe("search deployment controls", () => {
  it("keeps existing deployments enabled on generation 1", () => {
    expect(searchSettings({})).toEqual({ generation: "1", disabled: false });
    expect(searchSettings({ SEARCH_INDEX_GENERATION: "", SEARCH_INDEX_DISABLED: "" })).toEqual({
      generation: "1",
      disabled: false,
    });
  });

  it("accepts a fresh search-only generation and advertises disabled search honestly", () => {
    expect(
      searchSettings({
        SEARCH_INDEX_GENERATION: "incident_2026-10-17",
        SEARCH_INDEX_DISABLED: "1",
      }),
    ).toEqual({
      generation: "incident_2026-10-17",
      disabled: true,
    });
    const identity = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };
    expect(descriptor(identity).capabilities.threadContentSearch).toBe(true);
    expect(descriptor({ ...identity, searchDisabled: true }).capabilities.threadContentSearch).toBe(
      false,
    );
    expect(
      serverConfig({ ...identity, searchDisabled: true }, "2026-10-17T00:00:00.000Z").threadFind,
    ).toBe(false);
  });

  it("rejects invalid controls instead of selecting an unintended namespace", () => {
    for (const generation of ["../production", "bad generation", "a".repeat(65)]) {
      expect(() => searchSettings({ SEARCH_INDEX_GENERATION: generation })).toThrow(
        "SEARCH_INDEX_GENERATION",
      );
    }
    expect(() => searchSettings({ SEARCH_INDEX_DISABLED: "true" })).toThrow(
      "SEARCH_INDEX_DISABLED",
    );
  });
});
