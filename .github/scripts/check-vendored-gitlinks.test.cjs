const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const checker = path.join(__dirname, "check-vendored-gitlinks.cjs");

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();
}

function runChecker(cwd) {
  return spawnSync(process.execPath, [checker], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("rejects vendored Gitlinks and accepts their index-only removal", (t) => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "vendored-gitlinks-"));
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));

  git(repository, "init", "--quiet", "--initial-branch=main");
  git(repository, "config", "user.name", "Fixture");
  git(repository, "config", "user.email", "fixture@example.invalid");

  const vendor = path.join(repository, ".repos", "fixture");
  const trackedFile = path.join(vendor, "source.txt");
  const nestedGitmodules = Buffer.from(
    '[submodule "alpha"]\n\tpath = deps/alpha\n\turl = https://example.invalid/alpha.git\n' +
      '[submodule "beta"]\n\tpath = deps/beta\n\turl = https://example.invalid/beta.git\n',
  );
  const trackedContents = Buffer.from("vendored source bytes\n");
  fs.mkdirSync(vendor, { recursive: true });
  fs.writeFileSync(path.join(vendor, ".gitmodules"), nestedGitmodules);
  fs.writeFileSync(trackedFile, trackedContents);
  git(repository, "add", "--", ".repos/fixture/.gitmodules", ".repos/fixture/source.txt");
  git(repository, "commit", "--quiet", "-m", "fixture vendored files");

  const links = [
    [".repos/fixture/deps/alpha", "alpha payload bytes\n"],
    [".repos/fixture/deps/beta", "beta payload bytes\n"],
  ];
  const linkPaths = links.map(([filePath]) => filePath);
  const linkContents = new Map();
  const commit = git(repository, "rev-parse", "HEAD");
  for (const [filePath, contents] of links) {
    const directory = path.join(repository, filePath);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "payload.txt"), contents);
    linkContents.set(filePath, Buffer.from(contents));
    git(repository, "update-index", "--add", "--cacheinfo", `160000,${commit},${filePath}`);
  }

  git(repository, "commit", "--quiet", "-m", "fixture with vendored Gitlinks");
  assert.equal(fs.existsSync(path.join(repository, ".gitmodules")), false);

  const rejected = runChecker(repository);
  assert.equal(rejected.status, 1, rejected.stderr || rejected.stdout);
  for (const filePath of linkPaths) assert.ok(rejected.stderr.includes(filePath));

  git(repository, "rm", "--cached", "-f", "--", ...linkPaths);
  assert.deepEqual(fs.readFileSync(trackedFile), trackedContents);
  for (const [filePath, contents] of linkContents) {
    const directory = path.join(repository, filePath);
    assert.equal(fs.existsSync(directory), true);
    assert.deepEqual(fs.readFileSync(path.join(directory, "payload.txt")), contents);
  }

  git(repository, "commit", "--quiet", "-m", "remove Gitlinks from the index");
  assert.deepEqual(
    execFileSync("git", ["show", "HEAD:.repos/fixture/source.txt"], {
      cwd: repository,
      encoding: "buffer",
    }),
    trackedContents,
  );
  assert.deepEqual(
    execFileSync("git", ["show", "HEAD:.repos/fixture/.gitmodules"], {
      cwd: repository,
      encoding: "buffer",
    }),
    nestedGitmodules,
  );
  for (const [filePath, contents] of linkContents) {
    assert.deepEqual(fs.readFileSync(path.join(repository, filePath, "payload.txt")), contents);
  }
  const accepted = runChecker(repository);
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
});
