import { DRIVE_PATHS } from "@signalbox/runner-protocol/DriveProtocol";
import { pullJson } from "@signalbox/runner-protocol/PullProtocol";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { driveToken } from "./driveToken.ts";
import { handleDriveRequest, type DriveRouteEnv } from "./driveRoutes.ts";

describe("pull saves while a closing machine drains", () => {
  let allowed: string | null = null;
  let saves = 0;
  const operation = {
    id: "pull-1",
    target: "a".repeat(40),
    expectedThread: "b".repeat(40),
    expectedWip: null,
    revision: null,
    branch: "threads/thread-1",
  };
  const result = {
    id: operation.id,
    target: operation.target,
    head: operation.target,
    wip: null,
    outcome: "pulled",
    reason: null,
    hasWorkingTreeChanges: false,
  } as const;
  const env = {
    THREADS: {
      idFromName: (id: string) => id,
      get: () => ({
        authorizeDrive: async () => ({
          _tag: "granted",
          threadId: "thread-1",
          userId: "owner",
          driveId: "drive-1",
          generation: 1,
          live: false,
          pullOperationId: allowed,
        }),
      }),
    },
    DRIVES: {
      idFromName: (id: string) => id,
      get: () => ({
        savePull: async () => {
          saves++;
          return result;
        },
      }),
    },
    USERS: {},
    DRIVE_PACKS: {},
  } as unknown as DriveRouteEnv;

  it.effect("rejects a completed or different pull but permits the current operation", () =>
    Effect.gen(function* () {
      const token = yield* driveToken("lease", ThreadId.make("thread-1"), 1);
      const send = () =>
        Effect.promise(() =>
          handleDriveRequest(
            env,
            new Request(`https://cloud.test${DRIVE_PATHS.pullSave}`, {
              method: "POST",
              headers: { authorization: `Bearer ${token}` },
              body: pullJson.save.encode({ operation, result }),
            }),
            { localWorkerd: true },
          ),
        );
      for (const id of [null, "another-pull"]) {
        allowed = id;
        expect((yield* send()).status).toBe(403);
      }
      expect(saves).toBe(0);
      allowed = operation.id;
      const response = yield* send();
      expect(response.status).toBe(200);
      expect(pullJson.result.decode(yield* Effect.promise(() => response.text()))).toEqual(result);
      expect(saves).toBe(1);
    }),
  );
});
