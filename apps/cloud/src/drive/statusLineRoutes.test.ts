import { describe, expect, it } from "@effect/vitest";
import {
  STATUS_LINE_PATHS,
  type StatusNoteView,
  statusLineJson,
} from "@signalbox/runner-protocol/StatusLineProtocol";
import { CommandId, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as Environment from "../environment.ts";
import { makeMemoryCloud } from "../testing.ts";
import * as CloudThreadService from "../thread/CloudThreadService.ts";
import type { DriveAuthorization } from "../thread/ThreadAuthorization.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import { wire } from "../thread/threadWire.ts";
import * as UserFolders from "../user/UserFolders.ts";
import type { DriveRouteEnv } from "./driveRoutes.ts";
import { handleDriveRequest } from "./driveRoutes.ts";
import { driveToken } from "./driveToken.ts";

/**
 * A thread's agent reading what's going on around it (#670): the drive API
 * checks the thread's drive token, and the thread's owner's object rolls up
 * its home folder, the folder and everything below it, with each live
 * thread's line. Writes go to the thread's own object, refused in words when
 * the note isn't one.
 */

const OWNER = "user_owner";
const actor = { userId: OWNER, contextIds: [PERSONAL_CONTEXT_ID] };
const REPORT = ThreadId.make("thread-report");
const DRAFT = ThreadId.make("thread-draft");
const ELSEWHERE = ThreadId.make("thread-elsewhere");
const LEASE = "lease-secret";

const cloud = makeMemoryCloud();

/** What the thread's own object was asked to write, in order. */
const written: Array<string> = [];
const leaseTokens = new Map<string, string>();

const env = {
  THREADS: {
    idFromName: (name: string) => name,
    jurisdiction: () => ({ idFromName: (name: string) => name }),
    get: (threadId: ThreadId) => ({
      authorizeDrive: async (token: string): Promise<DriveAuthorization> =>
        token === leaseTokens.get(threadId)
          ? {
              _tag: "granted",
              threadId,
              userId: OWNER,
              driveId: `my/personal/${OWNER}`,
              generation: 1,
              live: true,
            }
          : { _tag: "denied", reason: "Not this thread's drive token." },
      statusLine: async () => null,
      writeStatusNote: async (input: string): Promise<StatusNoteView> => {
        written.push(input);
        return {
          ...statusLineJson.writeRequest.decode(input),
          writtenBy: "agent",
          writtenAt: "2026-10-16T09:00:00.000Z",
        };
      },
    }),
  },
  USERS: {
    idFromName: (name: string) => name,
    jurisdiction: () => ({ idFromName: (name: string) => name }),
    get: (userId: string) => cloud.userObjectApi(userId),
  },
  DRIVES: {},
  DRIVE_PACKS: {},
} as unknown as DriveRouteEnv;

const post = (threadId: ThreadId, path: string, body: unknown) =>
  Effect.gen(function* () {
    const token = yield* driveToken(LEASE, threadId, 1);
    leaseTokens.set(threadId, token);
    return yield* Effect.promise(async () => {
      const response = await handleDriveRequest(
        env,
        new Request(`https://cloud.test${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        }),
        { localWorkerd: true },
      );
      return { status: response.status, text: await response.text() };
    });
  });

const setup = Effect.gen(function* () {
  yield* cloud.userDirectory.forUser(OWNER).recordSignIn({ id: OWNER, email: "a@b.c" });
  const { threads, folders } = yield* Effect.all({
    threads: CloudThreadService.CloudThreadService,
    folders: UserFolders.UserFolders,
  }).pipe(Effect.provide(cloud.layerFor(OWNER)));
  for (const [threadId, title] of [
    [REPORT, "Quarterly report"],
    [DRAFT, "Report draft"],
    [ELSEWHERE, "Holiday plans"],
  ] as const) {
    yield* threads.launchThread(actor, {
      commandId: CommandId.make(`launch-${threadId}`),
      threadId,
      projectId: Environment.SCRATCH_PROJECT_ID,
      title,
      modelSelection: scriptedModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { messageId: MessageId.make(`m-${threadId}`), text: "Go", attachments: [] },
    });
  }
  yield* cloud.settle;
  const q3 = (yield* folders.create({ name: "Q3", parentId: null })).folders.find(
    (folder) => folder.name === "Q3",
  )!.id;
  const drafts = (yield* folders.create({ name: "Drafts", parentId: q3 })).folders.find(
    (folder) => folder.name === "Drafts",
  )!.id;
  yield* folders.moveThread({ threadId: REPORT, folderId: q3 });
  yield* folders.moveThread({ threadId: DRAFT, folderId: drafts });
  // The report's agent wrote its note; its summary brought it to the owner's object.
  const summary = (yield* cloud.threadDirectory
    .forThread(REPORT)
    .summary({ userId: OWNER, contextIds: [] }))!;
  yield* cloud.userDirectory.forUser(OWNER).recordThreadSummary(
    wire.summary.encode({
      ...summary,
      revision: summary.revision + 1,
      statusNote: {
        nextStep: "You: say whether the report can go out.",
        whereItGotTo: "The report is written and checked.",
        writtenAt: DateTime.makeUnsafe(1_000),
        writtenBy: "agent",
        runId: RunId.make("run-1"),
      },
    }),
  );
  return { q3 };
});

describe("status line routes (#670)", () => {
  it.effect("roll up the thread's home folder and everything below it", () =>
    Effect.gen(function* () {
      const { q3 } = yield* setup;
      const answer = yield* post(REPORT, STATUS_LINE_PATHS.folder, {});
      expect(answer.status).toBe(200);
      const status = statusLineJson.folder.decode(answer.text);
      expect(status.folder).toEqual({ id: q3, name: "Q3" });
      // Both turns ended: nothing moves, so the roll-up has nothing to say.
      expect(status.counts).toEqual({ working: 0, waiting: 0, idle: 2 });
      expect(status.summary).toBeNull();
      expect(status.more).toBe(0);
      expect(status.threads.map((thread) => [thread.title, thread.note?.nextStep ?? null])).toEqual(
        expect.arrayContaining([
          ["Quarterly report", "You: say whether the report can go out."],
          ["Report draft", null],
        ]),
      );
      expect(status.threads.map((thread) => thread.threadId)).not.toContain(ELSEWHERE);

      // A thread at the top level gets the top level: everything its owner sees.
      const top = statusLineJson.folder.decode(
        (yield* post(ELSEWHERE, STATUS_LINE_PATHS.folder, {})).text,
      );
      expect(top.folder).toBeNull();
      expect(top.threads).toHaveLength(3);
    }),
  );

  it.effect("write the agent's note to its own thread, refusing one that isn't a note", () =>
    Effect.gen(function* () {
      written.length = 0;
      const note = { nextStep: "Agent: send it out.", whereItGotTo: "It's approved." };
      const ok = yield* post(DRAFT, STATUS_LINE_PATHS.write, note);
      expect(statusLineJson.write.decode(ok.text)).toMatchObject({ _tag: "written", note });
      expect(written.map((input) => statusLineJson.writeRequest.decode(input))).toEqual([note]);

      const refused = statusLineJson.write.decode(
        (yield* post(DRAFT, STATUS_LINE_PATHS.write, { nextStep: "  ", whereItGotTo: "x" })).text,
      );
      expect(refused._tag).toBe("failed");
      expect(written).toHaveLength(1);
    }),
  );
});
