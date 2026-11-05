"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");
const { runInNativeSlot } = require("./workerd-admission.cjs");

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ci-workerd-admission-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return {
    ...process.env,
    HOME: home,
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
  };
}
const slot = (env) => path.join(env.HOME, ".t3", "heavy-slots-native", "slot-1");

test("holds a live ancestor slot for its command and inventory grandchildren", (t) => {
  const env = fixture(t);
  const admission = pathToFileURL(
    path.resolve(__dirname, "../../apps/cloud/infra/harnessReleases/workerdLaunchAdmission.ts"),
  ).href;
  const inspect = `
    const { requireWorkerdLaunchAdmission, requireWorkerdLaunchAdmissionSync } = await import(${JSON.stringify(admission)});
    await requireWorkerdLaunchAdmission();
    requireWorkerdLaunchAdmissionSync();
  `;
  const result = childProcess.spawnSync(
    process.execPath,
    [
      path.join(__dirname, "workerd-admission.cjs"),
      "run",
      process.execPath,
      "--input-type=module",
      "-e",
      `import { execFileSync } from "node:child_process";
       ${inspect}
       execFileSync(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(inspect)}], { env: process.env });`,
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(slot(env)), false);
});

test("releases its slot and returns the command failure", (t) => {
  const env = fixture(t);
  assert.equal(runInNativeSlot(env, process.execPath, ["-e", "process.exitCode=7"]), 7);
  assert.equal(fs.existsSync(slot(env)), false);
  assert.throws(() => runInNativeSlot(env, path.join(env.HOME, "missing"), []), /ENOENT/u);
  assert.equal(fs.existsSync(slot(env)), false);
});

test("refuses shared runners, paused execution, and an occupied slot", (t) => {
  const env = fixture(t);
  const command = [process.execPath, ["-e", "process.exitCode=0"]];
  assert.throws(
    () => runInNativeSlot({ ...env, RUNNER_ENVIRONMENT: "self-hosted" }, ...command),
    /isolated GitHub-hosted/u,
  );
  fs.mkdirSync(path.join(env.HOME, ".t3"));
  const pause = path.join(env.HOME, ".t3", "heavy-slots-paused");
  fs.writeFileSync(pause, "paused");
  assert.throws(() => runInNativeSlot(env, ...command), /paused/u);
  fs.unlinkSync(pause);
  fs.mkdirSync(slot(env), { recursive: true });
  fs.writeFileSync(path.join(slot(env), "pid"), "1\n");
  assert.throws(() => runInNativeSlot(env, ...command), /EEXIST/u);
  assert.equal(fs.readFileSync(path.join(slot(env), "pid"), "utf8"), "1\n");
});

test("preserves a slot whose owner changed during execution", (t) => {
  const env = fixture(t);
  const pidfile = path.join(slot(env), "pid");
  assert.throws(
    () =>
      runInNativeSlot(env, process.execPath, [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(pidfile)}, "2\\n")`,
      ]),
    /another native slot owner/u,
  );
  assert.equal(fs.readFileSync(pidfile, "utf8"), "2\n");
});
