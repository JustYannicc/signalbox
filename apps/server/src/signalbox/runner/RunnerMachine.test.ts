import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  machineConfigJson,
  type RunnerMachineConfig,
} from "@signalbox/runner-protocol/RunnerProtocol";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { watchMachineConfig } from "./RunnerMachine.ts";

const IMAGE = "ghcr.io/test/runner:1";

const config = (generation: number, image = IMAGE): RunnerMachineConfig => ({
  threadId: ThreadId.make("thread-vm"),
  generation,
  token: `token-${generation}`,
  modelGatewayUrl: "https://gateway.test",
  cloudUrl: "https://cloud.test",
  image,
});

/** Polls until `check` holds, so the test waits on the follower rather than a fixed sleep. */
const until = (check: () => boolean) =>
  Effect.gen(function* () {
    while (!check()) yield* Effect.sleep("5 millis");
  }).pipe(Effect.timeout("5 seconds"));

describe("watchMachineConfig", () => {
  it.live("runs each new generation once, and returns when the image changes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const configPath = (yield* Path.Path).join(
        yield* fs.makeTempDirectoryScoped(),
        "machine.json",
      );
      const write = (value: RunnerMachineConfig) =>
        fs.writeFileString(configPath, machineConfigJson.encode(value));
      const ensured: Array<number> = [];
      let failNext = false;

      const watcher = yield* watchMachineConfig({
        configPath,
        image: IMAGE,
        pollInterval: "5 millis",
        retryAfterFailure: "5 millis",
        ensure: (value) =>
          Effect.suspend(() => {
            if (failNext) {
              failNext = false;
              return Effect.die(new Error("adapters failed"));
            }
            ensured.push(value.generation);
            return Effect.void;
          }),
      }).pipe(Effect.forkChild);

      // Nothing to run until the backend writes the file.
      yield* Effect.sleep("30 millis");
      expect(ensured).toEqual([]);

      yield* write(config(1));
      yield* until(() => ensured.length === 1);
      // Rewriting the same generation (a retried ensure) starts nothing new.
      yield* write(config(1));
      yield* Effect.sleep("30 millis");
      expect(ensured).toEqual([1]);

      yield* write(config(2));
      yield* until(() => ensured.length === 2);
      expect(ensured).toEqual([1, 2]);

      // A Runner that could not start is tried again.
      failNext = true;
      yield* write(config(3));
      yield* until(() => ensured.length === 3);
      expect(ensured).toEqual([1, 2, 3]);

      yield* write(config(3, "ghcr.io/test/runner:2"));
      expect(yield* Fiber.join(watcher).pipe(Effect.timeout("5 seconds"))).toBe(
        "ghcr.io/test/runner:2",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
