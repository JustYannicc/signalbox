"use strict";

const fs = require("node:fs");
const path = require("node:path");

function context(env) {
  if (env.GITHUB_ACTIONS !== "true" || env.RUNNER_ENVIRONMENT !== "github-hosted")
    throw new Error("Only an isolated GitHub-hosted job can reserve its own Workerd slot");
  const values = [
    env.RUNNER_TEMP,
    env.GITHUB_REPOSITORY,
    env.GITHUB_RUN_ID,
    env.GITHUB_RUN_ATTEMPT,
    env.GITHUB_JOB,
  ];
  if (values.some((value) => typeof value !== "string" || !value || /[\r\n]/u.test(value)))
    throw new Error("Missing or invalid GitHub job identity");
  const owner = `github:${env.GITHUB_REPOSITORY}:${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}:${env.GITHUB_JOB}`;
  return {
    activePath: path.join(env.RUNNER_TEMP, "signalbox-workerd", "ACTIVE.json"),
    owner,
    batch: `${owner}:workerd`,
  };
}

function reserve(env) {
  const { activePath, owner, batch } = context(env);
  if (!env.GITHUB_ENV) throw new Error("GITHUB_ENV is required");
  fs.mkdirSync(path.dirname(activePath), { recursive: true });
  fs.writeFileSync(
    activePath,
    JSON.stringify({
      reservationState: "RESERVED",
      reservationId: batch,
      currentOwnerThreadId: owner,
      exclusiveHoldActive: true,
      reservedUntilRelease: true,
      expiresAt: null,
    }),
    { flag: "wx" },
  );
  fs.appendFileSync(
    env.GITHUB_ENV,
    `SIGNALBOX_WORKERD_ACTIVE=${activePath}\nSIGNALBOX_WORKERD_OWNER=${owner}\nSIGNALBOX_WORKERD_BATCH=${batch}\n`,
  );
}

function release(env) {
  const { activePath, owner, batch } = context(env);
  const active = JSON.parse(fs.readFileSync(activePath, "utf8"));
  if (
    active.reservationState !== "RESERVED" ||
    active.currentOwnerThreadId !== owner ||
    active.reservationId !== batch
  )
    throw new Error("Refusing to release another Workerd reservation");
  const temporaryPath = `${activePath}.released`;
  fs.writeFileSync(
    temporaryPath,
    JSON.stringify({
      ...active,
      reservationState: "RELEASED",
      currentOwnerThreadId: null,
      exclusiveHoldActive: false,
      reservedUntilRelease: false,
    }),
    { flag: "wx" },
  );
  fs.renameSync(temporaryPath, activePath);
}

if (require.main === module) {
  const command = process.argv[2];
  if (command === "reserve") reserve(process.env);
  else if (command === "release") release(process.env);
  else throw new Error("Usage: workerd-admission.cjs reserve|release");
}

module.exports = { reserve, release };
