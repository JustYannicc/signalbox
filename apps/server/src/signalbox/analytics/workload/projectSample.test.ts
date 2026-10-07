import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../../../processRunner.ts";
import { sampleProject } from "./projectSample.ts";

it.layer(
  Layer.merge(NodeServices.layer, ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
)("sampleProject", (it) => {
  it.effect("never walks a home directory, or anything above one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "signalbox-home-" });
        yield* fs.writeFileString(path.join(root, "Cargo.lock"), "");
        const withHome = (home: string) =>
          sampleProject(root).pipe(
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home }))),
          );

        for (const home of [root, path.join(root, "me")]) {
          const skipped = yield* withHome(home);
          assert.deepEqual(skipped, {
            gitBytes: undefined,
            workingTreeBytes: undefined,
            dependencyCacheBytes: undefined,
            lockfiles: ["cargo"],
          });
        }
        const measured = yield* withHome("/nonexistent-home");
        assert.isDefined(measured.workingTreeBytes);
      }),
    ),
  );
});
