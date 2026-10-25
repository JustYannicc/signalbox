// @effect-diagnostics nodeBuiltinImport:off - the test makes a real repository on a temp dir.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { git, scopedTest } from "./driveTesting.ts";
import { storePacks } from "./RunnerDriveMirror.ts";
import { makeRunnerGit } from "./RunnerGit.ts";

/** An empty commit on `repo`'s current branch. */
const commit = (repo: string, message: string) =>
  git(
    repo,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    message,
  );

describe("storePacks", () => {
  it.effect(
    "marks a commit shallow when git reports its missing parent with a successful exit",
    () =>
      scopedTest((root) =>
        Effect.gen(function* () {
          const source = NodePath.join(root, "source");
          const repo = NodePath.join(root, "repo");
          NodeFS.mkdirSync(source);
          NodeFS.mkdirSync(repo);
          git(source, "init", "-q");
          git(repo, "init", "-q");
          commit(source, "base");
          const parent = git(source, "rev-parse", "HEAD");
          commit(source, "tip");
          const tip = git(source, "rev-parse", "HEAD");
          const object = NodePath.join("objects", tip.slice(0, 2), tip.slice(2));
          NodeFS.mkdirSync(NodePath.dirname(NodePath.join(repo, ".git", object)), {
            recursive: true,
          });
          NodeFS.copyFileSync(
            NodePath.join(source, ".git", object),
            NodePath.join(repo, ".git", object),
          );
          const real = yield* makeRunnerGit(repo);
          const reportedMissing = {
            ...real,
            exec: (args: ReadonlyArray<string>) =>
              args[0] === "rev-list" && args[3] === parent
                ? Effect.succeed({ code: 0, stdout: `?${parent}\n`, stderr: "" })
                : real.exec(args),
          };

          yield* storePacks({
            gitDir: NodePath.join(repo, ".git"),
            git: reportedMissing,
            packs: [],
            shallow: [tip],
            promisor: false,
            download: () => Effect.void,
          });

          expect(NodeFS.readFileSync(NodePath.join(repo, ".git", "shallow"), "utf8")).toBe(
            `${tip}\n`,
          );
          expect(git(repo, "rev-list", "--count", tip)).toBe("1");
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );

  it.effect("checks a shallow commit's parents only the first time the drive answers it", () =>
    scopedTest((root) =>
      Effect.gen(function* () {
        const repo = NodePath.join(root, "repo");
        NodeFS.mkdirSync(repo);
        git(repo, "init", "-q");
        commit(repo, "base");
        commit(repo, "tip");
        const tip = git(repo, "rev-parse", "HEAD");
        const real = yield* makeRunnerGit(repo);
        const looked: Array<string> = [];
        const counted = {
          ...real,
          run: (args: ReadonlyArray<string>) => {
            if (args[0] === "cat-file") looked.push(args[2] ?? "");
            return real.run(args);
          },
        };
        const store = () =>
          storePacks({
            gitDir: NodePath.join(repo, ".git"),
            git: counted,
            packs: [],
            shallow: [tip],
            promisor: false,
            download: () => Effect.void,
          });

        yield* store();
        // Every turn's drive client answers the drive's whole shallow list again.
        yield* store();

        expect(looked).toEqual([tip]);
        // Its parent is here, so git isn't told to stop at it.
        expect(NodeFS.existsSync(NodePath.join(repo, ".git", "shallow"))).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});
