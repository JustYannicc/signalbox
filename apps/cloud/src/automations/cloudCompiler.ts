import type { CompiledWorkflow } from "@signalbox/automations/compiled";
import { PRECOMPILED_BUILT_INS } from "@signalbox/automations/defaults/precompiled";
import { BUILT_IN_AUTOMATIONS } from "@signalbox/automations/defaults/registry";
import { AutomationCompiler } from "@signalbox/automations/host";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Compiling in the cloud, where oxc can't run (its wasm build needs threads).
 * Built-ins ship precompiled (`defaults/precompiled.ts`). Everything else is
 * compiled by the thread's machine that saves it: `stage` holds that result
 * for the save that follows, keyed by its exact source, so the engine's
 * ordinary save path compiles by lookup.
 */
export class CloudCompiler extends Context.Service<
  CloudCompiler,
  { readonly stage: (source: string, compiled: CompiledWorkflow) => Effect.Effect<void> }
>()("@signalbox/cloud/automations/cloudCompiler") {}

const NOT_COMPILED = {
  ok: false,
  diagnostics: [
    {
      line: 1,
      column: 1,
      message:
        "Cloud automations compile on the thread's machine. Save it with automation_save from a cloud thread.",
    },
  ],
} as const;

export const layer = Layer.effectContext(
  Effect.sync(() => {
    const staged = new Map<string, CompiledWorkflow>();
    const builtIns = new Map(
      BUILT_IN_AUTOMATIONS.flatMap((builtIn) => {
        const compiled = PRECOMPILED_BUILT_INS[builtIn.slug];
        return compiled ? [[builtIn.source, compiled] as const] : [];
      }),
    );
    const compile = (source: string) => {
      const compiled = staged.get(source) ?? builtIns.get(source);
      return compiled ? ({ ok: true, workflow: compiled } as const) : NOT_COMPILED;
    };
    return Context.make(AutomationCompiler, AutomationCompiler.of({ compile })).pipe(
      Context.add(
        CloudCompiler,
        CloudCompiler.of({
          stage: (source, compiled) =>
            Effect.sync(() => {
              // Only the latest save's compile is kept; a source compiles the same way every time.
              staged.clear();
              staged.set(source, compiled);
            }),
        }),
      ),
    );
  }),
);
