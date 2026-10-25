import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { loadCodex } from "./loader-emscripten.mjs";

// (module (import "env" "tick" (func (result i32)))
//   (func (export "main") (result i32) call 0))
const bytes = Uint8Array.from([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 2, 12, 1, 3, 101, 110, 118, 4, 116, 105, 99,
  107, 0, 0, 3, 2, 1, 0, 7, 8, 1, 4, 109, 97, 105, 110, 0, 1, 10, 6, 1, 4, 0, 16, 0, 11,
]);
const module = new WebAssembly.Module(bytes);

NodeTest.test(
  "version host runs once using a static module without runtime compilation",
  async () => {
    const output = [];
    let attached;
    const originals = Object.fromEntries(
      ["compile", "compileStreaming", "instantiate", "instantiateStreaming"].map((key) => [
        key,
        WebAssembly[key],
      ]),
    );
    const originalFetch = globalThis.fetch;
    try {
      for (const key of Object.keys(originals)) {
        WebAssembly[key] = () => NodeAssert.fail(`runtime ${key} is forbidden`);
      }
      globalThis.fetch = () => NodeAssert.fail("runtime fetch is forbidden");
      const args = ["--version"];
      const engine = await loadCodex(module, {
        imports: { env: { tick: () => 0 } },
        arguments: args,
        attach(instance) {
          attached = instance;
        },
        print(line) {
          output.push(line);
        },
      });
      NodeAssert.equal(attached, engine.instance);
      NodeAssert.deepEqual(output, []);
      await engine.run();
      NodeAssert.deepEqual(JSON.parse(output[0]), {
        version: "fixture",
        abiVersion: 1,
        transport: "app-server-ndjson",
      });
      NodeAssert.deepEqual(args, ["--version"]);
      await NodeAssert.rejects(engine.run(), /only run once/);
    } finally {
      Object.assign(WebAssembly, originals);
      globalThis.fetch = originalFetch;
    }
  },
);

NodeTest.test("main waits for a suspending kernel import and propagates rejection", async () => {
  const entered = Promise.withResolvers();
  const pending = Promise.withResolvers();
  const engine = await loadCodex(module, {
    imports: {
      env: {
        tick: async () => {
          entered.resolve();
          return pending.promise;
        },
      },
    },
    suspendingImports: ["env.tick"],
  });
  let completed = false;
  const running = engine.run().then(() => {
    completed = true;
  });
  await entered.promise;
  NodeAssert.equal(completed, false);
  pending.resolve(0);
  await running;
  NodeAssert.equal(completed, true);

  const failed = await loadCodex(module, {
    imports: {
      env: {
        tick: async () => {
          throw new Error("kernel failed");
        },
      },
    },
    suspendingImports: ["env.tick"],
  });
  await NodeAssert.rejects(failed.run(), /kernel failed/);
  await NodeAssert.rejects(failed.run(), /only run once/);
});

NodeTest.test("generated imports are available and the host can override them", async () => {
  let generatedCalls = 0;
  globalThis.generatedImports = {
    env: {
      tick: () => {
        generatedCalls += 1;
        return 0;
      },
    },
  };
  try {
    const generated = await loadCodex(module, {});
    const overridden = await loadCodex(module, { imports: { env: { tick: () => 0 } } });
    await overridden.run();
    NodeAssert.equal(generatedCalls, 0);
    await generated.run();
    NodeAssert.equal(generatedCalls, 1);
  } finally {
    delete globalThis.generatedImports;
  }
});

NodeTest.test("missing and stale kernel imports fail before guest execution", async () => {
  await NodeAssert.rejects(loadCodex(module, {}), /Missing Codex kernel import: env.tick/);
  await NodeAssert.rejects(
    loadCodex(module, {
      imports: { env: { tick: () => NodeAssert.fail("guest must not execute") } },
      suspendingImports: ["env.old"],
    }),
    /Unknown suspending Codex import: env.old/,
  );
  globalThis.generatedImports = { env: { tick: () => 0 } };
  try {
    await NodeAssert.rejects(
      loadCodex(module, { suspendingImports: ["env.tick"] }),
      /needs a host function/,
    );
  } finally {
    delete globalThis.generatedImports;
  }
});

NodeTest.test("nonzero exit and bytes requiring compilation fail explicitly", async () => {
  const engine = await loadCodex(module, { imports: { env: { tick: () => 23 } } });
  await NodeAssert.rejects(engine.run(), /exited 23/);
  await NodeAssert.rejects(loadCodex(bytes, {}), /precompiled WebAssembly.Module/);
});

NodeTest.test("JSPI is mandatory even when no kernel imports suspend", async () => {
  const original = WebAssembly.Suspending;
  try {
    WebAssembly.Suspending = undefined;
    await NodeAssert.rejects(loadCodex(module, {}), /needs JSPI support/);
  } finally {
    WebAssembly.Suspending = original;
  }
});
