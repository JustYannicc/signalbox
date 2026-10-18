import { AUTOMATION_COMPILED_FORMAT } from "@t3tools/contracts";
import { compileWorkflow } from "@signalbox/automation-compiler/compileWorkflow";
import { AutomationCompiler } from "@signalbox/automations/host";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { CloudCompiler, acceptCompiled, layer, layerWithCompiler } from "./cloudCompiler.ts";

const fileNamed = (name: string) => {
  const source = `export const meta = { name: "${name}" } as const;
export default workflow(async (w) => {
  await w.notify("${name}", "${name}");
  return "${name}";
});`;
  const compiled = compileWorkflow(source);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  return { source, compiled: compiled.workflow };
};

describe("CloudCompiler", () => {
  it.effect("a save keeps its compile while another save comes and goes", () =>
    Effect.gen(function* () {
      const staging = yield* CloudCompiler;
      const compiler = yield* AutomationCompiler;
      const first = fileNamed("First");
      const second = fileNamed("Second");
      const staged = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const slow = yield* staging
        .withStaged(
          first.source,
          first.compiled,
          Deferred.succeed(staged, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.andThen(Effect.sync(() => compiler.compile(first.source))),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(staged);
      yield* staging.withStaged(second.source, second.compiled, Effect.void);
      yield* Deferred.succeed(gate, undefined);
      expect((yield* Fiber.join(slow)).ok).toBe(true);
      // Once saved, nothing stays staged.
      expect(compiler.compile(first.source).ok).toBe(false);
      expect(compiler.compile(second.source).ok).toBe(false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "serializes entire callbacks so each sees its own accepted artifact for the same source",
    () =>
      Effect.gen(function* () {
        const staging = yield* CloudCompiler;
        const compiler = yield* AutomationCompiler;
        const first = fileNamed("First artifact");
        const second = fileNamed("Second artifact");
        const acceptedFirst = yield* acceptCompiled({
          format: AUTOMATION_COMPILED_FORMAT,
          ...first.compiled,
        });
        const acceptedSecond = yield* acceptCompiled({
          format: AUTOMATION_COMPILED_FORMAT,
          ...second.compiled,
        });
        expect(acceptedFirst.meta).not.toEqual(acceptedSecond.meta);
        expect(acceptedFirst.graph).not.toEqual(acceptedSecond.graph);
        expect(acceptedFirst.script).not.toBe(acceptedSecond.script);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const secondEntered = yield* Deferred.make<void>();
        const read = Effect.sync(() => compiler.compile(first.source));
        const firstSave = yield* staging
          .withStaged(
            first.source,
            acceptedFirst,
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(read),
            ),
          )
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(entered);
        const secondSave = yield* staging
          .withStaged(
            first.source,
            acceptedSecond,
            Deferred.succeed(secondEntered, undefined).pipe(Effect.andThen(read)),
          )
          .pipe(Effect.forkChild({ startImmediately: true }));
        // The second fiber has run to its first suspension while the first callback is still active.
        expect(yield* Deferred.isDone(secondEntered)).toBe(false);
        expect(compiler.compile(first.source)).toEqual({ ok: true, workflow: acceptedFirst });
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(firstSave)).toEqual({ ok: true, workflow: acceptedFirst });
        expect(yield* Fiber.join(secondSave)).toEqual({ ok: true, workflow: acceptedSecond });
        expect(compiler.compile(first.source).ok).toBe(false);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "releases same-source staging after failures and interruption of active or waiting callbacks",
    () =>
      Effect.gen(function* () {
        const staging = yield* CloudCompiler;
        const compiler = yield* AutomationCompiler;
        const first = fileNamed("Active");
        const second = fileNamed("Successor");
        for (const outcome of ["failure", "interruption"] as const) {
          const entered = yield* Deferred.make<void>();
          const fail = yield* Deferred.make<void>();
          const firstSave = yield* staging
            .withStaged(
              first.source,
              first.compiled,
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(
                  outcome === "failure"
                    ? Deferred.await(fail).pipe(Effect.andThen(Effect.fail("save failed")))
                    : Effect.never,
                ),
              ),
            )
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(entered);
          let cancelledCallbackRan = false;
          const cancelled = yield* staging
            .withStaged(
              first.source,
              second.compiled,
              Effect.sync(() => {
                cancelledCallbackRan = true;
              }),
            )
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Fiber.interrupt(cancelled);
          expect(cancelledCallbackRan).toBe(false);
          const next = yield* staging
            .withStaged(
              first.source,
              second.compiled,
              Effect.sync(() => compiler.compile(first.source)),
            )
            .pipe(Effect.forkChild({ startImmediately: true }));
          if (outcome === "failure") {
            yield* Deferred.succeed(fail, undefined);
            yield* Fiber.await(firstSave);
          } else {
            yield* Fiber.interrupt(firstSave);
          }
          expect(yield* Fiber.join(next)).toEqual({ ok: true, workflow: second.compiled });
          expect(compiler.compile(first.source).ok).toBe(false);
          // An entirely new use of this source must also acquire and clean up normally.
          expect(
            yield* staging.withStaged(
              first.source,
              first.compiled,
              Effect.sync(() => compiler.compile(first.source)),
            ),
          ).toEqual({ ok: true, workflow: first.compiled });
          expect(compiler.compile(first.source).ok).toBe(false);
        }
      }).pipe(Effect.provide(layer)),
  );

  it.effect("maps loader failures to an AutomationError", () =>
    CloudCompiler.use((compiler) => compiler.compile("source").pipe(Effect.flip)).pipe(
      Effect.provide(
        layerWithCompiler(async () => {
          throw new Error("loader failed");
        }),
      ),
      Effect.map((error) => expect(error.message).toBe("Cloud automation compilation failed.")),
    ),
  );

  it.effect("reports an unavailable compiler as an AutomationError", () =>
    CloudCompiler.use((compiler) => compiler.compile("source").pipe(Effect.flip)).pipe(
      Effect.provide(layer),
      Effect.map((error) =>
        expect(error.message).toBe("Cloud automation compiler isn't configured."),
      ),
    ),
  );
});
