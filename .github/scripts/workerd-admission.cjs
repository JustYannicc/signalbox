"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function releaseSlot(slot, pidfile, owner) {
  if (fs.existsSync(pidfile)) {
    if (fs.readFileSync(pidfile, "utf8") !== owner)
      throw new Error("Refusing to release another native slot owner");
    fs.unlinkSync(pidfile);
  }
  fs.rmdirSync(slot);
}

function runInNativeSlot(env, command, args) {
  if (env.GITHUB_ACTIONS !== "true" || env.RUNNER_ENVIRONMENT !== "github-hosted")
    throw new Error("Only an isolated GitHub-hosted job can reserve its own Workerd slot");
  if (!env.HOME || !path.isAbsolute(env.HOME)) throw new Error("An absolute HOME is required");
  if (!command) throw new Error("A command is required");
  const root = path.join(env.HOME, ".t3");
  if (fs.existsSync(path.join(root, "heavy-slots-paused")))
    throw new Error("Heavy slots are paused");
  const pool = path.join(root, "heavy-slots-native");
  const slot = path.join(pool, "slot-1");
  fs.mkdirSync(pool, { recursive: true });
  fs.mkdirSync(slot);
  const pidfile = path.join(slot, "pid");
  const owner = `${process.pid}\n`;
  try {
    fs.writeFileSync(pidfile, owner, { flag: "wx" });
    const result = childProcess.spawnSync(command, args, {
      env: { ...env, HEAVY_SLOT_ACTIVE: "1" },
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    releaseSlot(slot, pidfile, owner);
  }
}

if (require.main === module) {
  if (process.argv[2] !== "run")
    throw new Error("Usage: workerd-admission.cjs run <command> [args...]");
  process.exitCode = runInNativeSlot(process.env, process.argv[3], process.argv.slice(4));
}

module.exports = { runInNativeSlot };
