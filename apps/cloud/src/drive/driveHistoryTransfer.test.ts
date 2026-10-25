import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";

import { DriveDirectory } from "./DriveDirectory.ts";
import { makeMemoryDrives, makeRepo } from "./driveTesting.ts";
import { uploadPack } from "./DriveUploads.ts";

const SOURCE = "folder/org_test/source";
const TARGET = "folder/org_test/target";
const owner = { userId: "owner", email: "owner@example.com", name: "Owner" };
const reader = { userId: "reader", email: "reader@example.com", name: "Reader" };
const decodeTag = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ _tag: Schema.String })),
);

const repos: Array<ReturnType<typeof makeRepo>> = [];
const repo = () => {
  const git = makeRepo();
  repos.push(git);
  return git;
};

afterEach(() => {
  for (const git of repos.splice(0)) git.cleanup();
});

/** Holds the stream after its captured pack list and before it yields entries. */
const holdAfterPackRows = (data: ReadableStream<Uint8Array>, expectedPacks: number) => {
  const reader = data.getReader();
  let resolveReached!: () => void;
  const reached = new Promise<void>((resolve) => (resolveReached = resolve));
  let resolveRelease!: () => void;
  const released = new Promise<void>((resolve) => (resolveRelease = resolve));
  const decoder = new TextDecoder();
  let pending = "";
  let packCount = 0;
  let entryCount = 0;
  let held = false;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read();
      if (next.done) {
        controller.close();
        return;
      }
      pending += decoder.decode(next.value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines) {
        if (line === "") continue;
        const record = decodeTag(line);
        if (record._tag === "pack") packCount += 1;
        if (record._tag === "entry") entryCount += 1;
      }
      if (!held && packCount === expectedPacks) {
        held = true;
        resolveReached();
        await released;
      }
      controller.enqueue(next.value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });

  return {
    stream,
    reached,
    release: resolveRelease,
    counts: () => ({ packCount, entryCount }),
  };
};

describe("history transfer snapshot", () => {
  it.effect(
    "keeps packs private at capture out of an export even if promoted before entries",
    () => {
      const drives = makeMemoryDrives();
      return Effect.gen(function* () {
        const directory = yield* DriveDirectory;
        const source = directory.forDrive(SOURCE);
        const target = directory.forDrive(TARGET);
        yield* source.setup({ name: "Original", members: [{ ...owner, role: "owner" }] });
        yield* target.setup({ name: "Alternative", members: [{ ...reader, role: "owner" }] });

        const git = repo();
        let previous: string | null = null;
        for (let index = 0; index < 9; index += 1) {
          git.write("public.txt", `public ${index}\n`);
          const commit = git.commit(`public ${index}`);
          yield* uploadPack({
            driveId: SOURCE,
            threadId: `public-${index}`,
            ...git.pack([commit], previous === null ? [] : [previous]),
          });
          previous = commit;
        }

        git.write("machine.txt", "private machine state\n");
        const privateHead = git.commit("private machine state");
        const privatePack = git.pack([privateHead], [previous!]);
        yield* uploadPack({
          driveId: SOURCE,
          threadId: "machine",
          ...privatePack,
          private: true,
        });
        expect(
          yield* source.replaceMain(owner.userId, { expectedMain: null, newMain: previous! }),
        ).toMatchObject({ _tag: "ok" });

        const publicPackCount = (yield* source.refs(null)).packs.length;
        expect(publicPackCount).toBe(9);
        const captured = yield* source.history(owner.userId);
        if (captured._tag !== "ok") throw new Error("History unavailable.");
        const gate = holdAfterPackRows(captured.history.data, publicPackCount);
        const started = yield* Effect.forkChild(
          target.startFromHistory(reader.userId, { ...captured.history, data: gate.stream }),
        );

        yield* Effect.promise(() => gate.reached);
        const promoted = yield* Effect.gen(function* () {
          expect(gate.counts()).toEqual({ packCount: publicPackCount, entryCount: 0 });
          return yield* uploadPack({
            driveId: SOURCE,
            threadId: "promotion",
            ...privatePack,
          });
        }).pipe(Effect.ensuring(Effect.sync(gate.release)));
        expect(promoted._tag).toBe("ok");

        expect(yield* Fiber.join(started)).toEqual({
          _tag: "ok",
          sourceDriveId: SOURCE,
          head: previous,
        });
        const targetPacks = (yield* target.refs(null)).packs.map(({ name }) => name);
        expect(targetPacks).toHaveLength(publicPackCount);
        expect(targetPacks).not.toContain(privatePack.name);
        expect(yield* target.packStorage(privatePack.name)).toBeNull();
        expect(yield* target.missing([privateHead], null)).toEqual([privateHead]);
        expect(yield* target.ref("main")).toBe(previous);
      }).pipe(Effect.provide(drives.layer));
    },
  );
});
