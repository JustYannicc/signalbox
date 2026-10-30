import { expect, test } from "vite-plus/test";
import { facetCheckpointLineage, restoreFacetCheckpoint } from "./checkpointLineage.ts";

test("independent facets retain their own restored parent and refuse stale checkpoint advances", () => {
  const baseline = {};
  const hooks = {};
  restoreFacetCheckpoint(baseline, "baseline-seed");
  restoreFacetCheckpoint(hooks, "hooks-seed");
  const first = facetCheckpointLineage(baseline);
  const second = facetCheckpointLineage(hooks);
  first.advance("baseline-seed", "baseline-turn-1");
  expect(first.current()).toBe("baseline-turn-1");
  expect(second.current()).toBe("hooks-seed");
  expect(() => first.advance("baseline-seed", "baseline-turn-2")).toThrow("lineage changed");
  expect(() => restoreFacetCheckpoint(baseline, "baseline-seed")).toThrow("cannot rewind");
  expect(() => first.advance("baseline-turn-1", "baseline-turn-1")).toThrow("cycle");
});

test("a fresh facet cannot fabricate a parent before its public checkpoint is restored", () => {
  const lineage = facetCheckpointLineage({});
  expect(() => lineage.current()).toThrow("no restored checkpoint");
  expect(() => lineage.advance("invented-parent", "invented-next")).toThrow(
    "no restored checkpoint",
  );
});
