import type { KernelBashCredentials } from "../kernel/KernelBashProgram.ts";
import type { KernelBashPort } from "../kernel/KernelBashPort.ts";
import type { KernelAsyncProgramContext } from "../kernel/KernelAsyncProgram.ts";
import {
  createChildWorkerRunner,
  type ChildWorkerProgram,
  type ChildWorkerProgramOptions,
} from "./ChildWorkerProgram.ts";
import { ChildWorkerLifetimes } from "./ChildWorkerLifetimes.ts";

let bashStartModule: Promise<typeof import("./childBash/start.ts")> | undefined;
let startChildBash: typeof import("./childBash/start.ts").startChildBash | undefined;

export function createChildBashProgram(
  options: Omit<ChildWorkerProgramOptions<KernelBashPort>, "createHost"> & {
    readonly credentials: KernelBashCredentials;
  },
): ChildWorkerProgram {
  const lifetimes = options.lifetimes ?? new ChildWorkerLifetimes();
  const { reservationFor: _reservationFor, ...unreserved } = options;
  const initial = createChildWorkerRunner({ ...options, lifetimes });
  const continued = createChildWorkerRunner({ ...unreserved, lifetimes });
  let loading: typeof bashStartModule;
  const load = () => {
    if (loading === undefined) {
      loading = bashStartModule ??= import("./childBash/start.ts").then((module) => {
        startChildBash = module.startChildBash;
        return module;
      });
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
      // Preparation loaded the module; queue the reservation claim before the caller can cancel.
      if (startChildBash !== undefined) {
        return startChildBash(context, initial, continued, options.credentials, lifetimes).exited;
      }
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
