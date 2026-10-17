import { operations } from "@signalbox/api/catalog";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
  EnvironmentId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";
import { TrashSnapshot } from "@t3tools/contracts/signalboxTrash";

import * as Environment from "../environment.ts";
import { makeMemoryCloud } from "../testing.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import { type ApiCaller, callOperation } from "./apiCall.ts";

const decodeFolders = Schema.decodeUnknownSync(SignalboxFoldersSnapshot);
const decodeTrash = Schema.decodeUnknownSync(TrashSnapshot);

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
  it.effect(
    "restores a trashed thread and keeps an old delete command inert after restoration",
    () =>
      Effect.gen(function* () {
        const { call, cloud } = yield* setup;
        expect(
          json(
            yield* call("threads.create", {
              commandId: "launch-trash-roundtrip",
              threadId: "trash-roundtrip",
              projectId: Environment.SCRATCH_PROJECT_ID,
              title: "Retained conversation",
              modelSelection: scriptedModelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              workspaceStrategy: { type: "root" },
            }),
          ).status,
        ).toBe(200);
        yield* cloud.settle;
        const first = decodeTrash(
          json(
            yield* call("trash.thread", {
              threadId: "trash-roundtrip",
              commandId: "delete-roundtrip",
            }),
          ).body,
        ).entries[0]!;
        expect(first.status).toBe("trashed");
        expect(json(yield* call("trash.restore", { id: first.id })).status).toBe(200);
        yield* cloud.settle;
        expect(JSON.stringify(json(yield* call("threads.list", {})).body)).toContain(
          "Retained conversation",
        );
        const replayed = decodeTrash(
          json(
            yield* call("trash.thread", {
              threadId: "trash-roundtrip",
              commandId: "delete-roundtrip",
            }),
          ).body,
        );
        expect(replayed.entries).toHaveLength(1);
        expect(replayed.entries[0]?.status).toBe("restored");
      }),
  );

  it.effect(
    "trashes, restores and empties a folder through the agent API, while scopes still apply",
    () =>
      Effect.gen(function* () {
        const { call } = yield* setup;
        const agent: ApiCaller = { ...person(), kind: "agent" };
        const created = json(
          yield* call("folders.create", { name: "Trash round trip", parentId: null }),
        );
        const folder = decodeFolders(created.body).folders[0]!;
        const trashed = json(yield* call("trash.folder", { folderId: folder.id }, agent));
        expect(trashed.status).toBe(200);
        const entry = decodeTrash(trashed.body).entries[0]!;
        expect(decodeFolders(json(yield* call("folders.list", {})).body).folders).toEqual([]);
        const denied = json(
          yield* call("trash.restore", { id: entry.id }, person([AuthOrchestrationReadScope])),
        );
        expect(denied.status).toBe(403);
        const restored = json(yield* call("trash.restore", { id: entry.id }, agent));
        expect(restored.status).toBe(200);
        expect(decodeFolders(json(yield* call("folders.list", {})).body).folders[0]?.id).toBe(
          folder.id,
        );
        const second = decodeTrash(
          json(yield* call("trash.folder", { folderId: folder.id }, agent)).body,
        ).entries.find((row) => row.status === "trashed")!;
        expect(second.id).not.toBe(entry.id);
        const emptied = json(yield* call("trash.empty", { ids: [second.id] }, agent));
        expect(emptied.status).toBe(200);
        expect(decodeTrash(emptied.body).entries.find((row) => row.id === second.id)).toMatchObject(
          { status: "purged", removals: [{ kind: "folder", id: folder.id }] },
        );
        expect(json(yield* call("trash.restore", { id: second.id }, agent)).status).toBe(422);
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
          person(AuthStandardClientScopes),
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
