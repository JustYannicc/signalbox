import { assert } from "./common.ts";

export interface CheckpointLineage {
  readonly current: () => string;
  readonly advance: (parent: string, checkpointId: string) => void;
}
const checkpoints = new WeakMap<object, string>();

export function restoreFacetCheckpoint(owner: object, checkpointId: string) {
  assert(checkpointId.length > 0, "Restored facet checkpoint is missing");
  const previous = checkpoints.get(owner);
  assert(
    previous === undefined || previous === checkpointId,
    "Facet checkpoint lineage cannot rewind",
  );
  checkpoints.set(owner, checkpointId);
}

/** Each real facet starts from its own restored checkpoint, independent of other providers. */
export function facetCheckpointLineage(owner: object): CheckpointLineage {
  const current = () => {
    const checkpoint = checkpoints.get(owner);
    assert(checkpoint, "Facet has no restored checkpoint lineage");
    return checkpoint;
  };
  return {
    current,
    advance(parent, checkpointId) {
      assert(
        current() === parent && checkpointId.length > 0 && checkpointId !== parent,
        "Facet checkpoint lineage changed or contains a cycle",
      );
      checkpoints.set(owner, checkpointId);
    },
  };
}
