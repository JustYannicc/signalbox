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
import * as Schema from "effect/Schema";
import { SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";
import { TrashSnapshot } from "@t3tools/contracts/signalboxTrash";

import * as Environment from "../environment.ts";
import { makeMemoryCloud } from "../testing.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import { projectIdForDrive } from "../user/contextProjects.ts";
import * as UserModelSettings from "../user/UserModelSettings.ts";
import { type ApiCaller, callOperation } from "./apiCall.ts";
import { CLOUD_CLIENT_SCOPES } from "../auth/CloudScopes.ts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";

const decodeFolders = Schema.decodeUnknownSync(SignalboxFoldersSnapshot);
const decodeTrash = Schema.decodeUnknownSync(TrashSnapshot);

const identity = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };
const userId = "user_1";
const projectDrive = "folder/personal/trash-restore";
const projectId = projectIdForDrive(projectDrive);
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
  it.effect("authorizes provider feedback and returns the harness's typed unsupported result", () =>
    Effect.gen(function* () {
      const { call } = yield* setup;
      const denied = json(
        yield* call(
          "provider.uploadFeedback",
          { threadId: "feedback-thread" },
          person([AuthOrchestrationReadScope]),
        ),
      );
      expect(denied.status).toBe(403);
      yield* call("threads.create", {
        commandId: "feedback-create",
        threadId: "feedback-thread",
        projectId: Environment.SCRATCH_PROJECT_ID,
        title: "Feedback",
        modelSelection: scriptedModelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: { messageId: "feedback-message", text: "Hello", attachments: [] },
      });
      const unsupported = json(
        yield* call("provider.uploadFeedback", {
          threadId: "feedback-thread",
          requestId: "feedback-1",
          reason: "private canary",
        }),
      );
      expect(unsupported.status).toBe(422);
      expect(unsupported.body).toMatchObject({
        error: { _tag: "ProviderUploadFeedbackError", failure: "unsupported" },
      });
      expect(JSON.stringify(unsupported.body)).not.toContain("private canary");
    }),
  );

  it.effect("persists legacy images through the API before creating their thread", () =>
    Effect.gen(function* () {
      const { call } = yield* setup;
      const input = {
        threadId: "api-image-thread",
        messageId: "api-image-message",
        attachments: [
          {
            type: "image",
            name: "shot.png",
            mimeType: "image/png",
            sizeBytes: 3,
            dataUrl: "data:image/png;base64,AQID",
          },
        ],
      };
      const saved = json(yield* call("assets.persistChatAttachments", input));
      expect(saved).toMatchObject({
        status: 200,
        body: {
          attachments: [
            {
              type: "image",
              name: "shot.png",
              mimeType: "image/png",
              sizeBytes: 3,
            },
          ],
        },
      });
      expect(json(yield* call("assets.persistChatAttachments", input))).toEqual(saved);
      expect(
        json(
          yield* call("assets.persistChatAttachments", input, person([AuthOrchestrationReadScope])),
        ).status,
      ).toBe(403);
    }),
  );

  it.effect("explains when an independently trashed child needs its parent restored first", () =>
    Effect.gen(function* () {
      const { call } = yield* setup;
      let folders = decodeFolders(
        json(
          yield* call("folders.create", {
            name: "Parent",
            parentId: null,
          }),
        ).body,
      );
      const parent = folders.folders.find((folder) => folder.name === "Parent")!;
      folders = decodeFolders(
        json(
          yield* call("folders.create", {
            name: "Child",
            parentId: parent.id,
          }),
        ).body,
      );
      const child = folders.folders.find((folder) => folder.name === "Child")!;
      const childTrash = decodeTrash(
        json(
          yield* call("trash.folder", {
            folderId: child.id,
          }),
        ).body,
      ).entries[0]!;
      const parentTrash = decodeTrash(
        json(
          yield* call("trash.folder", {
            folderId: parent.id,
          }),
        ).body,
      ).entries.find((entry) => entry.targetId === parent.id)!;
      const waiting = decodeTrash(
        json(yield* call("trash.restore", { id: childTrash.id })).body,
      ).entries.find((entry) => entry.id === childTrash.id)!;
      expect(waiting.status).toBe("trashed");
      expect(waiting.error).toBe("Restore the parent folder first.");
      expect(json(yield* call("trash.restore", { id: parentTrash.id })).status).toBe(200);
      const restored = decodeTrash(
        json(yield* call("trash.restore", { id: childTrash.id })).body,
      ).entries.find((entry) => entry.id === childTrash.id)!;
      expect(restored.status).toBe("restored");
      expect(restored.error).toBeNull();
    }),
  );

  it.effect(
    "keeps a project-home thread trashed until its folder is restored and honors another filing",
    () =>
      Effect.gen(function* () {
        const { call, cloud } = yield* setup;
        yield* Effect.promise(() =>
          cloud.drives.apiFor(projectDrive).setup({
            name: "Trash restore project",
            members: [{ userId, email: "a@b.c", name: "Test", role: "owner" }],
          }),
        );
        let folders = decodeFolders(
          json(yield* call("folders.create", { name: "Project home", parentId: null })).body,
        );
        const projectHome = folders.folders.find((folder) => folder.name === "Project home")!;
        folders = decodeFolders(
          json(yield* call("folders.create", { name: "Elsewhere", parentId: null })).body,
        );
        const elsewhere = folders.folders.find((folder) => folder.name === "Elsewhere")!;
        expect(
          json(
            yield* call("folders.update", {
              id: projectHome.id,
              files: projectId,
            }),
          ).status,
        ).toBe(200);

        for (const [threadId, title] of [
          ["unfiled-project-home", "Unfiled project thread"],
          ["filed-project-home", "Thread filed in its project home"],
          ["filed-elsewhere", "Explicitly filed thread"],
        ] as const) {
          const created = json(
            yield* call("threads.create", {
              commandId: `launch-${threadId}`,
              threadId,
              projectId,
              title,
              modelSelection: scriptedModelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              workspaceStrategy: { type: "root" },
            }),
          );
          expect(created.status, JSON.stringify(created.body)).toBe(200);
        }
        yield* cloud.settle;
        expect(
          json(
            yield* call("threads.move", {
              threadId: "filed-project-home",
              folderId: projectHome.id,
            }),
          ).status,
        ).toBe(200);
        expect(
          json(
            yield* call("threads.move", {
              threadId: "filed-elsewhere",
              folderId: elsewhere.id,
            }),
          ).status,
        ).toBe(200);

        const unfiled = decodeTrash(
          json(yield* call("trash.thread", { threadId: "unfiled-project-home" })).body,
        ).entries.find((entry) => entry.targetId === "unfiled-project-home")!;
        const filed = decodeTrash(
          json(yield* call("trash.thread", { threadId: "filed-elsewhere" })).body,
        ).entries.find((entry) => entry.targetId === "filed-elsewhere")!;
        const filedInHome = decodeTrash(
          json(yield* call("trash.thread", { threadId: "filed-project-home" })).body,
        ).entries.find((entry) => entry.targetId === "filed-project-home")!;
        yield* cloud.settle;
        const projectHomeTrash = decodeTrash(
          json(yield* call("trash.folder", { folderId: projectHome.id })).body,
        ).entries.find((entry) => entry.targetId === projectHome.id)!;
        expect(projectHomeTrash.status).toBe("trashed");

        const filedRestore = decodeTrash(
          json(yield* call("trash.restore", { id: filed.id })).body,
        ).entries.find((entry) => entry.id === filed.id)!;
        expect(filedRestore, JSON.stringify(filedRestore)).toMatchObject({ status: "restored" });

        const blocked = decodeTrash(
          json(yield* call("trash.restore", { id: unfiled.id })).body,
        ).entries.find((entry) => entry.id === unfiled.id)!;
        expect(blocked).toMatchObject({
          status: "trashed",
          error: "Restore its folder, then this thread.",
        });
        const filedInHomeBlocked = decodeTrash(
          json(yield* call("trash.restore", { id: filedInHome.id })).body,
        ).entries.find((entry) => entry.id === filedInHome.id)!;
        expect(filedInHomeBlocked).toMatchObject({
          status: "trashed",
          error: "Restore its folder, then this thread.",
        });

        const restoredProjectHome = decodeTrash(
          json(yield* call("trash.restore", { id: projectHomeTrash.id })).body,
        ).entries.find((entry) => entry.id === projectHomeTrash.id)!;
        expect(restoredProjectHome).toMatchObject({ status: "restored", error: null });
        const restored = decodeTrash(
          json(yield* call("trash.restore", { id: unfiled.id })).body,
        ).entries.find((entry) => entry.id === unfiled.id)!;
        expect(restored, JSON.stringify(restored)).toMatchObject({
          status: "restored",
          error: null,
        });
        const filedInHomeRestored = decodeTrash(
          json(yield* call("trash.restore", { id: filedInHome.id })).body,
        ).entries.find((entry) => entry.id === filedInHome.id)!;
        expect(filedInHomeRestored).toMatchObject({ status: "restored", error: null });
      }),
  );

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
    "trashes and restores through the agent API, while scopes and disabled cleanup still apply",
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
        expect(json(yield* call("trash.empty", { ids: [second.id] }, agent)).status).toBe(403);
        const emptied = json(yield* call("trash.empty", { ids: [second.id] }));
        expect(emptied.status).toBe(422);
        expect(emptied.body).toMatchObject({
          error: {
            _tag: "SignalboxTrashError",
            message: "Permanent cleanup is not available yet.",
          },
        });
        const retained = decodeTrash(json(yield* call("trash.list", {}, agent)).body).entries.find(
          (row) => row.id === second.id,
        )!;
        expect(retained.status).toBe("trashed");
        expect(retained.removals).toEqual([]);
        expect(json(yield* call("trash.restore", { id: second.id }, agent)).status).toBe(200);
      }),
  );

  it.effect("requires thread read access for a command output snapshot", () =>
    Effect.gen(function* () {
      const { call } = yield* setup;
      const input = { threadId: "hidden-thread", itemId: "hidden-command" };
      const unscoped = json(
        yield* call("threads.commandOutput", input, person([AuthOrchestrationOperateScope])),
      );
      expect(unscoped.status).toBe(403);
      const missing = json(yield* call("threads.commandOutput", input));
      expect(missing.status).toBe(422);
      expect(missing.body).toMatchObject({ error: { _tag: "OrchestrationV2CommandOutputError" } });
    }),
  );

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

