import { operations } from "@signalbox/api/catalog";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  type AuthEnvironmentScope,
  EnvironmentId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as Environment from "../environment.ts";
import { makeMemoryCloud } from "../testing.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import * as UserModelSettings from "../user/UserModelSettings.ts";
import { type ApiCaller, callOperation } from "./apiCall.ts";
import { CLOUD_CLIENT_SCOPES } from "../auth/CloudScopes.ts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";

const identity = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };
const userId = "user_1";
const standard = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope];

const person = (scopes: ReadonlyArray<AuthEnvironmentScope> = standard): ApiCaller => ({
  userId,
  kind: "person",
  scopes,
  credentialId: "key-1",
});

const operation = (name: string) => {
  const found = operations.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`No operation ${name}`);
  return found;
};

/** Calls `name` in a fresh in-memory cloud where `userId` has signed in. */
const setup = Effect.gen(function* () {
  const cloud = makeMemoryCloud();
  yield* cloud.userDirectory.forUser(userId).recordSignIn({ id: userId, email: "a@b.c" });
  const call = (name: string, body: unknown, caller = person(), follow = false) =>
    callOperation({ operation: operation(name), body, follow, caller, identity }).pipe(
      Effect.provide(cloud.layerFor(userId)),
    );
  return { call, cloud };
});

const json = (answer: Effect.Success<ReturnType<typeof callOperation>>) => {
  if (answer._tag !== "json") throw new Error("Expected a JSON answer");
  return answer;
};

