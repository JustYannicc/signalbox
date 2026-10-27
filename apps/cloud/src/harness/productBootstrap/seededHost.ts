import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import type { HarnessReleaseArtifact } from "../../harnessReleases/HarnessReleaseLedger.ts";
import type { ProductHostOptions, ProductHarnessSessionHost } from "../host/product.ts";
import { HarnessRequestFacetError } from "../HarnessRequestFacet.ts";
import type { HarnessError } from "../Harness.ts";
import {
  productMachineInventory,
  productModelTransport,
  productProgramBindings,
} from "./capabilities.ts";
import type { HarnessCProductCapabilities } from "./capabilities.ts";
import type { HarnessCProductProvider } from "../HarnessProcessResume.ts";
import { productExecutor } from "./executor.ts";
import { productTurnGrantSource } from "./turnGrant.ts";
import type { HarnessCSelectedProductRelease } from "./selectedArtifact.ts";

type ProviderOptions<Options> = Omit<
  Options,
  | "release"
  | "processResumeArtifact"
  | "programs"
  | "machineInventory"
  | "modelTransport"
  | "executor"
>;

export function createSeededProductHost<
  G,
  Native,
  Options extends ProductHostOptions<G, Native> & {
    readonly processResumeArtifact?: HarnessReleaseArtifact;
  },
  Host extends ProductHarnessSessionHost<G>,
>({
  input,
  selected,
  providerOptions,
  createHost,
  beforeCreate,
}: {
  readonly input: {
    readonly factory: { readonly provider: HarnessCProductProvider };
    readonly capabilities: HarnessCProductCapabilities<G>;
  };
  readonly selected: HarnessCSelectedProductRelease;
  readonly providerOptions: ProviderOptions<Options>;
  readonly createHost: (options: Options) => Effect.Effect<Host, HarnessError, Scope.Scope>;
  readonly beforeCreate?: (
    options: Omit<Options, "release" | "processResumeArtifact">,
  ) => Effect.Effect<void, HarnessRequestFacetError>;
}) {
  return Effect.gen(function* () {
    const programs = yield* Effect.tryPromise({
      try: () => productProgramBindings(input.factory.provider, input.capabilities.programs),
      catch: (cause) =>
        new HarnessRequestFacetError("The provider program seed could not be prepared.", { cause }),
    });
    const machineInventory = yield* Effect.tryPromise({
      try: () => productMachineInventory(input.factory.provider, input.capabilities.machine),
      catch: (cause) =>
        new HarnessRequestFacetError("The provider machine inventory could not be prepared.", {
          cause,
        }),
    });
    const built = {
      ...providerOptions,
      programs: { codes: programs.codes, seed: programs.seed },
      machineInventory,
      modelTransport: productModelTransport(input.capabilities.model),
      executor: productExecutor(input.capabilities.executor),
      ...(input.capabilities.turnGrantSource === undefined
        ? {}
        : { turnGrantSource: productTurnGrantSource(input.capabilities.turnGrantSource) }),
    } as Omit<Options, "release" | "processResumeArtifact">;
    if (built.threadId.length === 0)
      return yield* Effect.fail(
        new HarnessRequestFacetError("Product host thread identity is missing."),
      );
    const threadId = ThreadId.make(built.threadId);
    if (beforeCreate !== undefined) yield* beforeCreate(built);
    const options = {
      ...built,
      release: selected.release,
      processResumeArtifact: selected.artifact,
    } as Options;
    const host = yield* createHost(options).pipe(
      Effect.mapError(
        (cause: HarnessError) =>
          new HarnessRequestFacetError("The product host could not be constructed.", { cause }),
      ),
    );
    yield* Effect.addFinalizer(() =>
      host.dispose.pipe(
        Effect.catchCause((cause) =>
          Effect.die(new HarnessRequestFacetError("The product host could not close.", { cause })),
        ),
      ),
    );
    yield* host
      .seed("assets")
      .pipe(
        Effect.mapError(
          (cause: HarnessError) =>
            new HarnessRequestFacetError("Product assets could not be seeded.", { cause }),
        ),
      );
    yield* host
      .seed("programs")
      .pipe(
        Effect.mapError(
          (cause: HarnessError) =>
            new HarnessRequestFacetError("Product programs could not be seeded.", { cause }),
        ),
      );

    return { host, threadId };
  });
}
