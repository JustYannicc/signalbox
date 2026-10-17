import { describe, expect, it } from "@effect/vitest";
import {
  LEARNER_PATHS,
  learnerJson,
  type LearnerToolResult,
} from "@signalbox/runner-protocol/LearnerProtocol";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ThreadObjectNamespace } from "../thread/ThreadDirectory.ts";
import type { DriveRouteEnv } from "./driveRoutes.ts";
import { handleDriveRequest } from "./driveRoutes.ts";
import { driveToken } from "./driveToken.ts";

const OWNER = "user_owner";
const RUNNING = ThreadId.make("thread-aaaa1111");
const OTHER = ThreadId.make("thread-bbbb2222");
const IDLE = ThreadId.make("thread-cccc3333");
const LEASE = "lease-secret";

const calls: Array<{ threadId: string; name: string; input: unknown }> = [];
const tokens = new Map<ThreadId, string>();
const tokenFor = (threadId: ThreadId) =>
  Effect.tap(driveToken(LEASE, threadId, 1), (token) =>
    Effect.sync(() => tokens.set(threadId, token)),
  );

const env = {
  THREADS: {
    idFromName: (name: string) => name,
    jurisdiction: () => ({ idFromName: (name: string) => name }),
    get: (threadId: ThreadId) =>
      ({
        authorizeDrive: async (token: string) =>
          token === tokens.get(threadId)
            ? {
                _tag: "granted",
                threadId,
                userId: OWNER,
                driveId: `my/personal/${OWNER}`,
                generation: 1,
                live: threadId !== IDLE,
              }
            : { _tag: "denied", reason: "Not this thread's drive token." },
      }) satisfies Pick<ReturnType<ThreadObjectNamespace["get"]>, "authorizeDrive">,
  },
  USERS: {
    idFromName: (name: string) => name,
    jurisdiction: () => ({ idFromName: (name: string) => name }),
    get: () => ({
      learnerTool: async (
        threadId: string,
        name: string,
        input: unknown,
      ): Promise<LearnerToolResult> => {
        calls.push({ threadId, name, input });
        return { _tag: "ok", result: { threadId, name } };
      },
    }),
  },
  DRIVES: {},
  DRIVE_PACKS: {},
} as unknown as DriveRouteEnv;

const callTool = (token: string, body: unknown) =>
  Effect.promise(async () => {
    const response = await handleDriveRequest(
      env,
      new Request(`https://cloud.test${LEARNER_PATHS.tool}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
      { localWorkerd: true },
    );
    const text = await response.text();
    return response.status === 200
      ? learnerJson.tool.decode(text)
      : ({ status: response.status, text } as const);
  });

describe("learner tools from a thread's machine (#668)", () => {
  it.effect("forwards to the owner's learner for the authenticated thread", () =>
    Effect.gen(function* () {
      calls.length = 0;
      const token = yield* tokenFor(RUNNING);
      const input = {
        eventId: "ask:ask_1:draft",
        source: "asks",
        kind: "draft",
        content: "Yes, the checks passed.",
        input: "Can this go ahead?",
        objectId: "ask_1",
      };
      expect(yield* callTool(token, { name: "learner_log_event", input })).toEqual({
        _tag: "ok",
        result: { threadId: RUNNING, name: "learner_log_event" },
      });
      expect(calls).toEqual([{ threadId: RUNNING, name: "learner_log_event", input }]);

      const otherToken = yield* tokenFor(OTHER);
      yield* callTool(otherToken, { name: "learner_query", input: { task: "review a PR" } });
      expect(calls[1]).toEqual({
        threadId: OTHER,
        name: "learner_query",
        input: { task: "review a PR" },
      });
    }),
  );

  it.effect(
    "rejects bad credentials, stopped turns, and malformed tool calls before forwarding",
    () =>
      Effect.gen(function* () {
        calls.length = 0;
        const token = yield* tokenFor(RUNNING);
        const forged = yield* driveToken("another-lease", RUNNING, 1);
        expect(yield* callTool(forged, { name: "learner_query", input: { task: "x" } })).toEqual({
          status: 403,
          text: "Not this thread's drive token.",
        });
        expect(
          yield* callTool("not-a-token", { name: "learner_query", input: { task: "x" } }),
        ).toEqual({
          status: 401,
          text: "Not a drive token.",
        });
        expect(
          yield* callTool(yield* tokenFor(IDLE), { name: "learner_query", input: { task: "x" } }),
        ).toEqual({ status: 403, text: "Only a running turn uses learner tools." });
        expect(yield* callTool(token, { name: "other_tool", input: {} })).toEqual({
          status: 400,
          text: "Unreadable request.",
        });
        expect(calls).toEqual([]);
      }),
  );

  it.effect("rejects caller-selected scope or folder ids before the learner service", () =>
    Effect.gen(function* () {
      calls.length = 0;
      const token = yield* tokenFor(RUNNING);
      for (const [name, input] of [
        [
          "learner_log_event",
          {
            eventId: "e1",
            source: "asks",
            kind: "observation",
            content: "x",
            folderId: "folder_other",
          },
        ],
        ["learner_query", { task: "review a PR", scope: "company:other" }],
        ["learner_query", { task: "review a PR", personId: "user_other" }],
      ] as const) {
        expect(yield* callTool(token, { name, input })).toEqual({
          _tag: "failed",
          message: "Unreadable learner request.",
        });
      }
      expect(calls).toEqual([]);
    }),
  );
});
