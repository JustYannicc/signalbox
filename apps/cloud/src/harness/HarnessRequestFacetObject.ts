import { DurableObject } from "cloudflare:workers";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
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

    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env);
      const identity = { ctx, env, facetNonce: this.facetNonce };
      // The layer opens lazily on the first incoming request and owns the retained native lifetime.
      this.runtime = ManagedRuntime.make(
        Layer.effect(
          Facet,
          Effect.gen(function* () {
            const options = yield* compose(identity);
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

    async run(input: Parameters<HarnessRequestFacet["run"]>[0]) {
      if (this.closed) throw new HarnessRequestFacetError("Harness facet is disposed.");
      return this.runtime.runPromise(Facet.use((facet) => facet.run(input)));
    }

    async dispose(expectedFacetNonce: string) {
      if (expectedFacetNonce !== this.facetNonce)
        throw new HarnessRequestFacetError("Disposal targets another facet incarnation.");
      this.closed = true;
      await this.runtime.dispose();
    }
  };
}

export type HarnessRequestFacetObject = InstanceType<
  ReturnType<typeof createHarnessRequestFacetClass>
>;
