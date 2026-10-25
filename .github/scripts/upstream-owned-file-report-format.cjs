const COMMENT_MARKER = "<!-- signalbox-upstream-owned-file-report -->";
const MAX_COMMENT_BYTES = 60_000;

function replaceControlCharacters(text) {
  return Array.from(text, (character) => {
    const code = character.codePointAt(0);
    const isControl =
      code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
    return isControl ? "�" : character;
  }).join("");
}

function markdownCodeSpan(path) {
  const cleaned = replaceControlCharacters(path);
  const content =
    cleaned.startsWith(" ") ||
    cleaned.endsWith(" ") ||
    cleaned.startsWith("`") ||
    cleaned.endsWith("`")
      ? ` ${cleaned} `
      : cleaned;
  const longestRun = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  const delimiter = "`".repeat(longestRun + 1);
  return `${delimiter}${content}${delimiter}`;
}

function formatReport(report) {
  const fileLines = report.files.map((file) => {
    const change = file.binary
      ? "binary change (line count unavailable)"
      : `+${file.additions} / −${file.deletions}`;
    return `- ${markdownCodeSpan(file.path)}: ${change}`;
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

function formatComment(report, { artifactUrl, maxBytes = MAX_COMMENT_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("A positive comment byte limit is required.");
  }

  const fileLines = report.files.map((file) => {
    const change = file.binary
      ? "binary change (line count unavailable)"
      : `+${file.additions} / −${file.deletions}`;
    return `- ${markdownCodeSpan(file.path)}: ${change}`;
  });
  const artifactLine = artifactUrl
    ? `Full report artifact: ${artifactUrl}`
    : "Full report artifact unavailable for this run.";
  const header = [
    COMMENT_MARKER,
    "## Upstream-owned file changes",
    "",
    `This PR changes **${report.changedLines} lines** (+${report.additions} / −${report.deletions}) across **${report.files.length} upstream-owned files**.`,
    "",
    "Ownership uses paths present at `merge-base(PR head, upstream/main)`. Line counts compare the PR merge base with its head.",
    "",
    artifactLine,
    "",
  ];
  const footer = ["", "Informational only. There is no line-change budget."];

  const build = (includedCount) => {
    const omittedCount = fileLines.length - includedCount;
    const omission =
      omittedCount > 0
        ? [
            `${omittedCount} changed file${omittedCount === 1 ? "" : "s"} omitted from this comment to stay within GitHub's comment limit.`,
          ]
        : [];
    const listedFiles =
      fileLines.length === 0
        ? ["- No upstream-owned files changed."]
        : fileLines.slice(0, includedCount);
    return [...header, ...listedFiles, ...omission, ...footer].join("\n");
  };

  let low = 0;
  let high = fileLines.length;
  let best = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const body = build(middle);
    if (Buffer.byteLength(body, "utf8") <= maxBytes) {
      best = body;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best !== null) return best;
  throw new Error("The report summary exceeds the GitHub comment limit.");
}

function formatUnavailableComment({ artifactUrl } = {}) {
  return [
    COMMENT_MARKER,
    "## Upstream-owned file changes",
    "",
    "No count is available for this update. The report could not calculate the required Git comparison, so it does not assert that no upstream-owned files changed.",
    "",
    artifactUrl
      ? `Full report artifact: ${artifactUrl}`
      : "Full report artifact unavailable for this run.",
    "",
    "Informational only. There is no line-change budget.",
  ].join("\n");
}

function unavailableReport() {
  return [
    COMMENT_MARKER,
    "## Upstream-owned file changes",
    "",
    "No count is available for this update. The report could not calculate the required Git comparison, so it does not assert that no upstream-owned files changed.",
  ].join("\n");
}

module.exports = {
  COMMENT_MARKER,
  markdownCodeSpan,
  formatReport,
  formatComment,
  formatUnavailableComment,
  unavailableReport,
};
