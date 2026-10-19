import type {
  ProviderAdapterV2Error,
  ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import type { Harness, HarnessError, HarnessOpenInput } from "./Harness.ts";
import { openAdapterSession } from "./adapter/session.ts";

/** The host owns launch bindings and attaches their cleanup to the supplied Scope. */
export class AdapterRuntimeFactory extends Context.Service<
  AdapterRuntimeFactory,
  {
    readonly open: (
      input: HarnessOpenInput,
    ) => Effect.Effect<
      ProviderAdapterV2SessionRuntime,
      HarnessError | ProviderAdapterV2Error,
      Scope.Scope
    >;
  }
>()("@signalbox/cloud/harness/AdapterHarness/AdapterRuntimeFactory") {}

export class AdapterHarness extends Context.Service<AdapterHarness, Harness>()(
  "@signalbox/cloud/harness/AdapterHarness",
) {}

const make = Effect.gen(function* () {
  const factory = yield* AdapterRuntimeFactory;
  return AdapterHarness.of({ open: (input) => openAdapterSession(input, factory.open) });
});

export const layer = Layer.effect(AdapterHarness, make);
