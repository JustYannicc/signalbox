import { describe, expect, it } from "@effect/vitest";
import { AUTOMATION_PATHS, automationJson } from "@signalbox/runner-protocol/AutomationProtocol";
import {
  AGENT_PULL_REQUEST_TOOL,
  type Request as AgentPullRequestRequest,
} from "@signalbox/runner-protocol/PullRequestTools";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { DriveAuthorization } from "../thread/runner/ThreadRunner.ts";
import type { DriveRouteEnv } from "./driveRoutes.ts";
import { handleDriveRequest } from "./driveRoutes.ts";
import { driveToken } from "./driveToken.ts";

const OWNER = "user_owner";
const OTHER_OWNER = "user_other";
const RUNNING = ThreadId.make("thread-aaaa1111");
const OTHER = ThreadId.make("thread-bbbb2222");
const IDLE = ThreadId.make("thread-cccc3333");
const LEASE = "lease-secret";

type ToolCall = {
  readonly userId: string;
  readonly threadId: string;
  readonly name: string;
  readonly input: unknown;
};

const toolCalls: Array<ToolCall> = [];
const authorizations = new Map<string, Extract<DriveAuthorization, { _tag: "granted" }>>();

const tokenFor = (threadId: ThreadId, userId: string, live: boolean, lease = LEASE) =>
  Effect.tap(driveToken(lease, threadId, 1), (token) =>
    Effect.sync(() =>
      authorizations.set(token, {
        _tag: "granted",
        threadId,
        userId,
        driveId: `my/personal/${userId}`,
        generation: 1,
        live,
      }),
    ),
  );

/** The real drive route authenticates the token before reaching this DO boundary. */
const env = {
  THREADS: {
    idFromName: (name: string) => name,
    jurisdiction: () => ({ idFromName: (name: string) => name }),
    get: (threadId: ThreadId) => ({
      authorizeDrive: async (token: string): Promise<DriveAuthorization> => {
        const authorization = authorizations.get(token);
        return authorization?.threadId === threadId
          ? authorization
          : { _tag: "denied", reason: "Not this thread's drive token." };
      },
    }),
  },
  USERS: {
    idFromName: (name: string) => name,
    jurisdiction: () => ({ idFromName: (name: string) => name }),
    get: (userId: string) => ({
      automationTool: async (threadId: string, name: string, input: unknown) => {
        toolCalls.push({ userId, threadId, name, input });
        return { _tag: "ok" as const, result: { accepted: true } };
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

describe("agent pull request tools through an authenticated drive token (#861)", () => {
  it.effect("routes to the token's owner and thread despite spoofed PR input", () =>
    Effect.gen(function* () {
      toolCalls.length = 0;
      authorizations.clear();
      const token = yield* tokenFor(RUNNING, OWNER, true);
      const otherToken = yield* tokenFor(OTHER, OTHER_OWNER, true);
      const comment: AgentPullRequestRequest = {
        _tag: "comment",
        body: "Please review this change.",
        operationId: "comment-1",
      };
      const injectedInput = {
        ...comment,
        threadId: OTHER,
        repository: "attacker/target",
        token: "attacker-github-token",
      };

      expect(
        yield* callTool(token, { name: AGENT_PULL_REQUEST_TOOL, input: injectedInput }),
      ).toEqual({ _tag: "ok", result: { accepted: true } });
      expect(toolCalls).toEqual([
        {
          userId: OWNER,
          threadId: RUNNING,
          name: AGENT_PULL_REQUEST_TOOL,
          input: injectedInput,
        },
      ]);

      const read: AgentPullRequestRequest = { _tag: "read", number: 42 };
      const otherInjectedInput = {
        ...read,
        threadId: RUNNING,
        repository: "attacker/target",
        token: "attacker-github-token",
      };
      yield* callTool(otherToken, {
        name: AGENT_PULL_REQUEST_TOOL,
        input: otherInjectedInput,
      });
      expect(toolCalls[1]).toEqual({
        userId: OTHER_OWNER,
        threadId: OTHER,
        name: AGENT_PULL_REQUEST_TOOL,
        input: otherInjectedInput,
      });
    }),
  );

  it.effect("does not dispatch forged or stopped thread credentials", () =>
    Effect.gen(function* () {
      toolCalls.length = 0;
      authorizations.clear();
      const stoppedToken = yield* tokenFor(IDLE, OWNER, false);
      const forgedToken = yield* driveToken("another-lease", RUNNING, 1);
      const mutation: AgentPullRequestRequest = {
        _tag: "comment",
        body: "This must not be sent without the owning thread's live token.",
        operationId: "comment-2",
      };

      expect(
        yield* callTool(forgedToken, {
          name: AGENT_PULL_REQUEST_TOOL,
          input: mutation,
        }),
      ).toEqual({ status: 403, text: "Not this thread's drive token." });
      expect(
        yield* callTool("not-a-token", { name: AGENT_PULL_REQUEST_TOOL, input: mutation }),
      ).toEqual({
        status: 401,
        text: "Not a drive token.",
      });
      expect(
        yield* callTool(stoppedToken, {
          name: AGENT_PULL_REQUEST_TOOL,
          input: mutation,
        }),
      ).toEqual({ status: 403, text: "Only a running turn uses automation tools." });
      expect(toolCalls).toEqual([]);
    }),
  );
});
