import { compileWorkflow } from "@signalbox/automation-compiler/compileWorkflow";
import { AutomationCompiler } from "@signalbox/automations/host";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { CloudCompiler, layer } from "./cloudCompiler.ts";

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
});
