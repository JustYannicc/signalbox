/**
 * OpenCode on a pool. OpenCode talks to the pool's hub as one
 * OpenAI-compatible provider, so it can use every model the pool serves.
 * Its config and data directories are its own, so it never reads OpenCode's
 * logins or settings on the server machine.
 *
 * OpenCode only offers the models a custom provider lists. The list is read
 * from the hub when the instance is built, and the pool rebuilds the instance
 * when the hub starts serving different models (`AccountPools`).
 *
 * @module accountHub/hubOpenCode
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import type { AccountHubEndpoint } from "./accountHubManagement.ts";

/** The OpenCode provider id the pool's models appear under (`signalbox/<model>`). */
export const OPENCODE_POOL_PROVIDER = "signalbox";

/** The variable OpenCode's config reads the hub key from, so the key stays out of the file. */
export const OPENCODE_POOL_KEY_VARIABLE = "SIGNALBOX_POOL_KEY";

/** Everything an OpenCode instance keeps for itself, under the server state directory. */
export const openCodeInstanceDirectory = (path: Path.Path, stateDir: string, instanceId: string) =>
  path.join(stateDir, "providers", "opencode", instanceId);

export const openCodeConfigPath = (path: Path.Path, directory: string) =>
  path.join(directory, "opencode.json");

const Models = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });
const decodeModels = Schema.decodeUnknownEffect(Models);

/** The models the hub serves now, sorted so two reads compare equal. */
export const hubModels = (endpoint: AccountHubEndpoint) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http
      .execute(
        HttpClientRequest.get(`${endpoint.baseUrl}/v1/models`).pipe(
          HttpClientRequest.bearerToken(endpoint.clientKey),
        ),
      )
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.timeout("10 seconds"));
    const models = yield* response.json.pipe(Effect.flatMap(decodeModels));
    return [...new Set(models.data.map((model) => model.id))].toSorted();
  });

export function renderOpenCodeConfig(options: {
  readonly baseUrl: string;
  readonly name: string;
  readonly models: ReadonlyArray<string>;
}): string {
  return JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      // Only the pool: no provider OpenCode finds on the machine or in a project.
      enabled_providers: [OPENCODE_POOL_PROVIDER],
      autoupdate: false,
      share: "disabled",
      provider: {
        [OPENCODE_POOL_PROVIDER]: {
          name: options.name,
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: `${options.baseUrl}/v1`,
            apiKey: `{env:${OPENCODE_POOL_KEY_VARIABLE}}`,
          },
          models: Object.fromEntries(options.models.map((model) => [model, { name: model }])),
        },
      },
    },
    null,
    2,
  );
}

const ConfiguredModels = Schema.fromJsonString(
  Schema.Struct({
    provider: Schema.Struct({
      [OPENCODE_POOL_PROVIDER]: Schema.Struct({
        models: Schema.Record(Schema.String, Schema.Unknown),
      }),
    }),
  }),
);
const decodeConfiguredModels = Schema.decodeUnknownEffect(ConfiguredModels);

/** The models an instance's config lists, or none when it has no config yet. */
export const configuredModels = (configPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(configPath);
    const config = yield* decodeConfiguredModels(text);
    return Object.keys(config.provider[OPENCODE_POOL_PROVIDER].models).toSorted();
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

export const sameModels = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((model, index) => model === right[index]);
