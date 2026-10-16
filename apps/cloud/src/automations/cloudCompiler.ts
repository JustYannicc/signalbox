import {
  AUTOMATION_COMPILED_FORMAT,
  AutomationCompiled,
  type AutomationError,
} from "@t3tools/contracts";
import { type CompiledWorkflow, WORKER_MODULE_START } from "@signalbox/automations/compiled";
import { fail } from "@signalbox/automations/errors";
import { PRECOMPILED_BUILT_INS } from "@signalbox/automations/defaults/precompiled";
import { BUILT_IN_AUTOMATIONS } from "@signalbox/automations/defaults/registry";
import { AutomationCompiler } from "@signalbox/automations/host";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Compiling in the cloud, where oxc can't run (its wasm build needs threads).
 * Built-ins ship precompiled (`defaults/precompiled.ts`). Everything else is
 * compiled by whoever saves it, a thread's machine or the `signalbox` CLI, and
 * checked with `acceptCompiled`: `withStaged` holds that result while its save
 * runs, keyed by its exact source, so the engine's ordinary save path compiles
 * by lookup.
 */
export class CloudCompiler extends Context.Service<
  CloudCompiler,
  {
    /** Runs `use` (a save) with `source` compiling to `compiled`, then forgets it. */
    readonly withStaged: <A, E, R>(
      source: string,
      compiled: CompiledWorkflow,
      use: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("@signalbox/cloud/automations/cloudCompiler") {}

const NOT_COMPILED = {
  ok: false,
  diagnostics: [
    {
      line: 1,
      column: 1,
      message:
        "Cloud automations compile where they're saved from. Save it with `signalbox automations save`, local `signalbox mcp`, or automation_save from a cloud thread.",
    },
  ],
} as const;

/** Where an automation can be compiled, for callers that sent nothing compiled. */
export const COMPILE_WHERE =
  "The cloud can't compile automation files. Use `signalbox automations validate` and `signalbox automations save`, or local `signalbox mcp` (`claude mcp add signalbox -- signalbox mcp`), which compile on your computer; agents in a cloud thread use automation_validate and automation_save.";

const decodeCompiled = Schema.decodeUnknownOption(AutomationCompiled);

const notCompiled = (why: string) =>
  fail(
    `That isn't a compiled automation (${why}). Let \`signalbox\` or the thread's machine compile the file.`,
  );

/**
 * Checks what a caller compiled before the cloud saves it: the contract's
 * shape, the format this cloud reads, and a worker module it can load. The
 * code still only runs in its own Dynamic Worker, as the person, so this
 * guards against stale and broken compilers, not against the person.
 */
export const acceptCompiled = (
  compiled: unknown,
): Effect.Effect<CompiledWorkflow, AutomationError> => {
  const decoded = decodeCompiled(compiled);
  if (Option.isNone(decoded)) return notCompiled("its shape is wrong");
  const { format, ...workflow } = decoded.value;
  if (format !== AUTOMATION_COMPILED_FORMAT)
    return fail(
      `This file was compiled in format ${format}, and the cloud reads format ${AUTOMATION_COMPILED_FORMAT}. Update signalbox and save it again.`,
    );
  if (!workflow.workerModule.startsWith(WORKER_MODULE_START))
    return notCompiled("its worker module has no load function");
  return Effect.succeed(workflow);
};

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
          // Saves interleave, so each removes only its own entry; one source compiles one way.
          withStaged: (source, compiled, use) =>
            Effect.sync(() => staged.set(source, compiled)).pipe(
              Effect.andThen(use),
              Effect.ensuring(
                Effect.sync(() => {
                  if (staged.get(source) === compiled) staged.delete(source);
                }),
              ),
            ),
        }),
      ),
    );
  }),
);
