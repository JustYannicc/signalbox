import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, it } from "vite-plus/test";

import { escapeOxlintFileGlob, readLintOwnership } from "./ownership.mjs";

const GIT_CONFIG = [
  "-c",
  "user.name=Lint ownership test",
  "-c",
  "user.email=lint-ownership@example.invalid",
  "-c",
  "commit.gpgsign=false",
];

function git(cwd, args) {
  return NodeChildProcess.execFileSync("git", [...GIT_CONFIG, ...args], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  }).trimEnd();
}

function writeFile(root, relativePath, contents = "fixture\n") {
  const file = NodePath.join(root, relativePath);
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, contents);
}

function commit(cwd, message) {
  git(cwd, ["add", "--all"]);
  git(cwd, ["commit", "-qm", message]);
}

describe("lint ownership", () => {
  it("uses current tracked paths from the upstream merge base", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "signalbox-lint-ownership-"));
    const upstreamPaths = Array.from(
      { length: 12 },
      (_, index) => `runtime/exempt-${String(index + 1).padStart(2, "0")}.ts`,
    );
    const deletedByUpstream = "runtime/deleted-on-upstream-after-base.ts";
    const deletedByCandidate = "runtime/deleted-on-candidate.ts";
    const renamedByCandidate = "runtime/local rename [old].ts";
    const candidateRename = "runtime/local renamed [new].ts";
    const futurePath = "runtime/added-after-merge-base.ts";
    const stagedPath = "runtime/new-staged.ts";
    const untrackedPath = "runtime/new-untracked.ts";
    const nonCodePath = "config/settings with spaces.toml";
    const metacharPath = "source/literal [x] `tick` $cash (group) !bang +plus @at *star ?mark.ts";

    try {
      git(root, ["init", "--initial-branch=main"]);
      for (const file of [
        ...upstreamPaths,
        deletedByUpstream,
        deletedByCandidate,
        renamedByCandidate,
        nonCodePath,
        metacharPath,
      ]) {
        writeFile(root, file);
      }
      commit(root, "upstream base");
      const base = git(root, ["rev-parse", "HEAD"]);

      git(root, ["checkout", "-b", "candidate"]);
      git(root, ["checkout", "-b", "upstream-next", base]);
      git(root, ["rm", "--", deletedByUpstream]);
      writeFile(root, futurePath, "created by later upstream\n");
      commit(root, "upstream advanced after merge base");
      git(root, ["update-ref", "refs/remotes/upstream/main", "HEAD"]);

      git(root, ["checkout", "candidate"]);
      git(root, ["mv", "--", renamedByCandidate, candidateRename]);
      git(root, ["rm", "--", deletedByCandidate]);
      writeFile(root, futurePath, "created on candidate after merge base\n");
      commit(root, "candidate changes");
      writeFile(root, stagedPath);
      git(root, ["add", "--", stagedPath]);
      writeFile(root, untrackedPath);

      const result = readLintOwnership({ cwd: root });
      const expected = [...upstreamPaths, deletedByUpstream, nonCodePath, metacharPath].sort();

      NodeAssert.equal(result.commit, base);
      NodeAssert.deepEqual(result.upstreamOwnedFiles, expected);
      NodeAssert.equal(
        result.upstreamOwnedFiles.filter((file) => file.startsWith("runtime/exempt-")).length,
        12,
      );
      NodeAssert.ok(!result.upstreamOwnedFiles.includes(deletedByCandidate));
      NodeAssert.ok(!result.upstreamOwnedFiles.includes(renamedByCandidate));
      NodeAssert.ok(!result.upstreamOwnedFiles.includes(candidateRename));
      NodeAssert.ok(!result.upstreamOwnedFiles.includes(futurePath));
      NodeAssert.ok(!result.upstreamOwnedFiles.includes(stagedPath));
      NodeAssert.ok(!result.upstreamOwnedFiles.includes(untrackedPath));
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves raw names and repo-relative paths from a subdirectory", () => {
    const root = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "signalbox-lint-ownership-paths-"),
    );
    const upstreamPaths = [
      "src/plain.ts",
      'src/quoted "name".ts',
      "src/back\\slash.ts",
      "src/tab\tname.ts",
      "src/newline\nname.ts",
      "src/ümlaut.ts",
      "src/漢字.ts",
      "outside.ts",
    ];
    const stagedPath = "src/staged-after-base.ts";
    const untrackedPath = "outside-untracked.ts";

    try {
      git(root, ["init", "--initial-branch=main"]);
      for (const file of upstreamPaths) writeFile(root, file);
      commit(root, "upstream base");
      const base = git(root, ["rev-parse", "HEAD"]);

      git(root, ["checkout", "-b", "candidate"]);
      writeFile(root, "outside/candidate-only.ts");
      commit(root, "candidate change");
      git(root, ["update-ref", "refs/remotes/upstream/main", base]);

      writeFile(root, stagedPath);
      git(root, ["add", "--", stagedPath]);
      writeFile(root, untrackedPath);

      const rootResult = readLintOwnership({ cwd: root });
      NodeAssert.equal(rootResult.commit, base);
      NodeAssert.deepEqual(rootResult.upstreamOwnedFiles, [...upstreamPaths].sort());

      const result = readLintOwnership({ cwd: NodePath.join(root, "src") });

      NodeAssert.equal(result.commit, base);
      NodeAssert.deepEqual(result.upstreamOwnedFiles, [...upstreamPaths].sort());
      NodeAssert.equal(escapeOxlintFileGlob("src/literal [x].ts"), "src/literal \\[x\\].ts");
      NodeAssert.ok(!result.upstreamOwnedFiles.includes("outside/candidate-only.ts"));
      NodeAssert.ok(!result.upstreamOwnedFiles.includes(stagedPath));
      NodeAssert.ok(!result.upstreamOwnedFiles.includes(untrackedPath));
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports missing repositories and upstream refs instead of returning no exemptions", () => {
    const nonRepository = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "signalbox-not-git-"));
    const repository = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "signalbox-missing-upstream-"),
    );

    try {
      NodeAssert.throws(
        () => readLintOwnership({ cwd: nonRepository }),
        /cwd .* is not a Git repository/,
      );

      git(repository, ["init", "--initial-branch=main"]);
      writeFile(repository, "tracked.ts");
      commit(repository, "initial commit");

      NodeAssert.throws(
        () => readLintOwnership({ cwd: repository, upstreamRef: "missing-upstream" }),
        /head "HEAD" and upstream ref "missing-upstream": ensure both refs exist and share history; fetch the upstream ref if needed/,
      );
    } finally {
      NodeFS.rmSync(nonRepository, { recursive: true, force: true });
      NodeFS.rmSync(repository, { recursive: true, force: true });
    }
  });

  it("escapes Oxlint glob metacharacters while preserving the raw path spelling", () => {
    const path = "src/literal [x] `tick` $cash (group) !bang +plus @at *star ?mark.ts";

    NodeAssert.equal(
      escapeOxlintFileGlob(path),
      "src/literal \\[x\\] `tick` $cash \\(group\\) \\!bang \\+plus \\@at \\*star \\?mark.ts",
    );
    NodeAssert.equal(
      escapeOxlintFileGlob("config/settings with spaces.toml"),
      "config/settings with spaces.toml",
    );
  });
});
