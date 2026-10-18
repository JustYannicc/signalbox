import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { makeMemoryDrives } from "../../drive/driveTesting.ts";
import { ThreadStore } from "../ThreadStore.ts";
import {
  freshDatabase,
  hello,
  launch,
  owner,
  snapshot,
  threadId,
  withObject,
} from "../runnerTesting.ts";

describe("prepared pull-request Runner upgrades", () => {
  it.effect.each([true, false])(
    "requires a capable Runner only when a PR seed is pending (%s)",
    (pending) =>
      Effect.gen(function* () {
        const drives = makeMemoryDrives();
        const drive = drives.apiFor("my/personal/user_1");
        yield* Effect.promise(() =>
          drive.setup({
            name: "Pull request",
            members: [
              { userId: owner.userId, email: "owner@example.test", name: "Owner", role: "manager" },
            ],
          }),
        );
        yield* Effect.promise(() =>
          drive.setRemote({ provider: "github", repository: "owner/repo", defaultBranch: "main" }),
        );
        if (pending) {
          expect(
            yield* Effect.promise(() =>
              drive.prepareThread(owner.userId, {
                operationId: "prepared-pr",
                threadId,
                repository: "owner/repo",
                number: 42,
                headSha: "a".repeat(40),
              }),
            ),
          ).toEqual({ _tag: "ok" });
        }
        yield* withObject(
          freshDatabase(),
          (engine, runner, context) =>
            Effect.gen(function* () {
              yield* launch(engine);
              const first = (yield* runner.reconcile).ensure!;
              const oldHello = {
                ...hello(first.generation, first.token),
                pullRequestSeeds: false,
                takenRunIds: [],
              };
              yield* runner.hello(oldHello);
              if (!pending) {
                expect((yield* runner.work).turn).not.toBeNull();
                expect((yield* runner.reconcile).ensure).toBeNull();
                return;
              }
              expect((yield* runner.work).turn).toBeNull();
              expect(yield* runner.previewDrive).toBeNull();
              const drain = yield* runner.reconcile;
              expect(drain.drain?.generation).toBe(first.generation);
              yield* runner.batch({
                generation: first.generation,
                sequence: 1,
                items: [{ kind: "machine.drained", id: drain.drain!.id, unsaved: [] }],
              });
              const next = (yield* runner.reconcile).ensure!;
              expect(next.generation).toBe(first.generation + 1);
              yield* runner.hello({ ...oldHello, generation: next.generation, token: next.token });
              expect((yield* runner.work).turn).toBeNull();
              expect((yield* runner.reconcile).ensure).toBeNull();
              const blockedHead = (yield* snapshot(engine)).head;
              yield* runner.reconcile;
              expect((yield* snapshot(engine)).head).toBe(blockedHead);
              expect((yield* Context.get(context, ThreadStore).machine).generation).toBe(
                next.generation,
              );
              yield* runner.hello({
                ...oldHello,
                generation: next.generation,
                token: next.token,
                pullRequestSeeds: true,
              });
              expect((yield* runner.work).turn).not.toBeNull();
              expect(yield* runner.previewDrive).not.toBeNull();
              expect((yield* runner.reconcile).ensure).toBeNull();
              expect(yield* runner.hello(oldHello)).toMatchObject({ reason: "stale_generation" });
            }),
          { drives: true, driveDirectory: drives.layer },
        );
      }),
  );
});
