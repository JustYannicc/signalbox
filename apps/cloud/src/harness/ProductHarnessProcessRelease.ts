import type { HarnessReleaseArtifact } from "../harnessReleases/HarnessReleaseLedger.ts";
import type { HarnessProcessResumePreparedRelease } from "./processResume/contracts.ts";
import { snapshotPreparedRelease } from "./processResume/identity.ts";
import type { LoadedHarnessRelease } from "./HarnessReleaseLoader.ts";
import type { ProductHarnessSessionHost } from "./host/product.ts";

export interface ProductLoadedPreparedReleaseObserver {
  readonly capture: (loaded: LoadedHarnessRelease) => void;
  readonly read: () => HarnessProcessResumePreparedRelease;
}

export function productLoadedPreparedReleaseObserver(
  provider: "claude-code" | "codex",
  selected: HarnessReleaseArtifact | undefined,
): ProductLoadedPreparedReleaseObserver {
  let observed: HarnessProcessResumePreparedRelease | undefined;
  return {
    capture: (loaded) => {
      if (selected !== undefined) observed = productLoadedPreparedRelease(provider, selected, loaded);
    },
    read: () => {
      if (selected === undefined)
        return productLoadedPreparedRelease(provider, undefined, undefined);
      if (observed === undefined)
        return productLoadedPreparedRelease(provider, selected, undefined);
      return observed;
    },
  };
}

export function attachProductLoadedPreparedRelease<G>(
  observer: ProductLoadedPreparedReleaseObserver,
): (host: ProductHarnessSessionHost<G>) => ProductHarnessSessionHost<G> & {
  loadedPreparedRelease(): HarnessProcessResumePreparedRelease;
} {
  return (host) => withProductLoadedPreparedRelease(host, observer.read);
}

export function withProductLoadedPreparedRelease<G>(
  host: ProductHarnessSessionHost<G>,
  observe: () => HarnessProcessResumePreparedRelease,
): ProductHarnessSessionHost<G> & {
  loadedPreparedRelease(): HarnessProcessResumePreparedRelease;
} {
  return {
    threadId: host.threadId,
    release: host.release,
    seed: (stage) => host.seed(stage),
    open: (input) => host.open(input),
    dispose: host.dispose,
    get computer() {
      return host.computer;
    },
    get commands() {
      return host.commands;
    },
    loadedPreparedRelease: observe,
  };
}

/** Projects the actual product loader result into the release observation C verifies. */
export function productLoadedPreparedRelease(
  provider: "claude-code" | "codex",
  selected: HarnessReleaseArtifact | undefined,
  loaded: LoadedHarnessRelease | undefined,
): HarnessProcessResumePreparedRelease {
  if (selected === undefined)
    throw new Error("Product process resume requires a caller-selected full HarnessReleaseArtifact.");
  if (loaded === undefined)
    throw new Error("The product host has not completed its verified release load.");
  if (selected.provider !== provider || loaded.plan.release.harness !== provider)
    throw new Error("The selected product artifact does not match its provider host.");

  const observed = snapshotPreparedRelease({
    artifact: selected,
    plan: {
      release: loaded.plan.release,
      sourceIdentity: loaded.plan.sourceIdentity,
      computer: loaded.plan.computer,
      preparedModules: loaded.plan.preparedModules,
    },
  });
  if (observed === undefined)
    throw new Error("The verified product load does not match the selected artifact identity.");
  return observed;
}
