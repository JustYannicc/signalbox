import {
  CommandId,
  MessageId,
  type ModelSelection,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as Environment from "../environment.ts";
import * as PoolDirectory from "../pool/PoolDirectory.ts";
import { makeMemoryCloud } from "../testing.ts";
import * as UserPools from "../user/UserPools.ts";
import * as UserSections from "../user/UserSections.ts";
import * as CloudThreadService from "./CloudThreadService.ts";

/**
 * Turns run on the pool the thread's chain resolves to, never one the client
 * names: Personal at the top level, a section's pool below it.
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
    sections: UserSections.UserSections,
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
  it.effect("ignores the pool a client names, and follows the project when it moves", () =>
    Effect.gen(function* () {
      const { threads, pools, sections, cloud, signInClaude, send, runsOn } = yield* setup;
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

      // Moved into a section that runs on Work, its next turn does, whatever it names.
      let snapshot = yield* sections.create({ name: "Client work", parentId: null });
      const section = snapshot.sections[0]!.id;
      yield* sections.update({ id: section, defaultPoolId: work.id });
      snapshot = yield* sections.moveProject({ projectId: SCRATCH, sectionId: section });
      yield* send(claudeOn("claudeAgent"));
      yield* cloud.settle;
      expect((yield* runsOn).at(-1)).toBe(`claude_hub_${work.id}`);

      // Back out, and it's on Personal again.
      yield* sections.moveProject({ projectId: SCRATCH, sectionId: null });
      yield* send(claudeOn(`claude_hub_${work.id}`));
      yield* cloud.settle;
      expect((yield* runsOn).at(-1)).toBe("claude_hub");
    }),
  );

  it.effect("refuses a model the resolved pool doesn't serve, even if another pool does", () =>
    Effect.gen(function* () {
      const { threads, pools, sections, cloud } = yield* setup;
      // Lab has no accounts; Personal serves Claude.
      const lab = yield* pools.create({ userId }, { name: "Lab" });
      const snapshot = yield* sections.create({ name: "Lab", parentId: null });
      yield* sections.update({ id: snapshot.sections[0]!.id, defaultPoolId: lab.id });
      yield* sections.moveProject({ projectId: SCRATCH, sectionId: snapshot.sections[0]!.id });

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
      const { threads, sections } = yield* setup;
      // Nothing placed anywhere: Personal taken off the top level.
      yield* sections.forgetPool("personal");
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
});
