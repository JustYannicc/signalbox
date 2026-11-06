// @effect-diagnostics cryptoRandomUUID:off - The test observes real isolate identities.
import * as Effect from "effect/Effect";
import { systemIdentityForThread } from "@t3tools/contracts/systemIdentity";
import {
  claudeSdkFileSystem,
  createClaudeSdkHostEntrypoint,
  installClaudeSdkHostEnvironment,
} from "../../ClaudeSdkHost.ts";
import type { PreparedClaudeSdk } from "../../ClaudeSdkHost.ts";
import { adapterWithFileSystem, services } from "./adapter.ts";
import { nativeFixture } from "./native.ts";
import { HarnessError } from "../../Harness.ts";
import type { OrdinaryOwnerEnvironment } from "./ordinaryOwnerObservation.fixture.ts";

let nonce: string | undefined;
const realm = () => (nonce ??= crypto.randomUUID());

export default class extends createClaudeSdkHostEntrypoint<OrdinaryOwnerEnvironment>({
  prepare: ({ env, input, context, process, files }) =>
    Effect.gen(function* () {
      const environment = yield* Effect.acquireRelease(
        Effect.sync(() => installClaudeSdkHostEnvironment(context, process)),
        (owner) => Effect.promise(() => owner.dispose()),
      );
      const deps = yield* services;
      const nativeId = input.session.initialNativeThreadId;
      if (nativeId === undefined) throw new Error("Ordinary fixture needs its retained native ID");
      let sessionId = nativeId;
      const native = nativeFixture(
        nativeId,
        systemIdentityForThread(input.session.threadId),
        undefined,
        () => sessionId,
      );
      return {
        adapter: adapterWithFileSystem(
          claudeSdkFileSystem(files),
          deps,
          input.session.modelSelection.instanceId,
        ),
        mcpSessions: deps.mcpSessions,
        assertCompatibility: environment.assertCompatibility,
        loadSdk: async (): Promise<PreparedClaudeSdk> => {
          const sdk = await native.loadSdk(environment.bridge);
          return {
            ...sdk,
            query(input) {
              sessionId = input.options.resume ?? input.options.sessionId ?? nativeId;
              const spawn = input.options.spawnClaudeCodeProcess;
              if (spawn === undefined) throw new Error("SDK has no CLI capability");
              const recordQuery = env.OBSERVE.record({
                kind: "sdk-query",
                realm: realm(),
                model: input.options.model,
                ...(input.options.effort === undefined ? {} : { effort: input.options.effort }),
              });
              const prompt = (async function* () {
                await recordQuery;
                for await (const message of input.prompt) {
                  await env.OBSERVE.record({ kind: "sdk-prompt", realm: realm() });
                  yield message;
                }
              })();
              const query = sdk.query({
                ...input,
                prompt,
                options: {
                  ...input.options,
                  spawnClaudeCodeProcess: (options) =>
                    spawn({ ...options, args: [...options.args, "--session-id", sessionId] }),
                },
              });
              const next = query.next.bind(query);
              query.next = async (...args) => {
                await env.OBSERVE.record({ kind: "sdk-next-start", realm: realm() });
                const result = await next(...args);
                await env.OBSERVE.record({
                  kind: "sdk-next-result",
                  realm: realm(),
                  detail: result.done ? "done" : result.value.type,
                });
                if (!result.done && result.value.type === "result")
                  await files.call(
                    "appendFile",
                    `/home/recorded/.claude/projects/-workspace/${result.value.session_id}.jsonl`,
                    `${JSON.stringify(result.value)}\n`,
                  );
                return result;
              };
              return query;
            },
          };
        },
      };
    }).pipe(
      Effect.mapError(
        (cause) =>
          new HarnessError({
            operation: "open",
            message: "Ordinary SDK fixture preparation failed",
            cause,
          }),
      ),
    ),
}) {}
