import { DurableObject } from "cloudflare:workers";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { unwrapRequestExit } from "./requestFacet/failure.ts";
import {
  createHarnessRequestFacet,
  HarnessRequestFacetError,
  type HarnessRequestFacetOptions,
  type HarnessRequestFacet,
} from "./HarnessRequestFacet.ts";

export function createHarnessRequestFacetClass<Env>(
  compose: (input: {
    readonly ctx: DurableObjectState;
    readonly env: Env;
    readonly facetNonce: string;
  }) => Effect.Effect<HarnessRequestFacetOptions, HarnessRequestFacetError>,
) {
  class Facet extends Context.Service<Facet, HarnessRequestFacet>()(
    "@signalbox/cloud/harness/HarnessRequestFacetObject/Facet",
  ) {}
  return class HarnessRequestFacetObject extends DurableObject<Env> {
    // @effect-diagnostics-next-line cryptoRandomUUID:off - platform construction precedes the first request's Effect runtime.
    readonly facetNonce = crypto.randomUUID();
    private closed = false;
    private readonly runtime;
    private loadedPreparedReleaseReader: HarnessRequestFacetOptions["loadedPreparedRelease"] =
      undefined;

    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env);
      const identity = { ctx, env, facetNonce: this.facetNonce };
      const setLoadedPreparedReleaseReader = (
        reader: HarnessRequestFacetOptions["loadedPreparedRelease"],
      ) => {
        this.loadedPreparedReleaseReader = reader;
      };
      // The layer opens lazily on the first incoming request and owns the retained native lifetime.
      this.runtime = ManagedRuntime.make(
        Layer.effect(
          Facet,
          Effect.gen(function* () {
            const options = yield* compose(identity);
            setLoadedPreparedReleaseReader(options.loadedPreparedRelease);
            if (options.facetNonce !== identity.facetNonce)
              return yield* Effect.fail(
                new HarnessRequestFacetError("Harness facet nonce changed during construction."),
              );
            return yield* createHarnessRequestFacet(options);
          }),
        ),
      );
    }

    identity() {
      return { facetNonce: this.facetNonce };
    }

    private async runRequest<A, E>(effect: Effect.Effect<A, E, Facet>, message: string) {
      return unwrapRequestExit(await this.runtime.runPromiseExit(effect), message);
    }

    async run(input: Parameters<HarnessRequestFacet["run"]>[0]) {
      if (this.closed) throw new HarnessRequestFacetError("Harness facet is disposed.");
      return this.runRequest(
        Facet.use((facet) => facet.run(input)),
        "Harness facet request failed.",
      );
    }

    async prepareInert(input: Parameters<HarnessRequestFacet["prepareInert"]>[0]) {
      if (this.closed) throw new HarnessRequestFacetError("Harness facet is disposed.");
      return this.runRequest(
        Facet.use((facet) => facet.prepareInert(input)),
        "Harness inert preparation failed.",
      );
    }

    async startFresh(input: Parameters<HarnessRequestFacet["startFresh"]>[0]) {
      if (this.closed) throw new HarnessRequestFacetError("Harness facet is disposed.");
      return this.runRequest(
        Facet.use((facet) => facet.startFresh(input)),
        "Harness fresh process creation failed.",
      );
    }

    async loadedPreparedRelease() {
      if (this.closed) throw new HarnessRequestFacetError("Harness facet is disposed.");
      await this.runRequest(
        Facet.use(() => Effect.void),
        "Harness prepared release query failed.",
      );
      const read = this.loadedPreparedReleaseReader;
      if (read === undefined)
        throw new HarnessRequestFacetError(
          "This product facet cannot observe a verified prepared release.",
        );
      return this.runRequest(
        Effect.tryPromise({
          try: async () => read(),
          catch: (cause) =>
            new HarnessRequestFacetError("Harness prepared release query failed.", { cause }),
        }),
        "Harness prepared release query failed.",
      );
    }

    async dispose(expectedFacetNonce: string) {
      if (expectedFacetNonce !== this.facetNonce)
        throw new HarnessRequestFacetError("Disposal targets another facet incarnation.");
      this.closed = true;
      unwrapRequestExit(
        await Effect.runPromiseExit(this.runtime.disposeEffect),
        "Harness facet disposal failed.",
      );
    }
  };
}

export type HarnessRequestFacetObject = InstanceType<
  ReturnType<typeof createHarnessRequestFacetClass>
>;
