import type { KernelBashCredentials } from "../kernel/KernelBashProgram.ts";
import type { KernelBashPort } from "../kernel/KernelBashPort.ts";
import type { KernelAsyncProgramContext } from "../kernel/KernelAsyncProgram.ts";
import {
  createChildWorkerRunner,
  type ChildWorkerProgram,
  type ChildWorkerProgramOptions,
} from "./ChildWorkerProgram.ts";
import { ChildWorkerLifetimes } from "./ChildWorkerLifetimes.ts";

let implementation: Promise<typeof import("./childBash/start.ts")> | undefined;

export function createChildBashProgram(
  options: Omit<ChildWorkerProgramOptions<KernelBashPort>, "createHost"> & {
    readonly credentials: KernelBashCredentials;
  },
): ChildWorkerProgram {
  const lifetimes = options.lifetimes ?? new ChildWorkerLifetimes();
  const { reservationFor: _reservationFor, ...unreserved } = options;
  const initial = createChildWorkerRunner({ ...options, lifetimes });
  const continued = createChildWorkerRunner({ ...unreserved, lifetimes });
  let loading: typeof implementation;
  const load = () => {
    if (loading === undefined) {
      loading = implementation ??= import("./childBash/start.ts");
      lifetimes.track(loading.then(() => undefined));
    }
    return loading;
  };
  return Object.freeze({
    kind: "async" as const,
    ...(options.code.executableArtifact === undefined
      ? {}
      : { executableArtifact: options.code.executableArtifact }),
    // Load before admission reserves a slot, so cancellation cannot strand an unclaimed permit.
    prepare: (residentBytes?: number) => load().then(() => initial.prepare(residentBytes)),
    run(context: KernelAsyncProgramContext) {
      const starting = load().then(({ startChildBash }) =>
        startChildBash(context, initial, continued, options.credentials, lifetimes),
      );
      // Drain must join module loading before the Bash group can register its own cleanup.
      lifetimes.track(starting.then(() => undefined));
      return starting.then((owner) => owner.exited);
    },
    drain: () => lifetimes.drain(),
  });
}
