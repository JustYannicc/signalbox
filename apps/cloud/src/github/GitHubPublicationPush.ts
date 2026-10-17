import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { DriveDirectory } from "../drive/DriveDirectory.ts";
import {
  commitsSince,
  GITHUB_LIMITS,
  packForPush,
  receivePackRequest,
  receivePackResult,
} from "../drive/gitPush.ts";
import { DriveReadError } from "../drive/DriveReader.ts";
import { GitHub } from "./GitHub.ts";

export const planPublicationPush = (driveId: string, head: string | null) =>
  Effect.gen(function* () {
    if (head === null) return null;
    const drive = (yield* DriveDirectory).forDrive(driveId);
    const history = yield* commitsSince(drive, head, new Set());
    const held = new Set(history.commits.map((commit) => commit.oid));
    if (
      !held.has(head) ||
      history.commits.some((commit) => commit.parents.some((parent) => !held.has(parent)))
    ) {
      return yield* new DriveReadError({
        message: "This folder's complete history is not available. Nothing was published.",
      });
    }
    // A new repository owns none of the drive's history, including main and the thread base.
    return yield* packForPush({ driveId, head, old: null, remoteHas: [], limits: GITHUB_LIMITS });
  });

export const pushPublication = (input: {
  readonly token: string;
  readonly repository: string;
  readonly branch: string;
  readonly head: string;
  readonly packed: NonNullable<Effect.Success<ReturnType<typeof planPublicationPush>>>;
}) =>
  Effect.gen(function* () {
    const github = yield* GitHub;
    const fail = (message: string) => new DriveReadError({ message });
    const remoteHead = () =>
      github.api.branchHead(input.token, input.repository, input.branch).pipe(
        Effect.catchIf(
          (error) => error.status === 409 && /^Git Repository is empty\.?$/i.test(error.message),
          () => Effect.succeed(null),
        ),
      );
    const old = yield* remoteHead();
    if (old === input.head) return;
    if (old !== null)
      return yield* fail("The new repository's branch changed. Nothing was overwritten.");
    const ref = `refs/heads/${input.branch}`;
    let unreadable = false;
    const pack = input.packed.pack.pipe(
      Stream.tapError(() =>
        Effect.sync(() => {
          unreadable = true;
        }),
      ),
    );
    const request = receivePackRequest({
      ref,
      old: null,
      next: input.head,
      pack,
      size: input.packed.size,
    });
    const sent = yield* github.api.receivePack(input.token, input.repository, request.body).pipe(
      Effect.flatMap((response) => {
        if (response.status !== 200)
          return Effect.fail(
            fail(
              `GitHub refused the initial push (${response.status}). Retry to continue publishing.`,
            ),
          );
        const answer = receivePackResult(response.body, ref);
        return answer._tag === "ok" ? Effect.void : Effect.fail(fail(answer.reason));
      }),
      Effect.result,
    );
    if (sent._tag === "Failure") {
      // GitHub may have accepted the pack before its response was lost.
      if (!unreadable && (yield* remoteHead()) === input.head) return;
      return yield* sent.failure;
    }
  });
