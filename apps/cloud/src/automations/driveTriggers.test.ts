import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
} from "@t3tools/contracts";
import { compileForCloud } from "@signalbox/automation-compiler/compileForCloud";
import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import { DriveDirectory } from "../drive/DriveDirectory.ts";
import { threadRef } from "../drive/DriveStore.ts";
import { makeRepo } from "../drive/driveTesting.ts";
import { uploadPack } from "../drive/DriveUploads.ts";
import * as Environment from "../environment.ts";
import { makeMemoryCloud } from "../testing.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import * as CloudRpc from "../user/rpc.ts";
import { CloudAutomations } from "./CloudAutomations.ts";

/**
 * #471: work landing in a drive starts the automations listening for it and
 * wakes runs waiting on it, through the drive object's outbox, exactly once.
 */

const identity = {
  environmentId: EnvironmentId.make("cloud-test"),
  label: "Cloud",
  scripted: true,
};
const userId = "user_1";
// The user's Personal My Drive is the Scratch project's.
const DRIVE = `my/personal/${userId}`;

const repos: Array<ReturnType<typeof makeRepo>> = [];
afterEach(() => {
  for (const created of repos.splice(0)) created.cleanup();
});

const setup = Effect.gen(function* () {
  const cloud = makeMemoryCloud();
  yield* cloud.userDirectory.forUser(userId).recordSignIn({ id: userId, email: "a@b.c" });
  const rpc = yield* RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
    Effect.provide(
      Layer.mergeAll(
        CloudRpc.layerHandlers({ identity, userId, sid: "test-session" }),
        CloudRpc.layerScopeAuthorization([
          AuthOrchestrationReadScope,
          AuthOrchestrationOperateScope,
        ]),
      ).pipe(Layer.provide(cloud.layerFor(userId))),
    ),
  );
  const thread = (id: string, text: string) =>
    rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
      commandId: CommandId.make(`launch-${id}`),
      threadId: ThreadId.make(id),
      projectId: Environment.SCRATCH_PROJECT_ID,
      title: text,
      modelSelection: scriptedModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { messageId: MessageId.make(`message-${id}`), text, attachments: [] },
    }).pipe(Effect.andThen(cloud.settle), Effect.as(ThreadId.make(id)));
  const tool = (threadId: string, name: string, input: unknown) =>
    cloud.inUser(
      userId,
      CloudAutomations.use((automations) => automations.tool({ threadId }, name, input)),
    );
  const save = (threadId: string, source: string) =>
    Effect.gen(function* () {
      const compiled = compileForCloud(source);
      if (!compiled.ok) return yield* Effect.die(JSON.stringify(compiled.diagnostics));
      const saved = (yield* tool(threadId, "automation_save", {
        source,
        compiled: compiled.compiled,
      })) as { readonly ok: boolean; readonly automation: { readonly automationId: string } };
      expect(saved.ok).toBe(true);
      return saved.automation.automationId;
    });
  const engine = <A, E>(use: (engine: WorkflowEngine.WorkflowEngineShape) => Effect.Effect<A, E>) =>
    cloud.inUser(userId, WorkflowEngine.WorkflowEngine.use(use));

  const git = makeRepo();
  repos.push(git);
  const drive = cloud.drives.apiFor(DRIVE);
  const writer = (threadId: string) => ({
    threadId,
    userId,
    generation: 1,
    live: true,
    packsAfter: 0,
  });
  /** A thread's turn landing `path` in the drive: its branch saved, then `main` moved to it. */
  const land = (threadId: string, path: string, contents: string) =>
    Effect.gen(function* () {
      const before = yield* Effect.promise(() => drive.ref("main"));
      git.write(path, contents);
      const commit = git.commit(`Write ${path}`);
      const packed = git.pack([commit], before === null ? [] : [before]);
      yield* uploadPack({ driveId: DRIVE, threadId, idx: packed.idx, pack: packed.pack }).pipe(
        Effect.provide(cloud.drives.layer),
      );
      const handle = yield* DriveDirectory.use((directory) =>
        Effect.succeed(directory.forDrive(DRIVE)),
      ).pipe(Effect.provide(cloud.drives.layer));
      yield* handle.open(writer(threadId));
      const branch = yield* Effect.promise(() => drive.ref(threadRef(threadId)));
      yield* handle.updateRefs(writer(threadId), [
        { name: threadRef(threadId), old: branch, new: commit },
      ]);
      yield* handle.reconcile(writer(threadId), { expectedMain: before, newMain: commit });
      yield* cloud.settle;
      return commit;
    });
  return { cloud, thread, save, engine, land };
});

