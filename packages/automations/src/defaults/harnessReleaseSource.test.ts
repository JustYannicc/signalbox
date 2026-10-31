import { describe, expect, it, vi } from "vite-plus/test";

describe("harness release source assembly", () => {
  it("normalizes source on the first source read and reuses it afterward", async () => {
    let normalizationCalls = 0;
    vi.resetModules();
    vi.doMock("./workflowFunctionSource.ts", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./workflowFunctionSource.ts")>();
      return {
        ...actual,
        workflowFunctionSource: (fn: Parameters<typeof actual.workflowFunctionSource>[0]) => {
          normalizationCalls += 1;
          return actual.workflowFunctionSource(fn);
        },
      };
    });

    try {
      const { BUILT_IN_AUTOMATIONS } = await import("./registry.ts");
      expect(normalizationCalls).toBe(0);

      const builtIn = BUILT_IN_AUTOMATIONS.find((entry) => entry.slug === "harness-release-watch");
      expect(builtIn).toBeDefined();
      const source = builtIn!.source;
      const callsAfterFirstRead = normalizationCalls;

      expect(typeof source).toBe("string");
      expect(callsAfterFirstRead).toBeGreaterThan(0);
      expect(builtIn!.source).toBe(source);
      expect(normalizationCalls).toBe(callsAfterFirstRead);

      const { getHarnessReleaseWatchSource } = await import("./harnessRelease.ts");
      expect(getHarnessReleaseWatchSource()).toBe(source);
      expect(normalizationCalls).toBe(callsAfterFirstRead);
    } finally {
      vi.doUnmock("./workflowFunctionSource.ts");
      vi.resetModules();
    }
  });
});
