const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const script = path.join(__dirname, "delete-cloud-preview.sh");

test("does not delete resources after the pull request has reopened", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "signalbox-preview-close-"));
  const bin = path.join(directory, "bin");
  const calls = path.join(directory, "calls");
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "gh"),
    `#!/bin/sh
printf "%s\\n" "$*" >> "$GH_CALLS"
printf "open\\n"
`,
    { mode: 0o755 },
  );

  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "test-token",
      GH_TOKEN: "test-token",
      GITHUB_REPOSITORY: "owner/repository",
      GH_CALLS: calls,
      PR_NUMBER: "42",
    },
  });

  try {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PR #42 is open; skipping preview cleanup\./);
    assert.equal(readFileSync(calls, "utf8"), "api repos/owner/repository/pulls/42 --jq .state\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stops before detaching domains when the pull request reopens during teardown", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "signalbox-preview-reopen-"));
  const bin = path.join(directory, "bin");
  const alchemyBin = path.join(directory, "apps/cloud/node_modules/.bin");
  const calls = path.join(directory, "gh-calls");
  const alchemyCalls = path.join(directory, "alchemy-calls");
  mkdirSync(bin, { recursive: true });
  mkdirSync(alchemyBin, { recursive: true });
  writeFileSync(
    path.join(bin, "gh"),
    `#!/bin/sh
printf "%s\\n" "$*" >> "$GH_CALLS"
if [ "$(wc -l < "$GH_CALLS")" -eq 1 ]; then printf "closed\\n"; else printf "open\\n"; fi
`,
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(alchemyBin, "alchemy"),
    `#!/bin/sh
printf "%s\\n" "$*" >> "$ALCHEMY_CALLS"
`,
    { mode: 0o755 },
  );

  const result = spawnSync("bash", [script], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "test-token",
      GH_TOKEN: "test-token",
      GITHUB_REPOSITORY: "owner/repository",
      GH_CALLS: calls,
      ALCHEMY_CALLS: alchemyCalls,
      PR_NUMBER: "42",
    },
  });

  try {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PR #42 is open; stopping the remaining preview cleanup\./);
    assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 2);
    assert.equal(readFileSync(alchemyCalls, "utf8"), "destroy --stage pr-42 --yes --no-input\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
