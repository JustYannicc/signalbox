import { compileWorkflow } from "@signalbox/automation-compiler/compileWorkflow";
import { AutomationCompiler } from "@signalbox/automations/host";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { CloudCompiler, layer, layerWithCompiler } from "./cloudCompiler.ts";

const fileNamed = (name: string) => {
  const source = `export const meta = { name: "${name}" } as const;
export default workflow(async (w) => "${name}");`;
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

  it.effect("keeps same-source saves staged in either completion order", () =>
    Effect.gen(function* () {
      const staging = yield* CloudCompiler;
      const compiler = yield* AutomationCompiler;
      for (const finishLaterFirst of [false, true]) {
        const first = fileNamed("Same source");
        const second = fileNamed("Same source");
        const firstStaged = yield* Deferred.make<void>();
        const secondStaged = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();
        const stage = (file: typeof first, ready: typeof firstStaged, gate: typeof releaseFirst) =>
          staging
            .withStaged(
              file.source,
              file.compiled,
              Deferred.succeed(ready, undefined).pipe(
                Effect.andThen(Deferred.await(gate)),
                Effect.andThen(Effect.sync(() => compiler.compile(file.source))),
              ),
            )
            .pipe(Effect.forkChild);
        const firstSave = yield* stage(first, firstStaged, releaseFirst);
        yield* Deferred.await(firstStaged);
        const secondSave = yield* stage(second, secondStaged, releaseSecond);
        yield* Deferred.await(secondStaged);

        yield* Deferred.succeed(finishLaterFirst ? releaseSecond : releaseFirst, undefined);
        expect((yield* Fiber.join(finishLaterFirst ? secondSave : firstSave)).ok).toBe(true);
        expect(compiler.compile(first.source).ok).toBe(true);
        yield* Deferred.succeed(finishLaterFirst ? releaseFirst : releaseSecond, undefined);
        expect((yield* Fiber.join(finishLaterFirst ? firstSave : secondSave)).ok).toBe(true);
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
