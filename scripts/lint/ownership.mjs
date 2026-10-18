import * as NodeChildProcess from "node:child_process";
import { readUpstreamSource } from "../boundaries/upstream.mjs";

const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const OXLINT_GLOB_META = new Set("\\*?[]{}()!+@");

export function escapeOxlintFileGlob(filePath) {
  if (typeof filePath !== "string") {
    throw new TypeError("escapeOxlintFileGlob requires a repo-relative path string.");
  }

  return [...filePath]
    .map((character) => (OXLINT_GLOB_META.has(character) ? `\\${character}` : character))
    .join("");
}

export function readLintOwnership({ cwd, head = "HEAD", upstreamRef = "upstream/main" } = {}) {
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new TypeError("readLintOwnership requires an explicit Git repository cwd.");
  }

  const git = (args) => {
    try {
      const output = NodeChildProcess.execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: GIT_MAX_BUFFER,
      });
      return output.endsWith("\n") ? output.slice(0, -1) : output;
    } catch (cause) {
      const detail = String(cause.stderr ?? "").trim();
      if (/not a git repository/i.test(detail)) {
        throw new Error(
          `Cannot read lint ownership: cwd "${cwd}" is not a Git repository. Pass the repository root as cwd.`,
          {
            cause,
          },
        );
      }
      if (cause.code === "ENOENT" || cause.code === "ENOTDIR") {
        throw new Error(
          `Cannot read lint ownership: cannot run Git in "${cwd}". Verify cwd exists and Git is installed.`,
          { cause },
        );
      }
      if (args[0] === "merge-base") {
        throw new Error(
          `Cannot read lint ownership for head "${head}" and upstream ref "${upstreamRef}": ensure both refs exist and share history; fetch the upstream ref if needed${detail ? ` (${detail})` : ""}.`,
          { cause },
        );
      }
      throw new Error(
        `Cannot read lint ownership: Git ${args[0]} failed in "${cwd}"${detail ? ` (${detail})` : ""}.`,
        { cause },
      );
    }
  };

  const { commit, files } = readUpstreamSource(git, upstreamRef, head);
  const trackedFiles = git(["ls-files", "--cached", "-z"]).split("\0").filter(Boolean);
  const upstreamOwnedFiles = [...new Set(trackedFiles.filter((file) => files.has(file)))].sort();

  return { commit, upstreamOwnedFiles };
}
