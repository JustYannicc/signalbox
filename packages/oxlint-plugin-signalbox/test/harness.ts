// @effect-diagnostics nodeBuiltinImport:off - resolves the installed CLI before the fixture Effect runs.
import * as NodeModule from "node:module";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const require = NodeModule.createRequire(import.meta.url);
const oxlintPackage = NodeModule.createRequire(require.resolve("vite-plus/package.json")).resolve(
  "oxlint/package.json",
);
const encodeConfig = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (text, chunk) => text + chunk,
    ),
  );

export function createRuleHarness(ruleName: string) {
  const test = it.layer(NodeServices.layer);
  const run = Effect.fnUntraced(function* (source: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fixture = yield* fs.makeTempDirectoryScoped({ prefix: "signalbox-oxlint-" });
    const config = path.join(fixture, ".oxlintrc.json");
    const input = path.join(fixture, "fixture.tsx");
    yield* fs.writeFileString(
      config,
      yield* encodeConfig({
        jsPlugins: [
          { name: "signalbox", specifier: path.join(import.meta.dirname, "..", "index.ts") },
        ],
        rules: { [ruleName]: "error" },
      }),
    );
    yield* fs.writeFileString(input, source);
    const child = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [
        path.join(path.dirname(oxlintPackage), "bin", "oxlint"),
        "--config",
        config,
        input,
      ]),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [collect(child.stdout), collect(child.stderr), child.exitCode],
      { concurrency: "unbounded" },
    );
    return { output: stdout + stderr, exitCode: Number(exitCode) };
  }, Effect.scoped);

  return {
    valid(name: string, source: string) {
      test(name, (it) => {
        it.effect("passes", () =>
          run(source).pipe(
            Effect.tap(({ output, exitCode }) =>
              Effect.sync(() => {
                assert.strictEqual(exitCode, 0, output);
              }),
            ),
          ),
        );
      });
    },
    invalid(name: string, source: string, count = 1) {
      test(name, (it) => {
        it.effect("reports the rule", () =>
          run(source).pipe(
            Effect.tap(({ output, exitCode }) =>
              Effect.sync(() => {
                assert.strictEqual(exitCode, 1, output);
                const [plugin, name] = ruleName.split("/");
                const diagnostics = output.match(new RegExp(`${plugin}\\(${name}\\)`, "g"));
                assert.strictEqual(diagnostics?.length, count, output);
              }),
            ),
          ),
        );
      });
    },
  };
}
