const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const report = require("./upstream-owned-file-report.cjs");

function createFixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "signalbox-upstream-report-"));
  const git = (args, options = {}) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      input: options.input,
    }).trim();
  const write = (relativePath, contents) => {
    const absolutePath = path.join(cwd, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, contents);
  };
  const commit = (message) => {
    git(["add", "-A"]);
    git(["commit", "--quiet", "-m", message]);
    return git(["rev-parse", "HEAD"]);
  };

  fs.mkdirSync(cwd, { recursive: true });
  git(["init", "--quiet"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);

  write("src/shared.ts", "old\nstable\n");
  write("src/deleted.txt", "one\ntwo\n");
  write("src/binary.bin", Buffer.from([0, 1, 2]));
  write("src/weird\n<name>.txt", "first\n");
  const common = commit("common upstream history");

  write("src/added-to-upstream-later.ts", "upstream version\n");
  const upstream = commit("add upstream-only path");
  git(["update-ref", "refs/remotes/upstream/main", upstream]);

  git(["checkout", "--quiet", common]);
  write("src/shared.ts", "new\nstable\nextra\n");
  fs.rmSync(path.join(cwd, "src/deleted.txt"));
  write("src/binary.bin", Buffer.from([0, 1, 2, 3]));
  write("src/weird\n<name>.txt", "second\n");
  write("src/fork-only.ts", "fork-only\n");
  write("src/added-to-upstream-later.ts", "fork version\n");
  const head = commit("PR changes");

  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return { cwd, common, head, git };
}

test("counts only changed paths present at the upstream merge base", (t) => {
  const fixture = createFixture(t);
  const result = report.calculateReport({
    cwd: fixture.cwd,
    base: fixture.common,
    head: fixture.head,
    upstream: "upstream/main",
  });

  assert.deepEqual(
    result.files.map(({ path: filePath }) => filePath),
    ["src/binary.bin", "src/deleted.txt", "src/shared.ts", "src/weird\n<name>.txt"],
  );
  assert.equal(result.additions, 3);
  assert.equal(result.deletions, 4);
  assert.equal(result.changedLines, 7);
  assert.equal(result.files[0].binary, true);
  assert.equal(result.files[0].additions, 0);
  assert.equal(result.files[1].deletions, 2);
  assert.equal(result.files[2].additions, 2);
  assert.equal(result.files[2].deletions, 1);

  const body = report.formatReport(result);
  assert.match(body, /7 lines/);
  assert.match(body, /4 upstream-owned files/);
  assert.match(body, /binary change \(line count unavailable\)/);
  assert.match(body, /src\/weird�&lt;name&gt;\.txt/);
  assert.doesNotMatch(body, /src\/fork-only\.ts/);
  assert.doesNotMatch(body, /added-to-upstream-later\.ts/);
  assert.equal(body.includes(fixture.cwd), false);
});

test("reports no owned changes without failing or inventing a baseline budget", (t) => {
  const fixture = createFixture(t);
  const untouched = report.calculateReport({
    cwd: fixture.cwd,
    base: fixture.head,
    head: fixture.head,
    upstream: "upstream/main",
  });

  assert.deepEqual(untouched.files, []);
  assert.equal(untouched.changedLines, 0);
  assert.match(report.formatReport(untouched), /0 lines/);
  assert.match(report.formatReport(untouched), /Informational only/);
});

test("names missing refs and unrelated histories without exposing Git output", (t) => {
  const fixture = createFixture(t);
  assert.throws(
    () =>
      report.calculateReport({
        cwd: fixture.cwd,
        base: fixture.common,
        head: fixture.head,
        upstream: "missing/upstream-main",
      }),
    { message: "Unable to resolve the upstream main commit." },
  );

  const emptyTree = fixture.git(["mktree"], { input: "" });
  const unrelated = fixture.git(["commit-tree", emptyTree, "-m", "unrelated history"]);
  fixture.git(["update-ref", "refs/remotes/unrelated/main", unrelated]);
  assert.throws(
    () =>
      report.calculateReport({
        cwd: fixture.cwd,
        base: fixture.common,
        head: fixture.head,
        upstream: "refs/remotes/unrelated/main",
      }),
    { message: "Unable to find a merge base for PR head and upstream main." },
  );
});

test("updates only its own report comment", async () => {
  const existingComments = [
    {
      id: 5,
      user: { login: "contributor", type: "User" },
      body: `${report.COMMENT_MARKER}\nHuman comment`,
    },
    {
      id: 6,
      user: { login: "github-actions[bot]", type: "Bot" },
      body: `${report.COMMENT_MARKER}\nOld report`,
    },
  ];
  let updateInput;
  let createInput;
  const github = {
    paginate: async () => existingComments,
    rest: {
      issues: {
        listComments: async () => ({ data: existingComments }),
        updateComment: async (input) => {
          updateInput = input;
        },
        createComment: async (input) => {
          createInput = input;
        },
      },
    },
  };
  const body = `${report.COMMENT_MARKER}\nCurrent report`;

  await report.publishComment({
    github,
    owner: "JustYannicc",
    repo: "signalbox",
    pullNumber: 42,
    body,
  });

  assert.deepEqual(updateInput, {
    owner: "JustYannicc",
    repo: "signalbox",
    comment_id: 6,
    body,
  });
  assert.equal(createInput, undefined);
});

test("creates a report comment when no bot-owned report exists", async () => {
  let createInput;
  const github = {
    paginate: async () => [
      {
        id: 5,
        user: { login: "contributor", type: "User" },
        body: `${report.COMMENT_MARKER}\nHuman comment`,
      },
    ],
    rest: {
      issues: {
        listComments: async () => ({ data: [] }),
        updateComment: async () => assert.fail("did not expect an update"),
        createComment: async (input) => {
          createInput = input;
        },
      },
    },
  };
  const body = report.unavailableReport();

  await report.publishComment({
    github,
    owner: "JustYannicc",
    repo: "signalbox",
    pullNumber: 42,
    body,
  });

  assert.deepEqual(createInput, {
    owner: "JustYannicc",
    repo: "signalbox",
    issue_number: 42,
    body,
  });
});
