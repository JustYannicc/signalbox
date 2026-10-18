import { describe, expect, it } from "@effect/vitest";
import { AUTOMATION_PATHS, automationJson } from "@signalbox/runner-protocol/AutomationProtocol";
import { AutomationError, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { automationTool } from "../automations/automationTool.ts";
import { CloudAutomations } from "../automations/CloudAutomations.ts";
import { makeMemoryCloud } from "../testing.ts";
import type { DriveAuthorization } from "../thread/ThreadAuthorization.ts";
import type { DriveRouteEnv } from "./driveRoutes.ts";
import { handleDriveRequest } from "./driveRoutes.ts";
import { driveToken } from "./driveToken.ts";

/**
 * A thread's agent calling an automation tool from its machine (#434): the
 * drive API checks the thread's drive token, and the thread's owner's object
 * runs the call on their engine, for the thread the token names.
 */

const OWNER = "user_owner";
const RUNNING = ThreadId.make("thread-aaaa1111");
const OTHER = ThreadId.make("thread-bbbb2222");
const IDLE = ThreadId.make("thread-cccc3333");
const LEASE = "lease-secret";

/** What the engine was asked, in order. */
const engineCalls: Array<{ threadId: string; name: string; input: unknown }> = [];

const cloud = makeMemoryCloud({
  automations: Layer.succeed(
    CloudAutomations,
    CloudAutomations.of({
      answerAsk: () => Effect.die("not in these tests"),
      listBlocks: () => Effect.die("not in these tests"),
      save: () => Effect.die("not in these tests"),
      receiveHook: () => Effect.die("not in these tests"),
      threadEvents: () => Effect.void,
      driveEvents: () => Effect.void,
      wake: Effect.void,
      flush: Effect.void,
      start: Effect.void,
      host: () => Effect.die("not in these tests"),
      executorRunActive: () => Effect.succeed(false),
      workerModule: () => Effect.die("not in these tests"),
      tool: (caller, name, input) =>
        Effect.gen(function* () {
          engineCalls.push({ threadId: caller.threadId, name, input });
          if (name === "automation_read") {
            return yield* new AutomationError({ message: "No automation automation_9." });
          }
          return { ok: true, outline: "notify Say hi" };
        }),
    }),
  ),
});

/** Each thread's current drive token, as its lease signs it. */
const leaseTokens = new Map<ThreadId, string>();
const tokenFor = (threadId: ThreadId) =>
  Effect.tap(driveToken(LEASE, threadId, 1), (token) =>
    Effect.sync(() => leaseTokens.set(threadId, token)),
  );

/**
 * The Durable Object bindings the drive API reaches: each thread's object
 * grants only its lease's drive token (`ThreadRunner.authorizeDrive`, tested there),
 * and the owner's object is the memory cloud's.
 */
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
              live: threadId !== IDLE,
            }
          : { _tag: "denied", reason: "Not this thread's drive token." },
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

const callTool = (token: string, body: unknown) =>
  Effect.promise(async () => {
    const response = await handleDriveRequest(
      env,
      new Request(`https://cloud.test${AUTOMATION_PATHS.tool}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
      { localWorkerd: true },
    );
    const text = await response.text();
    return response.status === 200
      ? automationJson.tool.decode(text)
      : ({ status: response.status, text } as const);
  });

describe("automation tools from a thread's machine (#434)", () => {
  it.effect("run on the owner's engine, for the thread the drive token names", () =>
    Effect.gen(function* () {
      engineCalls.length = 0;
      const token = yield* tokenFor(RUNNING);
      const compiled = { meta: { name: "Weekly report" }, script: "…" };
      expect(
        yield* callTool(token, {
          name: "automation_save",
          input: { source: "export default …", compiled },
        }),
      ).toEqual({ _tag: "ok", result: { ok: true, outline: "notify Say hi" } });
      expect(engineCalls).toEqual([
        {
          threadId: RUNNING,
          name: "automation_save",
          input: { source: "export default …", compiled },
        },
      ]);

      // Another thread's token acts for that thread, never this one.
      yield* callTool(yield* tokenFor(OTHER), { name: "list_waits", input: {} });
      expect(engineCalls[1]).toMatchObject({ threadId: OTHER, name: "list_waits" });

      // The engine's refusal is an answer, in its words.
      expect(
        yield* callTool(token, {
          name: "automation_read",
          input: { automationId: "automation_9" },
        }),
      ).toEqual({ _tag: "failed", message: "No automation automation_9." });
    }),
  );

  it.effect("turn away a wrong credential, a stopped turn and a bad request", () =>
    Effect.gen(function* () {
      engineCalls.length = 0;
      yield* tokenFor(RUNNING);
      const forged = yield* driveToken("another-lease", RUNNING, 1);
      expect(yield* callTool(forged, { name: "automation_list", input: {} })).toEqual({
        status: 403,
        text: "Not this thread's drive token.",
      });
      expect(yield* callTool("not-a-token", { name: "automation_list", input: {} })).toEqual({
        status: 401,
        text: "Not a drive token.",
      });
      expect(
        yield* callTool(yield* tokenFor(IDLE), { name: "automation_list", input: {} }),
      ).toEqual({ status: 403, text: "Only a running turn uses automation tools." });
      expect(yield* callTool(yield* tokenFor(RUNNING), { tool: "automation_list" })).toEqual({
        status: 400,
        text: "Unreadable request.",
      });
      expect(engineCalls).toEqual([]);
    }),
  );

  it.effect("reach the owner's real engine, which answers for the calling thread", () =>
    Effect.gen(function* () {
      // The memory cloud's objects run the real engine; this thread was never created.
      const real = makeMemoryCloud();
      yield* real.userDirectory
        .forUser(OWNER)
        .recordSignIn({ id: OWNER, email: "owner@example.test" });
      expect(
        yield* real.userDirectory.forUser(OWNER).automationTool(RUNNING, "automation_list", {}),
      ).toEqual({ _tag: "failed", message: "The calling thread is gone." });
    }),
  );

  it.effect("answer that automations don't run in an object without an engine", () =>
    Effect.gen(function* () {
      expect(yield* automationTool(RUNNING, "automation_list", {})).toEqual({
        _tag: "failed",
        message: "Automations aren't running in this cloud yet.",
      });
    }),
  );
});
