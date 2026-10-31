"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { reserve, release } = require("./workerd-admission.cjs");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ci-workerd-admission-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_TEMP: directory,
    GITHUB_ENV: path.join(directory, "environment"),
    GITHUB_REPOSITORY: "test/repository",
    GITHUB_RUN_ID: "1",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_JOB: "test",
  };
}

test("exports a job-owned live reservation and explicitly releases it", (t) => {
  const env = fixture(t);
  reserve(env);
  const variables = Object.fromEntries(
    fs
      .readFileSync(env.GITHUB_ENV, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
  const active = JSON.parse(fs.readFileSync(variables.SIGNALBOX_WORKERD_ACTIVE, "utf8"));
  assert.equal(active.currentOwnerThreadId, variables.SIGNALBOX_WORKERD_OWNER);
  assert.equal(active.reservationId, variables.SIGNALBOX_WORKERD_BATCH);
  assert.equal(active.reservationState, "RESERVED");
  release(env);
  const released = JSON.parse(fs.readFileSync(variables.SIGNALBOX_WORKERD_ACTIVE, "utf8"));
  assert.equal(released.reservationState, "RELEASED");
  assert.equal(released.currentOwnerThreadId, null);
  assert.equal(released.exclusiveHoldActive, false);
});

test("refuses to self-admit a shared or unidentified runner", (t) => {
  const env = fixture(t);
  assert.throws(
    () => reserve({ ...env, RUNNER_ENVIRONMENT: "self-hosted" }),
    /isolated GitHub-hosted/u,
  );
  assert.throws(() => reserve({ ...env, GITHUB_JOB: "" }), /job identity/u);
  assert.equal(fs.existsSync(env.GITHUB_ENV), false);
});

test("never overwrites an existing reservation or releases another job", (t) => {
  const env = fixture(t);
  reserve(env);
  assert.throws(() => reserve(env), /EEXIST/u);
  assert.throws(() => release({ ...env, GITHUB_JOB: "other" }), /another Workerd reservation/u);
  const active = JSON.parse(
    fs.readFileSync(path.join(env.RUNNER_TEMP, "signalbox-workerd", "ACTIVE.json"), "utf8"),
  );
  assert.equal(active.reservationState, "RESERVED");
});
