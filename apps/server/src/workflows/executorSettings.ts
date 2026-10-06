import { AutomationError } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { fromJson, toJson } from "./json.ts";

/** Where `w.call` sends calls, and the key it sends them with. */
export interface ExecutorSettings {
  readonly url: string;
  readonly apiKey: string;
  /** "environment" when SIGNALBOX_EXECUTOR_URL / SIGNALBOX_EXECUTOR_API_KEY set it. */
  readonly source: "settings" | "environment";
}

/** The API key lives in the server's secret store under this name. */
const EXECUTOR_API_KEY_SECRET = "automations-executor-api-key";

// Older setups wrote the key into the file; it still reads until the next save moves it out.
const FileExecutor = Schema.Struct({ url: Schema.String, apiKey: Schema.optional(Schema.String) });
const decodeFileExecutor = Schema.decodeUnknownOption(FileExecutor);

const fail = (message: string) => (cause: unknown) => new AutomationError({ message, cause });

/**
 * Reads and writes the Executor connection. The URL sits in the fork settings
 * file `<stateDir>/automations.json` (settings.json drops unknown keys); the key
 * sits in the server secret store. The env vars win over both.
 */
export class ExecutorSettingsStore extends Context.Service<
  ExecutorSettingsStore,
  {
    readonly read: Effect.Effect<Option.Option<ExecutorSettings>, AutomationError>;
    readonly write: (input: {
      readonly url: string;
      readonly apiKey: string;
    }) => Effect.Effect<void, AutomationError>;
    readonly clear: Effect.Effect<void, AutomationError>;
  }
>()("t3/workflows/executorSettings/ExecutorSettingsStore") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const settingsPath = path.join(config.stateDir, "automations.json");

  /** The whole fork settings file, so writes keep keys this module doesn't own. */
  const readFile = fs.readFileString(settingsPath).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(""),
    ),
    Effect.flatMap((raw) => Effect.try(() => (raw.trim() ? fromJson(raw) : {}))),
    Effect.map((value) =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {},
    ),
    Effect.mapError(fail(`Couldn't read ${settingsPath}.`)),
  );

  const writeFile = (contents: Record<string, unknown>) =>
    writeFileStringAtomically({ filePath: settingsPath, contents: `${toJson(contents)}\n` }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(fail(`Couldn't save ${settingsPath}.`)),
    );

  const read = Effect.gen(function* () {
    const environment = yield* HostProcessEnvironment;
    const envUrl = environment.SIGNALBOX_EXECUTOR_URL;
    const envKey = environment.SIGNALBOX_EXECUTOR_API_KEY;
    if (envUrl && envKey)
      return Option.some({ url: envUrl, apiKey: envKey, source: "environment" as const });
    const executor = decodeFileExecutor((yield* readFile).executor);
    if (Option.isNone(executor)) return Option.none();
    const stored = yield* secrets
      .get(EXECUTOR_API_KEY_SECRET)
      .pipe(Effect.mapError(fail("Couldn't read the Executor API key.")));
    const apiKey = Option.isSome(stored)
      ? new TextDecoder().decode(stored.value)
      : executor.value.apiKey;
    return apiKey
      ? Option.some({ url: executor.value.url, apiKey, source: "settings" as const })
      : Option.none();
  });

  const write = (input: { readonly url: string; readonly apiKey: string }) =>
    Effect.gen(function* () {
      yield* secrets
        .set(EXECUTOR_API_KEY_SECRET, new TextEncoder().encode(input.apiKey))
        .pipe(Effect.mapError(fail("Couldn't save the Executor API key.")));
      yield* writeFile({ ...(yield* readFile), executor: { url: input.url } });
    });

  const clear = Effect.gen(function* () {
    const { executor: _removed, ...rest } = yield* readFile;
    yield* writeFile(rest);
    yield* secrets
      .remove(EXECUTOR_API_KEY_SECRET)
      .pipe(Effect.mapError(fail("Couldn't remove the Executor API key.")));
  });

  return ExecutorSettingsStore.of({ read, write, clear });
});

/** Brings its own secret store layer; the server's is the same reference, so it is built once. */
export const layer = Layer.effect(ExecutorSettingsStore, make).pipe(
  Layer.provide(ServerSecretStore.layer),
);
