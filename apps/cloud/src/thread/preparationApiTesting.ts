import { RUNNER_PROTOCOL_VERSION } from "@signalbox/runner-protocol/RunnerProtocol";
import { WorktreeSetupSnapshot } from "@t3tools/contracts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";

import { handleApiRequest } from "../api/apiRoutes.ts";
import * as CloudTokens from "../auth/CloudTokens.ts";
import * as Environment from "../environment.ts";
import { signLocalKey } from "../localKeys/LocalKeys.ts";
import { poolObjectName } from "../pool/PoolDirectory.ts";
import { layerConfig, makeMemoryCloud } from "../testing.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import * as ThreadRunner from "./runner/ThreadRunner.ts";
import * as ThreadEngine from "./ThreadEngine.ts";

export const threadId = "preparation-api-thread";
const userId = "preparation-owner";
const scopes = ["orchestration:read", "orchestration:operate"] as const;
const decodeSnapshot = Schema.decodeUnknownSync(WorktreeSetupSnapshot);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const setup = Effect.gen(function* () {
  const cloud = makeMemoryCloud();
  const layer = Layer.mergeAll(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected network request")),
    ),
    CloudTokens.layer.pipe(Layer.provide(layerConfig())),
    layerConfig(),
    Layer.succeed(UserDirectory.UserDirectory, cloud.userDirectory),
  );
  const keyFor = (personId: string, readOnly = false) =>
    Effect.gen(function* () {
      const user = cloud.userDirectory.forUser(personId);
      yield* user.recordSignIn({ id: personId, email: `${personId}@example.test` });
      const made = yield* user.createLocalKey(readOnly ? "reader" : "writer", {
        scopes: readOnly ? ["orchestration:read"] : scopes,
        model: false,
      });
      if (made._tag !== "created") throw new Error("No key");
      return yield* signLocalKey(personId, made.secret).pipe(Effect.provide(layer));
    });
  const ownerKey = yield* keyFor(userId);
  const strangerKey = yield* keyFor("preparation-stranger");
  const readerKey = yield* keyFor(userId, true);
  const pool = cloud.pools.directory.forPool(poolObjectName(userId, "personal"));
  yield* pool.create({ userId }, { name: "Personal", personal: true });
  const login = yield* pool.startLogin({ userId }, "claude");
  yield* pool.completeLogin({ userId }, `http://localhost/callback?code=c&state=${login.state}`);
  yield* pool.loginStatus({ userId }, login.state);
  const api = (name: string, input: object, key = ownerKey) =>
    encodeJson(input).pipe(
      Effect.flatMap((body) =>
        handleApiRequest(
          new Request(`https://cloud.test/api/v1/${name}`, {
            method: "POST",
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
            body,
          }),
        ),
      ),
      Effect.provide(layer),
      Effect.flatMap((response) =>
        Effect.promise(async () => ({
          status: response.status,
          body: (await response.json()) as unknown,
        })),
      ),
    );
  expect(
    (yield* api("threads.create", {
      commandId: "create",
      threadId,
      projectId: Environment.SCRATCH_PROJECT_ID,
      title: "Private checkout",
      modelSelection: { instanceId: "claude_hub", model: "claude-fable-5-1" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
    })).status,
  ).toBe(200);
  expect(
    (yield* api("threads.send", {
      commandId: "send",
      threadId,
      messageId: "same-message",
      text: "Prepare this thread",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      dispatchMode: { type: "start_immediately" },
      deliveryIntent: "auto",
    })).status,
  ).toBe(200);
  const read = Effect.map(api("worktreeSetup.subscribe", { threadId }), (response) => {
    expect(response.status).toBe(200);
    return decodeSnapshot(response.body);
  });
  const initial = yield* read;
  if (initial.runId === undefined || initial.preparationGeneration === undefined)
    throw new Error("Missing guards");
  const target = {
    threadId: initial.threadId,
    runId: initial.runId,
    preparationGeneration: initial.preparationGeneration,
  };
  const connect = cloud.inThread(
    threadId,
    ThreadRunner.ThreadRunner.use((runner) =>
      Effect.gen(function* () {
        const plan = yield* runner.reconcile;
        if (plan.ensure === null) throw new Error("No machine request");
        yield* runner.hello({
          type: "hello",
          protocolVersion: RUNNER_PROTOCOL_VERSION,
          imageVersion: "test",
          machineId: "same-machine",
          threadId: target.threadId,
          generation: plan.ensure.generation,
          token: plan.ensure.token,
          lastAckedSequence: 0,
        });
        expect((yield* runner.work).turn?.runId).toBe(target.runId);
        return plan.ensure;
      }),
    ),
  );
  const changes = cloud.inThread(
    threadId,
    ThreadEngine.ThreadEngine.use((engine) =>
      engine.subscribePreparation({ userId, contextIds: [] }).pipe(Effect.orDie),
    ),
  );
  const runnerWork = cloud.inThread(
    threadId,
    ThreadRunner.ThreadRunner.use((runner) => runner.work),
  );
  const runnerBatch = (input: Parameters<ThreadRunner.ThreadRunner["Service"]["batch"]>[0]) =>
    cloud.inThread(
      threadId,
      ThreadRunner.ThreadRunner.use((runner) => runner.batch(input)),
    );
  return {
    cloud,
    layer,
    api,
    read,
    target,
    initial,
    ownerKey,
    strangerKey,
    readerKey,
    connect,
    changes,
    runnerWork,
    runnerBatch,
  };
});
