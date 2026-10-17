const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/signalbox-ci.yml"), "utf8");
const gate = workflow.match(/echo "\$RESULTS" \| jq -e '([\s\S]*?)' > \/dev\/null/)[1];

function detect(files, full = false) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ci-changes-"));
  try {
    const args = [path.join(__dirname, "ci-changes.cjs")];
    if (files !== null) {
      const paths = path.join(temp, "paths");
      fs.writeFileSync(paths, files.join("\n"));
      args.push("--paths", paths);
    }
    if (full) args.push("--full");
    const output = execFileSync(process.execPath, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return Object.fromEntries(
      output
        .trim()
        .split("\n")
        .map((line) => line.split(/=(.*)/s)),
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

test("docs skip expensive jobs", () => {
  const gates = detect(["docs/user/threads.md"]);
  for (const key of [
    "typecheck",
    "build",
    "test",
    "test_web",
    "test_server",
    "rust",
    "release_smoke",
  ]) {
    assert.equal(gates[key], "false", key);
  }
});

test("web sources keep web, desktop build and scripts tests without server shards", () => {
  const gates = detect(["apps/web/src/components/ChatView.tsx"]);
  for (const key of ["typecheck", "build", "test", "test_web"])
    assert.equal(gates[key], "true", key);
  assert.equal(gates.test_server, "false");
  assert.equal(gates.rust, "false");
  assert.match(gates.test_packages, /@t3tools\/scripts/);
});

test("server sources keep the full server suite without web tests", () => {
  const gates = detect(["apps/server/src/ws.ts"]);
  for (const key of ["typecheck", "build", "test", "test_server"])
    assert.equal(gates[key], "true", key);
  assert.equal(gates.test_web, "false");
  assert.equal(gates.rust, "false");
});

test("cloud sources keep cloud tests without desktop build or server shards", () => {
  const gates = detect(["apps/cloud/src/user/UserObject.ts"]);
  assert.equal(gates.typecheck, "true");
  assert.equal(gates.test, "true");
  assert.match(gates.test_packages, /@signalbox\/cloud/);
  for (const key of ["build", "test_web", "test_server", "rust"])
    assert.equal(gates[key], "false", key);
});

test("migration parser changes reach cloud stage tests through their relative import", () => {
  const gates = detect(["scripts/cloud-migrations/check.ts"]);
  assert.match(gates.test_packages, /@signalbox\/cloud/);
});

test("contracts reach web, server and cloud dependents", () => {
  const gates = detect(["packages/contracts/src/orchestrationV2.ts"]);
  for (const key of ["build", "test_web", "test_server", "test"])
    assert.equal(gates[key], "true", key);
  assert.match(gates.test_packages, /@signalbox\/cloud/);
});

test("account hub pins keep the server tests and desktop build", () => {
  const gates = detect(["apps/cloud/containers/cliproxyapi/release.json"]);
  assert.equal(gates.test_server, "true");
  assert.equal(gates.build, "true");
  assert.match(gates.test_packages, /@signalbox\/cloud/);
});

test("native crates keep Rust checks and packaging tests", () => {
  const gates = detect(["native/resource-monitor/src/main.rs"]);
  assert.equal(gates.rust, "true");
  assert.match(gates.test_packages, /@t3tools\/scripts/);
});

for (const files of [
  null,
  ["new-root-config.json"],
  ["apps/web/package.json"],
  ["pnpm-lock.yaml"],
]) {
  test(`unknown paths, manifests and unresolved diffs keep every job: ${JSON.stringify(files)}`, () => {
    const gates = detect(files);
    for (const key of [
      "typecheck",
      "build",
      "test",
      "test_web",
      "test_server",
      "rust",
      "release_smoke",
    ]) {
      assert.equal(gates[key], "true", key);
    }
  });
}

test("main's full mode keeps every job even for a docs-only diff", () => {
  const gates = detect(["docs/user/threads.md"], true);
  for (const key of [
    "typecheck",
    "build",
    "test",
    "test_web",
    "test_server",
    "rust",
    "release_smoke",
  ]) {
    assert.equal(gates[key], "true", key);
  }
});

function accepted(results) {
  return spawnSync("jq", ["-e", gate], { input: JSON.stringify(results) }).status === 0;
}

test("the required check accepts a skip explicitly authorized by path detection", () => {
  assert.equal(
    accepted({
      cloud_migrations: { result: "success", outputs: { test_server: "false" } },
      lint: { result: "success" },
      test_server: { result: "skipped" },
    }),
    true,
  );
});

for (const result of ["failure", "cancelled"]) {
  test(`the required check rejects ${result} even when path detection says the job was unnecessary`, () => {
    assert.equal(
      accepted({
        cloud_migrations: { result: "success", outputs: { test_server: "false" } },
        test_server: { result },
      }),
      false,
    );
  });
}

for (const outputs of [{}, { test_server: "true" }]) {
  test(`the required check rejects an unexplained skip: ${JSON.stringify(outputs)}`, () => {
    assert.equal(
      accepted({
        cloud_migrations: { result: "success", outputs },
        test_server: { result: "skipped" },
      }),
      false,
    );
  });
}

test("the required check rejects a failed selector and skipped fork guards", () => {
  assert.equal(accepted({ cloud_migrations: { result: "failure", outputs: {} } }), false);
  assert.equal(
    accepted({
      cloud_migrations: { result: "success", outputs: {} },
      upstream_merge: { result: "skipped" },
    }),
    false,
  );
});