describe("drive events in cloud automations", () => {
  it.effect("a file landing in the drive starts a run, once", () =>
    Effect.gen(function* () {
      const { cloud, thread, save, engine, land } = yield* setup;
      const writer = yield* thread("thread-writer", "Watch my drive");
      const automationId = yield* save(
        writer,
        `export const meta = { name: "Files landed", triggers: [{ on: "drive.changed" }] } as const;
export default workflow(async (w, event: { ref: string; after: string; files: unknown; commits: Array<{ message: string }> }) => {
  return { ref: event.ref, after: event.after, files: event.files, message: event.commits[0]?.message };
});`,
      );

      const commit = yield* land("thread-work", "notes/today.md", "hello\n");
      const { runs } = yield* engine((engine) => engine.get(automationId));
      expect(runs.map((run) => [run.trigger, run.status])).toEqual([["event", "succeeded"]]);
      const run = yield* engine((engine) => engine.getRun(runs[0]!.id));
      expect(run.output).toEqual({
        ref: "main",
        after: commit,
        files: [{ path: "notes/today.md", kind: "added" }],
        message: "Write notes/today.md\n",
      });

      // The same moves delivered again (a retry after a lost answer) are dropped before
      // any trigger sees them: even an automation saved since doesn't start.
      const late = yield* save(
        writer,
        `export const meta = { name: "Late listener", triggers: [{ on: "drive.changed" }] } as const;
export default workflow(async (w) => "ran");`,
      );
      // The branch save was the drive's first move, landing on main its second.
      const sequence = 2;
      yield* cloud.userDirectory.forUser(userId).driveEvents({
        driveId: DRIVE,
        events: [
          {
            sequence,
            ref: "main",
            before: null,
            after: commit,
            threadId: "thread-work",
            at: 0,
            commits: [],
            commitsTruncated: false,
          },
        ],
      });
      yield* cloud.settle;
      const again = yield* engine((engine) => engine.get(automationId));
      expect(again.runs).toHaveLength(1);
      expect((yield* engine((engine) => engine.get(late))).runs).toEqual([]);
    }),
  );

  it.effect("a thread saving its branch is its own event", () =>
    Effect.gen(function* () {
      const { thread, save, engine, land } = yield* setup;
      const writer = yield* thread("thread-reviewer", "Review revisions");
      const automationId = yield* save(
        writer,
        `export const meta = { name: "Review revision", triggers: [{ on: "drive.branch-saved" }] } as const;
export default workflow(async (w, event: { ref: string; threadId: string; before: string | null }) => {
  return [event.ref, event.threadId, event.before];
});`,
      );
      yield* land("thread-work", "a.txt", "a\n");
      const { runs } = yield* engine((engine) => engine.get(automationId));
      expect(runs).toHaveLength(1);
      const run = yield* engine((engine) => engine.getRun(runs[0]!.id));
      expect(run.output).toEqual([threadRef("thread-work"), "thread-work", null]);
    }),
  );

  it.effect("a run waiting on a drive change wakes when one lands", () =>
    Effect.gen(function* () {
      const { cloud, thread, save, engine, land } = yield* setup;
      const writer = yield* thread("thread-waiter", "Wait for the report");
      const automationId = yield* save(
        writer,
        `export const meta = { name: "Wait for report" } as const;
export default workflow(async (w) => {
  const event = await w.waitFor("Wait for the report", { on: "drive.changed", timeout: { days: 1 } });
  return event === null ? "timed out" : (event as { files: Array<{ path: string }> }).files.map((file) => file.path);
});`,
      );
      const started = yield* engine((engine) =>
        engine.startRun({ automationId, trigger: "manual" }),
      );
      yield* cloud.settle;
      const waiting = yield* engine((engine) => engine.getRun(started.id));
      expect(waiting.run.status).toBe("running");

      yield* land("thread-work", "report.pdf", "%PDF\n");
      const done = yield* engine((engine) => engine.getRun(started.id));
      expect([done.run.status, done.output]).toEqual(["succeeded", ["report.pdf"]]);
    }),
  );
});
