// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUID:off - real Git runs in temp directories with generated canary secrets.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunId } from "@t3tools/contracts";
import {
  syntheticSecretsEchoFixture,
  syntheticSecretsRegistrationFixture,
} from "@signalbox/runner-protocol/testing/SecretsFixture";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { git, machine, makeFakeDrive, read, scopedTest, write } from "./driveTesting.ts";
import { secretFillHook } from "./RunnerSecretFill.ts";
import { makeSecretMask } from "./secretMask.ts";

const registration = syntheticSecretsRegistrationFixture(RunId.make("persist-canary"));
const echo = syntheticSecretsEchoFixture(registration);

describe("Runner secret persistence boundary", () => {
  it.effect(
    "keeps tool input, files, autosave, commits and every Git blob on the placeholder contract",
    () =>
      scopedTest((root) =>
        Effect.gen(function* () {
          const drive = makeFakeDrive(root);
          const mask = makeSecretMask();
          mask.add(registration.secrets);
          const { runner, cwd } = yield* machine(drive, root, "vm-1", "t1", { secretMask: mask });
          yield* runner.prepare("throwaway-remote-token");
          const input = { file_path: "config.txt", content: echo.placeholder };
          const [hook] = secretFillHook(() => ({
            values: new Map(registration.current.map(({ name, value }) => [name, value])),
            guarded: true,
          })).hooks;
          const event = {
            hook_event_name: "PreToolUse" as const,
            session_id: "s",
            transcript_path: "transcript",
            cwd,
            tool_name: "Write",
            tool_input: input,
            tool_use_id: "write-secret-reference",
          };
          const result = yield* Effect.promise(() =>
            hook!(event, "write-secret-reference", { signal: new AbortController().signal }),
          );
          const updated =
            "hookSpecificOutput" in result &&
            result.hookSpecificOutput?.hookEventName === "PreToolUse"
              ? result.hookSpecificOutput.updatedInput
              : undefined;
          expect(updated).toBeUndefined();
          expect(JSON.stringify({ event, result })).not.toContain(echo.resolved);
          write(
            cwd,
            String(updated?.file_path ?? input.file_path),
            String(updated?.content ?? input.content),
          );

          // This is the response body Cloud's real egress test proves it returns after an echo.
          expect(mask.text(echo.resolved)).toBe(echo.placeholder);
          write(cwd, "response.txt", echo.placeholder);
          yield* runner.autosave;
          yield* runner.flush;
          const autosave = drive.refs("t1").wip!;
          yield* runner.finishTurn();
          const head = git(cwd, "rev-parse", "HEAD");
          const blobs = [cwd, drive.store].flatMap((repository) =>
            git(
              repository,
              "cat-file",
              "--batch-all-objects",
              "--batch-check=%(objectname) %(objecttype)",
            )
              .split("\n")
              .filter((line) => line.endsWith(" blob"))
              .map((line) => ({ repository, object: line.split(" ")[0]! })),
          );
          expect(blobs.length).toBeGreaterThan(0);
          const persisted = [
            JSON.stringify({ event, result }),
            read(cwd, "config.txt"),
            read(cwd, "response.txt"),
            git(cwd, "show", "--format=fuller", head),
            git(drive.store, "show", `${autosave}:config.txt`),
            git(drive.store, "show", `${autosave}:response.txt`),
            ...blobs.map(({ repository, object }) => git(repository, "cat-file", "blob", object)),
          ];
          for (const { value } of registration.secrets) {
            expect(
              persisted.every((text) => !text.includes(value) && !text.includes(btoa(value))),
            ).toBe(true);
          }
          expect(read(cwd, "config.txt")).toBe(echo.placeholder);
          expect(read(cwd, "response.txt")).toBe(echo.placeholder);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      ),
  );
});
