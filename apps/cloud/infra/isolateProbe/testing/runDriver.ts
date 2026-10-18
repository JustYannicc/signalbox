// @effect-diagnostics nodeBuiltinImport:off - stand-ins for the external CLIs persist ownership in a temporary directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { runProcess, type ProbeProcess, type RunProcess } from "../process.ts";

// A local stand-in for the external CLIs persists resource ownership and proof files.
// Each phase is a separate OS process with only the environment the wrapper supplied.
const driver = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [dir, phase, stage, mode, output, fixture] = process.argv.slice(1);
const credential = process.env.PROBE_SECRET;
if (Buffer.from(credential, 'base64url').length !== 32) process.exit(91);
const hash = crypto.createHash('sha256').update(credential).digest('hex');
const worker = path.join(dir, stage + '.worker');
const namespace = path.join(dir, stage + '.namespace');
fs.appendFileSync(path.join(dir, 'events'), JSON.stringify({phase, stage, hash, fixture}) + '\n');
if (phase === 'deploy') {
  if (process.env.PROBE_URL) process.exit(92);
  fs.writeFileSync(worker, hash, {flag: 'wx'});
  if (mode === 'partial') process.exit(7);
  fs.writeFileSync(namespace, hash, {flag: 'wx'});
  console.log("url: 'https://sb-" + stage + ".test-account.workers.dev'");
} else if (phase === 'measure') {
  if (fs.readFileSync(worker, 'utf8') !== hash || fs.readFileSync(namespace, 'utf8') !== hash) process.exit(93);
  if (process.env.PROBE_URL !== 'https://sb-' + stage + '.test-account.workers.dev/') process.exit(94);
  const json = JSON.stringify({schemaVersion: 1, verificationErrors: mode.includes('measure') ? ['failed proof'] : []});
  if (output) fs.writeFileSync(output, json);
  console.log(json);
  if (mode.includes('measure')) process.exit(9);
} else {
  if (process.env.PROBE_URL) process.exit(95);
  if (mode.includes('cleanup')) process.exit(8);
  fs.rmSync(worker, {force: true});
  fs.rmSync(namespace, {force: true});
}
`;

export async function withDriver(
  mode: string,
  test: (context: {
    dir: string;
    logs: string[];
    run: RunProcess;
    requests: ProbeProcess[];
    events: () => Promise<{ phase: string; stage: string; hash: string; fixture: string }[]>;
  }) => Promise<void>,
) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "probe-run-"));
  const requests: ProbeProcess[] = [];
  const logs: string[] = [];
  let stage = "";
  const run: RunProcess = async (request) => {
    requests.push(request);
    const phase =
      request.args[0] === "deploy" || request.args[0] === "destroy" ? request.args[0] : "measure";
    if (phase !== "measure") stage = request.args[request.args.indexOf("--stage") + 1]!;
    const arg = (name: string) => {
      const index = request.args.indexOf(name);
      return index === -1 ? "" : request.args[index + 1]!;
    };
    return runProcess({
      ...request,
      command: process.execPath,
      args: ["-e", driver, dir, phase, stage, mode, arg("--output"), arg("--fixture")],
      timeoutMs: 10_000,
    });
  };
  try {
    await test({
      dir,
      logs,
      run,
      requests,
      events: async () =>
        (await NodeFSP.readFile(NodePath.join(dir, "events"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
    });
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
}
