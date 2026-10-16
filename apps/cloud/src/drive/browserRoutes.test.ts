import { describe, expect, it } from "@effect/vitest";
import { BROWSER_PATHS, browserJson } from "@signalbox/runner-protocol/BrowserProtocol";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { memoryKernel } from "../browser/memoryKernel.ts";
import { makeMemoryCloud } from "../testing.ts";
import type { DriveAuthorization } from "../thread/runner/ThreadRunner.ts";
import type { DriveRouteEnv } from "./driveRoutes.ts";
import { handleDriveRequest } from "./driveRoutes.ts";
import { driveToken } from "./driveToken.ts";

/**
 * A thread's machine asking for the person's browser (#574): the drive API
 * checks the thread's drive token, and the thread's owner's object opens the
 * session on the owner's own profile, only while a turn runs.
 */

const OWNER = "user_owner";
const RUNNING = ThreadId.make("thread-aaaa1111");
const IDLE = ThreadId.make("thread-cccc3333");
const LEASE = "lease-secret";

const leaseTokens = new Map<ThreadId, string>();
const tokenFor = (threadId: ThreadId) =>
  Effect.tap(driveToken(LEASE, threadId, 1), (token) =>
    Effect.sync(() => leaseTokens.set(threadId, token)),
  );

/** The drive API's bindings over `cloud`: each thread's object grants only its lease's token. */
const envFor = (cloud: ReturnType<typeof makeMemoryCloud>) =>
  ({
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
  }) as unknown as DriveRouteEnv;

const post = (env: DriveRouteEnv, path: string, token: string, body: unknown) =>
  Effect.promise(async () => {
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

const signIn = (cloud: ReturnType<typeof makeMemoryCloud>) =>
  cloud.userDirectory.forUser(OWNER).recordSignIn({ id: OWNER, email: "owner@example.test" });

describe("the person's browser from a thread's machine (#574)", () => {
  // The drive route keeps its runtime for the Worker's life, so one cloud serves every case.
  const kernel = memoryKernel();
  const cloud = makeMemoryCloud({ kernel: kernel.api });
  const env = envFor(cloud);

  it.effect("opens on the owner's profile during a turn, and ends when asked", () =>
    Effect.gen(function* () {
      yield* signIn(cloud);
      const token = yield* tokenFor(RUNNING);
      const opened = yield* post(env, BROWSER_PATHS.session, token, {});
      expect(opened.status).toBe(200);
      expect(browserJson.session.decode(opened.text)).toEqual({
        _tag: "ready",
        sessionId: "browser-1",
        cdpWsUrl: "wss://cdp.test/browser-1",
      });
      expect(kernel.created[0]?.tags).toEqual({ signalbox_thread: RUNNING });

      expect(yield* post(env, BROWSER_PATHS.end, token, { sessionId: "browser-1" })).toEqual({
        status: 200,
        text: "Ended.",
      });
      expect(kernel.deleted).toEqual(["browser-1"]);
    }),
  );

  it.effect("refuses a stopped turn and turns away a bad request", () =>
    Effect.gen(function* () {
      yield* signIn(cloud);
      const idle = yield* post(env, BROWSER_PATHS.session, yield* tokenFor(IDLE), {});
      expect(browserJson.session.decode(idle.text)).toEqual({
        _tag: "refused",
        message: "Only a running turn opens the person's browser.",
      });
      expect(
        yield* post(env, BROWSER_PATHS.end, yield* tokenFor(RUNNING), { session: "x" }),
      ).toEqual({ status: 400, text: "Unreadable request." });
      expect(kernel.created).toHaveLength(1);
    }),
  );

  it.effect("answers unconfigured in a cloud without a Kernel key", () =>
    Effect.gen(function* () {
      // The owner's object answers; no Kernel behind it.
      const plain = makeMemoryCloud();
      yield* signIn(plain);
      expect(
        yield* plain.userDirectory
          .forUser(OWNER)
          .browserSession({ threadId: RUNNING, requester: OWNER }),
      ).toEqual({ _tag: "unconfigured" });
    }),
  );
});