describe("queue operations through the public API", () => {
  it.effect(
    "edits and reorders with the app service, enforces scopes and returns typed stale failures",
    () =>
      Effect.gen(function* () {
        const { call, cloud } = yield* setup;
        expect(
          json(
            yield* call("threads.create", {
              commandId: "queue-launch",
              threadId: "queue-api",
              projectId: Environment.SCRATCH_PROJECT_ID,
              title: "Queue API",
              modelSelection: scriptedModelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              workspaceStrategy: { type: "root" },
              initialMessage: { text: "Live", attachments: [] },
            }),
          ).status,
        ).toBe(200);
        for (const n of [2, 3]) {
          expect(
            json(
              yield* call("threads.send", {
                commandId: `queue-send-${n}`,
                threadId: "queue-api",
                createdBy: "user",
                creationSource: "mcp",
                messageId: `queue-message-${n}`,
                text: `Queued ${n}`,
                attachments: [],
                dispatchMode: { type: "queue_after_active" },
              }),
            ).status,
          ).toBe(200);
        }
        const threadId = "queue-api";
        const second = "run:queue-api:2";
        const third = "run:queue-api:3";
        const input = {
          commandId: "api-edit",
          threadId,
          runId: second,
          text: "Edited through API",
        };
        for (const [name, body] of [
          ["threads.queuedRun.edit", input],
          ["threads.queuedRun.reorder", { threadId, runId: third, beforeRunId: second }],
        ] as const) {
          expect(json(yield* call(name, body, person([AuthOrchestrationReadScope]))).status).toBe(
            403,
          );
        }
        const edited = json(yield* call("threads.queuedRun.edit", input));
        expect(edited.status).toBe(200);
        expect(json(yield* call("threads.queuedRun.edit", input))).toEqual(edited);
        expect(
          json(
            yield* call("threads.queuedRun.reorder", {
              commandId: "api-reorder",
              threadId,
              runId: third,
              beforeRunId: second,
            }),
          ).status,
        ).toBe(200);
        expect(json(yield* call("threads.get", { threadId })).body).toMatchObject({
          messages: expect.arrayContaining([
            expect.objectContaining({ id: "queue-message-2", text: "Edited through API" }),
          ]),
          runs: expect.arrayContaining([
            expect.objectContaining({ id: third, status: "queued", queuePosition: 1 }),
            expect.objectContaining({ id: second, status: "queued", queuePosition: 2 }),
          ]),
        });
        expect(
          json(yield* call("threads.queuedRun.cancel", { threadId, runId: second })).status,
        ).toBe(200);
        for (const [name, body] of [
          ["threads.queuedRun.edit", { ...input, commandId: "stale-api-edit" }],
          ["threads.queuedRun.reorder", { threadId, runId: second, beforeRunId: null }],
        ] as const) {
          const refused = json(yield* call(name, body));
          expect(refused.status).toBe(422);
          expect(refused.body).toMatchObject({
            error: { _tag: "OrchestrationV2DispatchCommandError" },
          });
        }
        yield* cloud.settle;
      }),
  );
});
