"use strict";

const { execFileSync } = require("node:child_process");

function findVendoredGitlinks(treeish = "HEAD", cwd = process.cwd()) {
  // Inspect the commit tree directly; CI intentionally omits .repos from checkout.
  const output = execFileSync(
    "git",
    [
      "ls-tree",
      "-r",
      "-z",
      "--full-tree",
      "--format=%(objectmode) %(path)",
      treeish,
      "--",
      ".repos",
    ],
    {
      cwd,
      encoding: "buffer",
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .flatMap((entry) => {
      const separator = entry.indexOf(" ");
      if (separator === -1 || entry.slice(0, separator) !== "160000") return [];

      const filePath = entry.slice(separator + 1);
      return filePath === ".repos" || filePath.startsWith(".repos/") ? [filePath] : [];
    });
}

function main() {
  let gitlinks;
  try {
    gitlinks = findVendoredGitlinks();
  } catch (error) {
    console.error(`Could not inspect Git tree HEAD: ${error.message}`);
    return 2;
  }

  if (gitlinks.length === 0) return 0;

  console.error(
    `Found Gitlink entries under .repos in HEAD:\n${gitlinks.map((filePath) => `  ${filePath}`).join("\n")}`,
  );
  return 1;
}

if (require.main === module) process.exitCode = main();

module.exports = { findVendoredGitlinks };
