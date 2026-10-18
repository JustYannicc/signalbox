const { execFileSync } = require("node:child_process");

const COMMENT_MARKER = "<!-- signalbox-upstream-owned-file-report -->";
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

function git(cwd, args, failureMessage) {
  try {
    return execFileSync("git", args, {
      cwd,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error(failureMessage);
  }
}

function resolveCommit(cwd, ref, label) {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new Error(`Unable to resolve the ${label} commit.`);
  }

  const sha = git(
    cwd,
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
    `Unable to resolve the ${label} commit.`,
  )
    .toString("utf8")
    .trim();

  if (!/^[0-9a-f]{40,64}$/i.test(sha)) {
    throw new Error(`Unable to resolve the ${label} commit.`);
  }
  return sha;
}

function findMergeBase(cwd, left, right, label) {
  const mergeBase = git(
    cwd,
    ["merge-base", left, right],
    `Unable to find a merge base for ${label}.`,
  )
    .toString("utf8")
    .trim();

  if (!/^[0-9a-f]{40,64}$/i.test(mergeBase)) {
    throw new Error(`Unable to find a merge base for ${label}.`);
  }
  return mergeBase;
}

function parseNumstat(output) {
  const entries = [];
  for (const record of output.toString("utf8").split("\0")) {
    if (record.length === 0) continue;

    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0 || secondTab === record.length - 1) {
      throw new Error("Unable to parse Git's changed-line report.");
    }

    const additionsRaw = record.slice(0, firstTab);
    const deletionsRaw = record.slice(firstTab + 1, secondTab);
    const path = record.slice(secondTab + 1);
    const binary = additionsRaw === "-" || deletionsRaw === "-";

    if (binary) {
      if (additionsRaw !== "-" || deletionsRaw !== "-") {
        throw new Error("Unable to parse Git's changed-line report.");
      }
      entries.push({ path, binary, additions: 0, deletions: 0 });
      continue;
    }

    if (!/^\d+$/.test(additionsRaw) || !/^\d+$/.test(deletionsRaw)) {
      throw new Error("Unable to parse Git's changed-line report.");
    }

    const additions = Number(additionsRaw);
    const deletions = Number(deletionsRaw);
    if (!Number.isSafeInteger(additions) || !Number.isSafeInteger(deletions)) {
      throw new Error("Git reported an unsafe changed-line count.");
    }
    entries.push({ path, binary, additions, deletions });
  }
  return entries;
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function calculateReport({ cwd = process.cwd(), base, head = "HEAD", upstream = "upstream/main" }) {
  const baseSha = resolveCommit(cwd, base, "pull request base");
  const headSha = resolveCommit(cwd, head, "pull request head");
  const upstreamSha = resolveCommit(cwd, upstream, "upstream main");

  const ownershipBase = findMergeBase(cwd, headSha, upstreamSha, "PR head and upstream main");
  const pullRequestBase = findMergeBase(cwd, baseSha, headSha, "PR base and head");

  // A path belongs to upstream when it existed at the shared history point.
  const ownershipPaths = new Set(
    git(
      cwd,
      ["ls-tree", "-r", "-z", "--name-only", ownershipBase],
      "Unable to read the upstream ownership baseline.",
    )
      .toString("utf8")
      .split("\0")
      .filter(Boolean),
  );

  const changes = parseNumstat(
    git(
      cwd,
      [
        "diff",
        "--numstat",
        "-z",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        pullRequestBase,
        headSha,
        "--",
      ],
      "Unable to compare the pull request base and head.",
    ),
  );
  const files = changes
    .filter((change) => ownershipPaths.has(change.path))
    .sort((left, right) => comparePaths(left.path, right.path));
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);

  return {
    files,
    additions,
    deletions,
    changedLines: additions + deletions,
  };
}

function escapeFilePath(path) {
  const cleaned = path.replace(CONTROL_CHARACTERS, "�");
  const escaped = cleaned.replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
  return `<code>${escaped}</code>`;
}

function formatReport(report) {
  const fileLines = report.files.map((file) => {
    const change = file.binary
      ? "binary change (line count unavailable)"
      : `+${file.additions} / −${file.deletions}`;
    return `- ${escapeFilePath(file.path)}: ${change}`;
  });

  return [
    COMMENT_MARKER,
    "## Upstream-owned file changes",
    "",
    `This PR changes **${report.changedLines} lines** (+${report.additions} / −${report.deletions}) across **${report.files.length} upstream-owned files**.`,
    "",
    "Ownership uses paths present at `merge-base(PR head, upstream/main)`. Line counts compare the PR merge base with its head.",
    "",
    ...(fileLines.length > 0 ? fileLines : ["- No upstream-owned files changed."]),
    "",
    "Informational only. There is no line-change budget.",
  ].join("\n");
}

function generateReport(options) {
  return formatReport(calculateReport(options));
}

function unavailableReport() {
  return [
    COMMENT_MARKER,
    "## Upstream-owned file changes",
    "",
    "No count is available for this update. The report could not calculate the required Git comparison, so it does not assert that no upstream-owned files changed.",
  ].join("\n");
}

async function publishComment({ github, owner, repo, pullNumber, body }) {
  if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) {
    throw new Error("A valid pull request number is required.");
  }
  if (typeof body !== "string" || !body.includes(COMMENT_MARKER)) {
    throw new Error("The report comment is missing its marker.");
  }

  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: pullNumber,
    per_page: 100,
  });
  const existing = [...comments]
    .reverse()
    .find(
      (comment) =>
        comment.user?.login === "github-actions[bot]" && comment.body?.includes(COMMENT_MARKER),
    );

  if (existing) {
    return github.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
  }

  return github.rest.issues.createComment({
    owner,
    repo,
    issue_number: pullNumber,
    body,
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const options = { head: "HEAD", upstream: "upstream/main" };
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!value || !["--base", "--head", "--upstream"].includes(option)) {
      process.stderr.write(
        "Usage: node upstream-owned-file-report.cjs --base <ref> [--head <ref>] [--upstream <ref>]\n",
      );
      process.exitCode = 2;
      break;
    }
    options[option.slice(2)] = value;
  }

  if (process.exitCode !== 2) {
    try {
      process.stdout.write(`${generateReport({ cwd: process.cwd(), ...options })}\n`);
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : "Unable to build report."}\n`,
      );
      process.exitCode = 1;
    }
  }
}

module.exports = {
  COMMENT_MARKER,
  calculateReport,
  escapeFilePath,
  formatReport,
  generateReport,
  publishComment,
  unavailableReport,
};
