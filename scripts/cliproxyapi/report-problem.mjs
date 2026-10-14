import * as NodeChildProcess from "node:child_process";

const LABEL = "cli-proxyapi-update-needs-hand";
const REPOSITORY = process.env.GITHUB_REPOSITORY ?? "JustYannicc/signalbox";
process.env.GH_REPO = REPOSITORY;

function run(command, args) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const output = NodeChildProcess.execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trimEnd();
  if (output) console.log(output);
  return output;
}

function runLink() {
  const { GITHUB_SERVER_URL, GITHUB_RUN_ID } = process.env;
  return GITHUB_SERVER_URL && GITHUB_RUN_ID
    ? `${GITHUB_SERVER_URL}/${REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
    : "a local run";
}

function openIssue() {
  const number = run("gh", [
    "issue",
    "list",
    "--label",
    LABEL,
    "--state",
    "open",
    "--json",
    "number",
    "--jq",
    ".[0].number // empty",
  ]);
  return number || undefined;
}

function report() {
  const summary = process.env.PROBLEM_SUMMARY ?? "The release sync could not complete.";
  const details = process.env.PROBLEM_DETAILS ?? "See the action run for the failure details.";
  const body = [
    `The CLIProxyAPI release sync needs a hand: ${summary}`,
    "",
    details,
    "",
    "Fix the release or check problem and rerun the sync. A successful run closes this issue.",
    "",
    `Last checked by ${runLink()}.`,
  ].join("\n");

  run("gh", [
    "label",
    "create",
    LABEL,
    "--force",
    "--color",
    "B60205",
    "--description",
    "The scheduled CLIProxyAPI release update needs a hand",
  ]);
  const existing = openIssue();
  if (existing) {
    run("gh", ["issue", "edit", existing, "--body", body]);
  } else {
    run("gh", [
      "issue",
      "create",
      "--title",
      "CLIProxyAPI update needs a hand",
      "--label",
      LABEL,
      "--body",
      body,
    ]);
  }
}

function close() {
  const existing = openIssue();
  if (existing) {
    const reason = process.env.CLOSE_REASON ?? "The release sync is healthy again";
    run("gh", ["issue", "close", existing, "--comment", `${reason} (${runLink()}).`]);
  }
}

const action = process.argv[2];
if (action === "report") report();
else if (action === "close") close();
else throw new Error("usage: report-problem.mjs report|close");
