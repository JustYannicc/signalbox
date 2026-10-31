// @effect-diagnostics nodeBuiltinImport:off - The standalone profiler retains its command, raw child ledger and actual closure alongside the consumed payload.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Schema from "effect/Schema";
import { startupProfilePaths, startupProfilerCommand } from "./command.ts";
import { serializedStartupPayload, sha256 } from "./payload.ts";
import { type profilerRuntime, StartupRuntime } from "./runtime.ts";

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Pid = Schema.Int.check(Schema.isGreaterThan(0));
const Event = Schema.Struct({
  event: Schema.Literals(["workerd-spawn", "workerd-close"]),
  pid: Pid,
  guardPassed: Schema.optionalKey(Schema.Boolean),
  streamsClosed: Schema.optionalKey(Schema.Array(Schema.Boolean)),
});
const decodeEvents = Schema.decodeUnknownSync(Schema.Array(Event));
const decodeClosure = Schema.decodeUnknownSync(
  Schema.Struct({
    command: Schema.Array(Schema.String),
    cwd: Schema.String,
    terminal: Schema.Struct({ code: Schema.Literal(0), signal: Schema.Null }),
    wranglerPid: Pid,
    wranglerWaited: Schema.Literal(true),
    streamsClosed: Schema.Array(Schema.Literal(true)),
    events: Schema.Array(Event),
    remainingOwnedGroup: Schema.Array(Schema.Unknown),
    joined: Schema.Literal(true),
    failure: Schema.Null,
    failureExportError: Schema.Null,
    terminationErrors: Schema.Array(Schema.String),
    terminationDeadlineExceeded: Schema.Literal(false),
  }),
);
const Invocation = Schema.Struct({
  schema: Schema.Literal("signalbox/worker-startup-invocation/v1"),
  payloadSha256: Hash,
  profileSha256: Hash,
  runtime: StartupRuntime,
  command: Schema.Array(Schema.String),
  cwd: Schema.String,
  workerBundleSha256: Hash,
  childLedgerSha256: Hash,
  closureSha256: Hash,
  hookSha256: Hash,
});
const decodeInvocation = Schema.decodeUnknownSync(Invocation);
type Runtime = Awaited<ReturnType<typeof profilerRuntime>>;
const hookPath = NodeURL.fileURLToPath(new URL("./profileHook.ts", import.meta.url));
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

async function invocationFiles(main: string) {
  const paths = startupProfilePaths(main);
  const [worker, ledger, closure, hook] = await Promise.all([
    NodeFSP.readFile(paths.workerFile),
    NodeFSP.readFile(paths.ledgerFile),
    NodeFSP.readFile(NodePath.join(paths.output, "closure.json")),
    NodeFSP.readFile(hookPath),
  ]);
  return { worker, ledger, closure, hook };
}

function requireClosedInvocation(
  ledgerBytes: Buffer,
  closureBytes: Buffer,
  main: string,
  runtime: Runtime,
) {
  const events = decodeEvents(
    ledgerBytes
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  );
  const closure = decodeClosure(JSON.parse(closureBytes.toString()));
  const spawn = events[0],
    exit = events[1];
  if (
    events.length !== 2 ||
    spawn?.event !== "workerd-spawn" ||
    spawn.guardPassed !== true ||
    exit?.event !== "workerd-close" ||
    spawn.pid !== exit.pid ||
    exit.streamsClosed?.length !== 4 ||
    !exit.streamsClosed.every(Boolean) ||
    closure.streamsClosed.length !== 2 ||
    closure.remainingOwnedGroup.length ||
    closure.terminationErrors.length ||
    JSON.stringify(closure.events) !== JSON.stringify(events)
  )
    throw new Error("WORKER_STARTUP_INVOCATION_NOT_CLOSED");
  if (
    JSON.stringify(closure.command) !== JSON.stringify(startupProfilerCommand(runtime, main)) ||
    closure.cwd !== NodePath.dirname(main)
  )
    throw new Error("WORKER_STARTUP_INVOCATION_COMMAND_DIFFERS");
}

/** Only a completed public profiler attempt can publish the receipt consumed by the upload gate. */
export async function writeStartupInvocation(
  main: string,
  payloadSha256: string,
  runtime: Runtime,
  profile: Uint8Array,
) {
  const files = await invocationFiles(main);
  requireClosedInvocation(files.ledger, files.closure, main, runtime);
  if ((await serializedStartupPayload(files.worker)).sha256 !== payloadSha256)
    throw new Error("WORKER_STARTUP_INVOCATION_PAYLOAD_DIFFERS");
  const receipt = decodeInvocation({
    schema: "signalbox/worker-startup-invocation/v1",
    payloadSha256,
    profileSha256: sha256(profile),
    runtime: runtime.identity,
    command: startupProfilerCommand(runtime, main),
    cwd: NodePath.dirname(main),
    workerBundleSha256: sha256(files.worker),
    childLedgerSha256: sha256(files.ledger),
    closureSha256: sha256(files.closure),
    hookSha256: sha256(files.hook),
  });
  const bytes = Buffer.from(json(receipt));
  await NodeFSP.writeFile(
    NodePath.join(startupProfilePaths(main).output, "invocation.json"),
    bytes,
    { flag: "wx" },
  );
  return sha256(bytes);
}

export async function requireStartupInvocation(
  main: string,
  payloadSha256: string,
  profile: Uint8Array,
  expectedReceiptSha256: string,
  runtime: Runtime,
) {
  const receiptBytes = await NodeFSP.readFile(
    NodePath.join(startupProfilePaths(main).output, "invocation.json"),
  );
  if (sha256(receiptBytes) !== expectedReceiptSha256)
    throw new Error("WORKER_STARTUP_INVOCATION_CHANGED");
  const receipt = decodeInvocation(JSON.parse(receiptBytes.toString()));
  const files = await invocationFiles(main);
  for (const [bytes, expected] of [
    [files.worker, receipt.workerBundleSha256],
    [files.ledger, receipt.childLedgerSha256],
    [files.closure, receipt.closureSha256],
    [files.hook, receipt.hookSha256],
  ] as const)
    if (sha256(bytes) !== expected) throw new Error("WORKER_STARTUP_INVOCATION_FILES_CHANGED");
  if (
    receipt.payloadSha256 !== payloadSha256 ||
    receipt.profileSha256 !== sha256(profile) ||
    JSON.stringify(receipt.runtime) !== JSON.stringify(runtime.identity) ||
    JSON.stringify(receipt.command) !== JSON.stringify(startupProfilerCommand(runtime, main)) ||
    receipt.cwd !== NodePath.dirname(main) ||
    (await serializedStartupPayload(files.worker)).sha256 !== payloadSha256
  )
    throw new Error("WORKER_STARTUP_INVOCATION_MISMATCH");
  requireClosedInvocation(files.ledger, files.closure, main, runtime);
}
