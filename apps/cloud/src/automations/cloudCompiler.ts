import {
  AUTOMATION_COMPILED_FORMAT,
  AutomationCompiled,
  AutomationError,
  type WorkflowDiagnostic,
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
import * as Semaphore from "effect/Semaphore";

export type CloudCompileResult =
  | { readonly ok: true; readonly compiled: AutomationCompiled }
  | { readonly ok: false; readonly diagnostics: ReadonlyArray<WorkflowDiagnostic> };

export type CloudSourceCompiler = (source: string) => Promise<CloudCompileResult>;

/**
 * The cloud compiler runs in cached loader isolates because OXC cannot run in
 * the user object's workerd isolate. This layer validates its artifact, then
 * stages it briefly so the engine's ordinary save path can compile by lookup.
 * Built-ins keep using their precompiled artifacts.
 */
export class CloudCompiler extends Context.Service<
  CloudCompiler,
  {
    /** Compiles a source file in a cached, cloud-capable loader. */
    readonly compile: (source: string) => Effect.Effect<CloudCompileResult, AutomationError>;
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
        "The cloud engine received automation source without a staged compiled artifact. Validate and save through the cloud automation service.",
    },
  ],
} as const;

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

const makeLayer = (compileSource?: CloudSourceCompiler) =>
  Layer.effectContext(
    Effect.sync(() => {
      const staged = new Map<string, CompiledWorkflow>();
      const lanes = new Map<string, { readonly lock: Semaphore.Semaphore; users: number }>();
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
            compile: (source) =>
              compileSource === undefined
                ? Effect.fail(
                    new AutomationError({
                      message: "Cloud automation compiler isn't configured.",
                    }),
                  )
                : Effect.tryPromise({
                    try: () => compileSource(source),
                    catch: (cause) =>
                      new AutomationError({
                        message: "Cloud automation compilation failed.",
                        cause,
                      }),
                  }),
            // The synchronous engine compile runs after yielding. Hold this source's lane for the entire save.
            withStaged: (source, compiled, use) =>
              Effect.acquireUseRelease(
                Effect.sync(() => {
                  let lane = lanes.get(source);
                  if (!lane) {
                    lane = { lock: Semaphore.makeUnsafe(1), users: 0 };
                    lanes.set(source, lane);
                  }
                  lane.users++;
                  return lane;
                }),
                (lane) =>
                  lane.lock.withPermit(
                    Effect.acquireUseRelease(
                      Effect.sync(() => staged.set(source, compiled)),
                      () => use,
                      () =>
                        Effect.sync(() => {
                          staged.delete(source);
                        }),
                    ),
                  ),
                (lane) =>
                  Effect.sync(() => {
                    lane.users--;
                    if (lane.users === 0) lanes.delete(source);
                  }),
              ),
          }),
        ),
      );
    }),
  );

export const layerWithCompiler = (compileSource: CloudSourceCompiler) => makeLayer(compileSource);

export const layer = makeLayer();
