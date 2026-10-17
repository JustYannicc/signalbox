// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUID:off - real Git runs in temp directories with generated throwaway secrets.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  git,
  machine,
  makeFakeDrive,
  read,
  scopedTest,
  write,
} from "../../../../server/src/signalbox/runner/driveTesting.ts";
import { secretFillHook } from "../../../../server/src/signalbox/runner/RunnerSecretFill.ts";
import { serveWithFakeNetwork as serveEgress } from "./egressTestKit.ts";
import { makeSecretMask } from "../../../../server/src/signalbox/runner/secretMask.ts";

const value = `sk-throwaway-${crypto.randomUUID()}`;

describe("Runner secret persistence boundary", () => {
  it.effect(
    "keeps a cloud turn's tool input, files, autosave, commits and every Git blob free of resolved secrets",
    () =>
      scopedTest((root) =>
        Effect.gen(function* () {
          const drive = makeFakeDrive(root);
          const mask = makeSecretMask();
          mask.add([{ name: "KEY", value }]);
          const { runner, cwd } = yield* machine(drive, root, "vm-1", "t1", { secretMask: mask });
          yield* runner.prepare("throwaway-remote-token");
          const input = { file_path: "config.txt", content: "KEY={{secret:KEY}}\n" };
          const [hook] = secretFillHook(() => ({
            values: new Map([["KEY", value]]),
            guarded: true,
          })).hooks;
          const result = yield* Effect.promise(() =>
            hook!(
              {
                hook_event_name: "PreToolUse",
                session_id: "s",
                transcript_path: "transcript",
                cwd,
                tool_name: "Write",
                tool_input: input,
                tool_use_id: "write-secret-reference",
              },
              "write-secret-reference",
              { signal: new AbortController().signal },
            ),
          );
          const updated =
            "hookSpecificOutput" in result &&
            result.hookSpecificOutput?.hookEventName === "PreToolUse"
              ? result.hookSpecificOutput.updatedInput
              : undefined;
          write(
            cwd,
            String(updated?.file_path ?? input.file_path),
            String(updated?.content ?? input.content),
          );
          let sentValue = false;
          const response = yield* Effect.promise(() =>
            serveEgress(
              new Request("https://approved.example/use", {
                method: "POST",
                headers: { "content-type": "text/plain" },
                body: read(cwd, "config.txt"),
              }),
              {
                ownHosts: new Set(),
                thread: {
                  secrets: async () => ({
                    registered: 1,
                    revision: 1,
                    current: [{ name: "KEY", value }],
                    values: [{ name: "KEY", value }],
                  }),
                  authorize: async () => ({ _tag: "allowed" }),
                },
                send: async (outgoing) => {
                  const body = await outgoing.text();
                  sentValue = body.includes(value);
                  return new Response(body, { headers: { "content-type": "text/plain" } });
                },
              },
            ),
          );
          expect(sentValue).toBe(true);
          write(cwd, "response.txt", yield* Effect.promise(() => response.text()));
          yield* runner.autosave;
          yield* runner.flush;
          const autosave = drive.refs("t1").wip!;
          yield* runner.finishTurn();
          const head = git(cwd, "rev-parse", "HEAD");
          const objects = git(
            cwd,
            "cat-file",
            "--batch-all-objects",
            "--batch-check=%(objectname) %(objecttype)",
          );
          const blobs = objects.split("\n").filter((line) => line.endsWith(" blob"));
          expect(blobs.length).toBeGreaterThan(0);
          const persisted = [
            JSON.stringify(result),
            read(cwd, "config.txt"),
            read(cwd, "response.txt"),
            git(cwd, "show", "--format=fuller", head),
            git(drive.store, "show", `${autosave}:config.txt`),
            ...blobs.map((line) => git(cwd, "cat-file", "blob", line.split(" ")[0]!)),
          ];
          expect(
            persisted.every((text) => !text.includes(value) && !text.includes(btoa(value))),
          ).toBe(true);
          expect(read(cwd, "config.txt")).toBe(input.content);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      ),
  );
});