describe("public API calls", () => {
  it.effect("saves and removes a keybinding through the public reach map", () =>
    Effect.gen(function* () {
      const { call } = yield* setup;
      const binding = {
        key: "mod+shift+k",
        command: "commandPalette.toggle",
        when: "!terminalFocus",
      };
      expect(json(yield* call("keybindings.upsert", binding)).status).toBe(403);
      const writer = person([AuthOrchestrationReadScope, AuthSettingsWriteScope]);
      expect(json(yield* call("keybindings.upsert", binding, writer))).toMatchObject({
        status: 200,
        body: { issues: [] },
      });
      expect(json(yield* call("server.config", {}))).toMatchObject({
        status: 200,
        body: {
          keybindings: expect.arrayContaining([
            expect.objectContaining({
              command: binding.command,
              shortcut: expect.objectContaining({ shiftKey: true }),
            }),
          ]),
        },
      });
      expect(json(yield* call("keybindings.remove", binding, writer))).toMatchObject({
        status: 200,
        body: { keybindings: DEFAULT_RESOLVED_KEYBINDINGS, issues: [] },
      });
    }),
  );

  it.effect("reads and saves analytics consent through the public reach map", () =>
    Effect.gen(function* () {
      const { call } = yield* setup;
      expect(json(yield* call("analytics.get", {}))).toMatchObject({
        status: 200,
        body: { enabled: false, disabledByServer: false },
      });
      expect(json(yield* call("analytics.setEnabled", { enabled: true })).status).toBe(403);
      const writer = person([AuthOrchestrationReadScope, AuthSettingsWriteScope]);
      expect(json(yield* call("analytics.setEnabled", { enabled: true }, writer))).toMatchObject({
        status: 200,
        body: { enabled: true, disabledByServer: false },
      });
      expect(json(yield* call("analytics.get", {}))).toMatchObject({
        status: 200,
        body: { enabled: true, disabledByServer: false },
      });
    }),
  );

  it.effect("creates a folder and lists it, through the same handlers as the app", () =>
    Effect.gen(function* () {
      const { call } = yield* setup;
      const created = json(yield* call("folders.create", { name: "Signalbox", parentId: null }));
      expect(created.status).toBe(200);
      const listed = json(yield* call("folders.list", {}));
      expect(listed.status).toBe(200);
      expect(JSON.stringify(listed.body)).toContain('"name":"Signalbox"');
    }),
  );

  it.effect("starts a thread and sends it a message as a command, filling in the command id", () =>
    Effect.gen(function* () {
      const { call, cloud } = yield* setup;
      const launched = json(
        yield* call("threads.create", {
          commandId: "launch-1",
          threadId: "thread-1",
          projectId: Environment.SCRATCH_PROJECT_ID,
          title: "From the API",
          modelSelection: scriptedModelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
        }),
      );
      expect(launched.status).toBe(200);
      const sent = json(
        yield* call("threads.send", {
          createdBy: "user",
          creationSource: "web",
          threadId: "thread-1",
          messageId: "message-1",
          text: "Hello",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          deliveryIntent: "auto",
        }),
      );
      expect(sent.status).toBe(200);
      yield* cloud.settle;
      const threads = json(yield* call("threads.list", {}));
      expect(JSON.stringify(threads.body)).toContain('"title":"From the API"');
    }),
  );

  it.effect(
    "creates threads without a model using the person's saved choice, including an expensive one",
    () =>
      Effect.gen(function* () {
        const { call, cloud } = yield* setup;
        const preferred = {
          instanceId: ProviderInstanceId.make("claude_hub"),
          model: "claude-fable-5-1",
        };
        yield* UserModelSettings.UserModelSettings.use((settings) =>
          settings.update(
            { defaultModelSelection: preferred },
            new Map([[preferred.instanceId, new Set([preferred.model])]]),
          ),
        ).pipe(Effect.provide(cloud.userObject(userId)));
        const launched = json(
          yield* call("threads.create", {
            commandId: "launch-default",
            projectId: Environment.SCRATCH_PROJECT_ID,
            title: "Uses my default",
            runtimeMode: "full-access",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
          }),
        );
        expect(launched.status).toBe(200);
        expect(launched.body).toMatchObject({
          projection: { thread: { modelSelection: preferred } },
        });
        const explicit = json(
          yield* call("threads.create", {
            commandId: "launch-explicit",
            projectId: Environment.SCRATCH_PROJECT_ID,
            title: "Explicit override",
            modelSelection: scriptedModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
          }),
        );
        expect(explicit.status).toBe(200);
        expect(explicit.body).toMatchObject({
          projection: { thread: { modelSelection: scriptedModelSelection } },
        });
        yield* UserModelSettings.UserModelSettings.use((settings) =>
          settings.update({ defaultModelSelection: null }, new Map()),
        ).pipe(Effect.provide(cloud.userObject(userId)));
        const replayed = json(
          yield* call("threads.create", {
            commandId: "launch-default",
            projectId: Environment.SCRATCH_PROJECT_ID,
            title: "Uses my default",
            runtimeMode: "full-access",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
          }),
        );
        expect(replayed.status).toBe(200);
        expect(replayed.body).toMatchObject({
          resumed: true,
          projection: { thread: { modelSelection: preferred } },
        });
      }),
  );

  it.effect("creates threads without a model on an economical pool model instead of Fable", () =>
    Effect.gen(function* () {
      const { call, cloud } = yield* setup;
      yield* call("server.config", {}, person(CLOUD_CLIENT_SCOPES));
      const pool = cloud.pools.directory.forPool(`${userId}:personal`);
      const actor = { userId };
      const login = yield* pool.startLogin(actor, "claude");
      yield* pool.completeLogin(actor, `http://localhost/callback?code=c&state=${login.state}`);
      yield* pool.loginStatus(actor, login.state);
      yield* call("server.refreshProviders", {}, person(CLOUD_CLIENT_SCOPES));
      const launched = json(
        yield* call("threads.create", {
          commandId: "launch-economical",
          projectId: Environment.SCRATCH_PROJECT_ID,
          title: "Economical default",
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
        }),
      );
      expect(launched.status).toBe(200);
      expect(launched.body).toMatchObject({
        projection: {
          thread: { modelSelection: { instanceId: "claude_hub", model: "claude-sonnet-5-5" } },
        },
      });
    }),
  );

  it.effect("refuses an omitted model when no preference or economical model exists", () =>
    Effect.gen(function* () {
      const { call } = yield* setup;
      const answer = json(
        yield* call("threads.create", {
          commandId: "launch-no-model",
          projectId: Environment.SCRATCH_PROJECT_ID,
          title: "Choose a model",
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
        }),
      );
      expect(answer.status).not.toBe(200);
      expect(JSON.stringify(answer.body)).toContain("No economical model is available");
    }),
  );

  it.effect("streams a subscription as lines when the caller follows it", () =>
    Effect.gen(function* () {
      const { call } = yield* setup;
      const answer = yield* call("folders.list", {}, person(), true);
      expect(answer._tag).toBe("ndjson");
      if (answer._tag !== "ndjson") return;
      const [first] = yield* answer.lines.pipe(Stream.take(1), Stream.runCollect);
      expect(JSON.parse(first!)).toHaveProperty("revision");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses what the credential's scopes don't cover", () =>
    Effect.gen(function* () {
      const { call } = yield* setup;
      const answer = json(
        yield* call(
          "folders.create",
          { name: "Nope", parentId: null },
          person([AuthOrchestrationReadScope]),
        ),
      );
      expect(answer.status).toBe(403);
    }),
  );

  it.effect("keeps human-only and destructive operations away from agents", () =>
    Effect.gen(function* () {
      const { call } = yield* setup;
      const agent: ApiCaller = { ...person(), kind: "agent" };
      expect(json(yield* call("threads.respond", {}, agent)).status).toBe(403);
      expect(json(yield* call("threads.dismissQuestion", {}, agent)).status).toBe(403);
      expect(json(yield* call("secrets.answer", {}, agent)).status).toBe(403);
      expect(json(yield* call("folders.delete", { id: "f" }, agent)).status).toBe(403);
      expect(
        json(yield* call("keys.create", { label: "mine", scopes: [], model: true }, agent)).status,
      ).toBe(403);
    }),
  );

  it.effect("never mints a key with scopes its caller doesn't hold", () =>
    Effect.gen(function* () {
      const { call } = yield* setup;
      const answer = json(
        yield* call(
          "keys.create",
          { label: "relay", scopes: ["relay:write"], model: false },
          person(CLOUD_CLIENT_SCOPES),
        ),
      );
      expect(answer.status).toBe(422);
      expect(answer.body).toMatchObject({ error: { _tag: "PersonalKeyError" } });
    }),
  );

  it.effect("says which issue closes an operation the cloud doesn't serve yet", () =>
    Effect.gen(function* () {
      const { call } = yield* setup;
      const answer = json(yield* call("settings.get", {}));
      expect(answer.status).toBe(501);
      expect(answer.body).toMatchObject({ error: { code: "not_in_cloud", issue: "#440" } });
    }),
  );

  it.effect("rejects input that doesn't match the operation's schema", () =>
    Effect.gen(function* () {
      const { call } = yield* setup;
      const answer = json(yield* call("folders.create", { name: 7 }));
      expect(answer.status).toBe(400);
      expect(answer.body).toMatchObject({ error: { code: "invalid_input" } });
    }),
  );
});
