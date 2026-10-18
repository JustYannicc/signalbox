import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { loadCodex } from "./loader.mjs";

// (module (import "env" "tick" (func)) (func (export "_start") call 0))
const bytes = Uint8Array.from([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 2, 12, 1, 3, 101, 110, 118, 4, 116, 105, 99, 107,
  0, 0, 3, 2, 1, 0, 7, 10, 1, 6, 95, 115, 116, 97, 114, 116, 0, 1, 10, 6, 1, 4, 0, 16, 0, 11,
]);
const module = await WebAssembly.compile(bytes);

NodeTest.test("guest suspends on kernel I/O and resumes after its result", async () => {
  const entered = Promise.withResolvers();
  const input = Promise.withResolvers();
  let completed = false;
  const engine = loadCodex(module, {
    imports: {
      env: {
        tick: async () => {
          entered.resolve();
          await input.promise;
          completed = true;
        },
      },
    },
    suspendingImports: ["env.tick"],
  });
  const running = engine.run();
  await entered.promise;
  NodeAssert.equal(completed, false);
  input.resolve();
  await running;
  NodeAssert.equal(completed, true);
  await NodeAssert.rejects(engine.run(), /only run once/);
});

NodeTest.test("separate instances execute independently", async () => {
  const counts = [0, 0];
  const engines = counts.map((_, index) =>
    loadCodex(module, {
      imports: {
        env: {
          tick: () => {
            counts[index] += 1;
          },
        },
      },
    }),
  );
  await engines[1].run();
  NodeAssert.deepEqual(counts, [0, 1]);
  await engines[0].run();
  NodeAssert.deepEqual(counts, [1, 1]);
});

NodeTest.test("missing or stale kernel imports fail before guest execution", () => {
  NodeAssert.throws(() => loadCodex(module, { imports: {} }), /env.tick/);
  NodeAssert.throws(
    () =>
      loadCodex(module, {
        imports: {
          env: {
            tick() {
              NodeAssert.fail("guest must not execute");
            },
          },
        },
        suspendingImports: ["env.old"],
      }),
    /Unknown suspending Codex import: env.old/,
  );
});

NodeTest.test("the loader refuses bytes that would require runtime compilation", () => {
  NodeAssert.throws(() => loadCodex(bytes, { imports: {} }), /precompiled/);
});
