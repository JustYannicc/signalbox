import {
  CommandId,
  MessageId,
  type ModelSelection,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { OnePasswordEnvironmentId } from "@t3tools/contracts/signalboxFolders";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as Environment from "../environment.ts";
import * as PoolDirectory from "../pool/PoolDirectory.ts";
import { makeMemoryCloud } from "../testing.ts";
import * as UserPools from "../user/UserPools.ts";
import * as UserFolders from "../user/UserFolders.ts";
import * as CloudThreadService from "./CloudThreadService.ts";
import { STATUS_LINE_INSTRUCTIONS } from "./statusLine/statusInstructions.ts";

/**
 * Turns run on the pool the thread's chain resolves to, never one the client
 * names: Personal at the top level, a folder's pool below it.
 */

const userId = "user_1";
const actor = { userId, contextIds: [PERSONAL_CONTEXT_ID] };
const threadId = ThreadId.make("thread-pools");
const SCRATCH = Environment.SCRATCH_PROJECT_ID;
const claudeOn = (instanceId: string, model = "claude-opus-5-5"): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});

const setup = Effect.gen(function* () {
  const cloud = makeMemoryCloud();
  yield* cloud.userDirectory.forUser(userId).recordSignIn({ id: userId, email: "a@b.c" });
  const services = yield* Effect.all({
    threads: CloudThreadService.CloudThreadService,
    pools: UserPools.UserPools,
    folders: UserFolders.UserFolders,
  }).pipe(Effect.provide(cloud.layerFor(userId)));
  /** Signs a Claude account into the pool, as Add account does. */
  const signInClaude = (poolId: string) =>
    Effect.gen(function* () {
      const pool = cloud.pools.directory.forPool(PoolDirectory.poolObjectName(userId, poolId));
      const login = yield* pool.startLogin({ userId }, "claude");
      yield* pool.completeLogin(
        { userId },
        `http://localhost/callback?code=c&state=${login.state}`,
      );
      yield* pool.loginStatus({ userId }, login.state);
    });
  yield* services.pools.list({ userId });
  yield* signInClaude("personal");
  let sent = 0;
  const send = (selection: ModelSelection) =>
    services.threads.dispatchCommand(actor, {
      type: "message.dispatch",
      commandId: CommandId.make(`send-${++sent}`),
      createdBy: "user",
      creationSource: "web",
      threadId,
      messageId: MessageId.make(`message-${sent}`),
      text: "Again",
      attachments: [],
      modelSelection: selection,
      dispatchMode: { type: "queue_after_active" },
    });
  const runsOn = Effect.map(services.threads.threadSnapshot(actor, threadId), ({ projection }) =>
    projection.runs.map((run) => run.providerInstanceId),
  );
  return { ...services, cloud, signInClaude, send, runsOn };
});

