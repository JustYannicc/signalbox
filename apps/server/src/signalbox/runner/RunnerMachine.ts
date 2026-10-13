import {
  machineConfigJson,
  type RunnerMachineConfig,
} from "@signalbox/runner-protocol/RunnerProtocol";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { makeRunnerHost, type RunnerHostConfig } from "./RunnerHost.ts";

/**
 * The Runner on a thread's own VM. The thread's machine backend writes a
 * `RunnerMachineConfig` onto the machine each time the thread asks for it at
 * a new generation; this follows that file and runs that generation's Runner,
 * replacing an earlier one. A Runner the thread refused (a stale generation
 * left on disk from before the machine stopped) is not retried: the next
 * generation arrives as a new file.
 *
 * When the file names another image, this returns, and the machine restarts
 * the Runner on that image (the boat backend's unit reads the image from the
 * same file).
 */

const POLL_INTERVAL = "1 second";
const RETRY_AFTER_FAILURE = "5 seconds";

export interface WatchMachineConfigInput<E, R> {
  readonly configPath: string;
  /** The image this Runner runs. */
  readonly image: string;
  readonly ensure: (config: RunnerMachineConfig) => Effect.Effect<unknown, E, R>;
  readonly pollInterval?: Parameters<typeof Effect.sleep>[0];
  readonly retryAfterFailure?: Parameters<typeof Effect.sleep>[0];
}

/** Follows the config file until it names another image. */
export const watchMachineConfig = Effect.fn("watchMachineConfig")(function* <E, R>(
  input: WatchMachineConfigInput<E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const pollInterval = input.pollInterval ?? POLL_INTERVAL;
  let applied: string | null = null;
  let unreadable: string | null = null;
  while (true) {
    const text = yield* fs.readFileString(input.configPath).pipe(Effect.orElseSucceed(() => null));
    const config = text === null ? null : decodeConfig(text);
    if (text !== null && config === null && unreadable !== text) {
      unreadable = text;
      yield* Effect.logWarning("unreadable machine config", { path: input.configPath });
    }
    if (config !== null && config.image !== input.image) {
      yield* Effect.logInfo("machine config names another image", { image: config.image });
      return config.image;
    }
    const key = config === null ? null : `${config.threadId}:${config.generation}:${config.token}`;
    if (config !== null && key !== applied) {
      const ok = yield* input.ensure(config).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logError("could not start the Runner", Cause.pretty(cause)).pipe(Effect.as(false)),
        ),
      );
      if (ok) applied = key;
      else yield* Effect.sleep(input.retryAfterFailure ?? RETRY_AFTER_FAILURE);
    }
    yield* Effect.sleep(pollInterval);
  }
});

const decodeConfig = (text: string): RunnerMachineConfig | null => {
  try {
    return machineConfigJson.decode(text);
  } catch {
    return null;
  }
};

export interface RunnerMachineOptions extends RunnerHostConfig {
  readonly configPath: string;
}

/** Runs the VM's Runner until its config names another image; returns that image. */
export const runRunnerMachine = Effect.fn("runRunnerMachine")(function* (
  options: RunnerMachineOptions,
) {
  const host = yield* makeRunnerHost(options);
  yield* Effect.logInfo("Runner machine up", {
    machineId: options.machineId,
    image: options.imageVersion,
  });
  return yield* watchMachineConfig({
    configPath: options.configPath,
    image: options.imageVersion,
    ensure: (config) => host.ensure(config, config.cloudUrl),
  });
});