describe("turn pools", () => {
  it.effect("ignores the pool a client names, and follows the thread when it moves", () =>
    Effect.gen(function* () {
      const { threads, pools, folders, cloud, signInClaude, send, runsOn } = yield* setup;
      const work = yield* pools.create({ userId }, { name: "Work" });
      yield* signInClaude(work.id);

      // Launched naming Work's instance, it runs on Personal: Scratch sits at the top level.
      yield* threads.launchThread(actor, {
        commandId: CommandId.make("launch"),
        threadId,
        projectId: SCRATCH,
        title: "Hello",
        modelSelection: claudeOn(`claude_hub_${work.id}`),
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: { messageId: MessageId.make("message-0"), text: "Hi", attachments: [] },
      });
      yield* cloud.settle;
      expect(yield* runsOn).toEqual(["claude_hub"]);

      // Moved into a folder that runs on Work, its next turn does, whatever it names.
      const snapshot = yield* folders.create({ name: "Client work", parentId: null });
      const folder = snapshot.folders[0]!.id;
      yield* folders.update({ id: folder, poolId: work.id });
      yield* folders.moveThread({ threadId, folderId: folder });
      yield* send(claudeOn("claudeAgent"));
      yield* cloud.settle;
      expect((yield* runsOn).at(-1)).toBe(`claude_hub_${work.id}`);

      // Back out, and it's on Personal again.
      yield* folders.moveThread({ threadId, folderId: null });
      yield* send(claudeOn(`claude_hub_${work.id}`));
      yield* cloud.settle;
      expect((yield* runsOn).at(-1)).toBe("claude_hub");
    }),
  );

  it.effect("refuses a model the resolved pool doesn't serve, even if another pool does", () =>
    Effect.gen(function* () {
      const { threads, pools, folders, cloud } = yield* setup;
      // Lab has no accounts; Personal serves Claude.
      const lab = yield* pools.create({ userId }, { name: "Lab" });
      const snapshot = yield* folders.create({ name: "Lab", parentId: null });
      yield* folders.update({ id: snapshot.folders[0]!.id, poolId: lab.id });
      // Filed before it exists, so its very first turn runs on its home's chain.
      yield* folders.moveThread({ threadId, folderId: snapshot.folders[0]!.id });

      const refused = yield* Effect.flip(
        threads.launchThread(actor, {
          commandId: CommandId.make("launch-lab"),
          threadId,
          projectId: SCRATCH,
          title: "Hello",
          modelSelection: claudeOn("claude_hub"),
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: { messageId: MessageId.make("message-0"), text: "Hi", attachments: [] },
        }),
      );
      expect(refused.message).toBe(
        "This pool doesn't serve claude-opus-5-5 right now. Pick another model.",
      );
      yield* cloud.settle;
    }),
  );

  it.effect("needs a pool when nothing on the chain has one", () =>
    Effect.gen(function* () {
      const { threads, folders } = yield* setup;
      // Nothing placed anywhere: Personal taken off the top level.
      yield* folders.forgetPool("personal");
      const refused = yield* Effect.flip(
        threads.launchThread(actor, {
          commandId: CommandId.make("launch-none"),
          threadId,
          projectId: SCRATCH,
          title: "Hello",
          modelSelection: claudeOn("claude_hub"),
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: { messageId: MessageId.make("message-0"), text: "Hi", attachments: [] },
        }),
      );
      expect(refused.message).toBe(
        "This folder needs a pool. Choose one for it or a folder above it.",
      );
    }),
  );

  it.effect(
    "hands a thread filed before it exists its folder's instructions, top level first",
    () =>
      Effect.gen(function* () {
        const { threads, folders, cloud } = yield* setup;
        const work = (yield* folders.create({ name: "Work", parentId: null })).folders[0]!.id;
        yield* folders.setInstructions({ level: { _tag: "top" }, instructions: "Be brief." });
        yield* folders.setInstructions({
          level: { _tag: "folder", folderId: work },
          instructions: "End every reply with BANANA.",
        });
        // As the web does: the draft's thread is filed, then launched.
        yield* folders.moveThread({ threadId, folderId: work });
        yield* threads.launchThread(actor, {
          commandId: CommandId.make("launch-work"),
          threadId,
          projectId: SCRATCH,
          title: "Hello",
          modelSelection: claudeOn("claude_hub"),
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: { messageId: MessageId.make("message-0"), text: "Hi", attachments: [] },
        });
        const { projection } = yield* threads.threadSnapshot(actor, threadId);
        expect(yield* cloud.runInstructions(threadId, projection.runs[0]!.id)).toEqual([
          { label: "Top level", text: "Be brief." },
          { label: "Work", text: "End every reply with BANANA." },
          STATUS_LINE_INSTRUCTIONS,
        ]);
        yield* cloud.settle;
      }),
  );

  it.effect("hands a moved thread its new home's AGENTS.md from its next turn", () =>
    Effect.gen(function* () {
      const { threads, folders, cloud, send } = yield* setup;
      const work = (yield* folders.create({ name: "Work", parentId: null })).folders[0]!.id;
      const clients = (yield* folders.create({ name: "Clients", parentId: work })).folders.find(
        (folder) => folder.name === "Clients",
      )!.id;
      const home = (yield* folders.create({ name: "Home", parentId: null })).folders.find(
        (folder) => folder.name === "Home",
      )!.id;
      yield* folders.setInstructions({ level: { _tag: "top" }, instructions: "Be brief." });
      yield* folders.setInstructions({
        level: { _tag: "folder", folderId: work },
        instructions: "Use British spelling.",
      });
      yield* folders.setInstructions({
        level: { _tag: "folder", folderId: clients },
        instructions: "End every reply with BANANA.",
      });
      yield* folders.setInstructions({
        level: { _tag: "folder", folderId: home },
        instructions: "End every reply with APPLE.",
      });
      yield* folders.moveThread({ threadId, folderId: clients });
      yield* threads.launchThread(actor, {
        commandId: CommandId.make("launch-move"),
        threadId,
        projectId: SCRATCH,
        title: "Hello",
        modelSelection: claudeOn("claude_hub"),
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: { messageId: MessageId.make("message-0"), text: "Hi", attachments: [] },
      });
      yield* cloud.settle;

      yield* folders.moveThread({ threadId, folderId: home });
      yield* send(claudeOn("claude_hub"));
      const { projection } = yield* threads.threadSnapshot(actor, threadId);
      const [first, second] = projection.runs;
      expect(yield* cloud.runInstructions(threadId, first!.id)).toEqual([
        { label: "Top level", text: "Be brief." },
        { label: "Work", text: "Use British spelling." },
        { label: "Work / Clients", text: "End every reply with BANANA." },
        STATUS_LINE_INSTRUCTIONS,
      ]);
      expect(yield* cloud.runInstructions(threadId, second!.id)).toEqual([
        { label: "Top level", text: "Be brief." },
        { label: "Home", text: "End every reply with APPLE." },
        STATUS_LINE_INSTRUCTIONS,
      ]);
      yield* cloud.settle;
    }),
  );

  it.effect(
    "hands a thread its chain's 1Password Environments, and its new home's after a move",
    () =>
      Effect.gen(function* () {
        const { threads, folders, cloud, send } = yield* setup;
        const env = OnePasswordEnvironmentId.make;
        const work = (yield* folders.create({ name: "Work", parentId: null })).folders[0]!.id;
        const home = (yield* folders.create({ name: "Home", parentId: null })).folders.find(
          (folder) => folder.name === "Home",
        )!.id;
        yield* folders.setSecrets({
          level: { _tag: "top" },
          secrets: { environmentId: env("env-top"), includeSubfolders: ["TOP_KEY"] },
        });
        yield* folders.setSecrets({
          level: { _tag: "folder", folderId: work },
          secrets: { environmentId: env("env-work") },
        });
        yield* folders.moveThread({ threadId, folderId: work });
        yield* threads.launchThread(actor, {
          commandId: CommandId.make("launch-secrets"),
          threadId,
          projectId: SCRATCH,
          title: "Hello",
          modelSelection: claudeOn("claude_hub"),
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: { messageId: MessageId.make("message-0"), text: "Hi", attachments: [] },
        });
        expect(yield* cloud.threadSecrets(threadId)).toEqual(["env-top", "env-work"]);
        expect(yield* cloud.threadSecretEnvironmentNames(threadId)).toEqual([["TOP_KEY"], null]);
        yield* cloud.settle;

        // Moved to Home, which names none: its next turn gets the top level's only.
        yield* folders.moveThread({ threadId, folderId: home });
        expect(yield* cloud.threadSecrets(threadId)).toEqual(["env-top", "env-work"]);
        yield* send(claudeOn("claude_hub"));
        expect(yield* cloud.threadSecrets(threadId)).toEqual(["env-top"]);
        expect(yield* cloud.threadSecretEnvironmentNames(threadId)).toEqual([["TOP_KEY"]]);
        yield* cloud.settle;

        // A changed allowlist is applied by the next turn's owner resolution.
        yield* folders.setSecrets({
          level: { _tag: "top" },
          secrets: { environmentId: env("env-top"), includeSubfolders: [] },
        });
        yield* send(claudeOn("claude_hub"));
        expect(yield* cloud.threadSecrets(threadId)).toEqual([]);
        expect(yield* cloud.threadSecretEnvironmentNames(threadId)).toEqual([]);
        yield* cloud.settle;
      }),
  );
});
