// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off globalConsole:off preferSchemaOverJson:off globalConsoleInEffect:off - Host-side process verifier owns its deadlines and raw wire evidence.
/**
 * Live end-to-end check for automations, against a real server and provider:
 * an agent in a thread writes and saves an automation through the MCP tools,
 * the run starts an agent step and asks a question, the answer arrives over
 * the WebSocket API, and the run finishes with the agent's output.
 *
 * Run from the repository root:
 *   node apps/server/scripts/verify-automations-live.ts --provider claudeAgent --model claude-sonnet-4-6
 * Uses existing provider CLI authentication, a fresh home and a disposable Git
 * project. Evidence stays in the printed directory, including on failure.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import {
  AUTOMATION_WS_METHODS,
  CommandId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WsRpcGroup,
  type AutomationRunDetail,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { Socket } from "effect/unstable/socket";

const { values } = NodeUtil.parseArgs({
  options: {
    provider: { type: "string", default: "claudeAgent" },
    model: { type: "string", default: "claude-sonnet-4-6" },
    timeout: { type: "string", default: "600" },
  },
});
const timeoutMs = Number(values.timeout) * 1000;
const root = NodePath.resolve(import.meta.dirname, "../../..");
const evidence = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "signalbox-automations-live-"));
const home = NodePath.join(evidence, "home");
const project = NodePath.join(evidence, "project");
NodeFS.mkdirSync(project, { recursive: true });
NodeFS.writeFileSync(NodePath.join(project, "README.md"), "# Automation verification\n");
for (const args of [
  ["init", "-q"],
  ["add", "."],
  ["-c", "user.email=v@example.com", "-c", "user.name=v", "commit", "-qm", "init"],
]) {
  NodeChildProcess.execFileSync("git", args, { cwd: project });
}
console.log(`Evidence: ${evidence}`);

const NAME = "Live verification";
const AUTOMATION = `export const meta = { name: "${NAME}" } as const;

export default workflow(async (w) => {
  const reply = await w.agent("Say the word", { prompt: "Reply with exactly the word PINEAPPLE and nothing else. Do not use tools." });
  const kind = await w.judge("Fruit or vegetable?", { input: reply.text, outcomes: ["fruit", "vegetable"] });
  const facts = await w.extract("Read the facts", { input: "A pineapple weighs about 1.5 kg.", schema: { kilograms: "number" } });
  const choice = await w.ask("Keep going?", { options: ["yes", "no"] });
  if (choice === "no") return "stopped";
  return \`\${reply.text.trim()} \${kind} \${facts.kilograms}\`;
});
`;

const reservation = NodeHttp.createServer();
reservation.listen(0, "127.0.0.1");
await new Promise<void>((done) => reservation.once("listening", done));
const address = reservation.address();
NodeAssert.ok(address && typeof address !== "string");
await new Promise<void>((done) => reservation.close(() => done()));
const origin = `http://127.0.0.1:${address.port}`;
const bootstrap = NodeCrypto.randomUUID();

const server = NodeChildProcess.spawn(
  process.execPath,
  ["apps/server/src/bin.ts", "start", "--bootstrap-fd", "3", "--log-level", "debug"],
  {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  },
);
const bootstrapPipe = server.stdio[3];
NodeAssert.ok(bootstrapPipe && "write" in bootstrapPipe);
bootstrapPipe.end(
  JSON.stringify({
    mode: "desktop",
    noBrowser: true,
    port: address.port,
    t3Home: home,
    host: "127.0.0.1",
    desktopBootstrapToken: bootstrap,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  }),
);
const ready = Promise.withResolvers<void>();
let output = "";
for (const pipe of [server.stdout, server.stderr])
  pipe?.on("data", (data: Buffer) => {
    const text = data.toString().replaceAll(bootstrap, "[REDACTED]");
    NodeFS.appendFileSync(NodePath.join(evidence, "server.log"), text);
    output = (output + text).slice(-8192);
    if (output.includes("startup phase: complete")) ready.resolve();
  });
server.once("exit", (code) => ready.reject(new Error(`Server exited ${code}`)));
const startupDeadline = setTimeout(
  () => ready.reject(new Error("Server startup timed out")),
  90_000,
);

let verdict: object = { status: "failed", reason: "verification did not finish" };
try {
  await ready.promise;
  clearTimeout(startupDeadline);
  const tokenResponse = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: bootstrap,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    }),
  });
  NodeAssert.ok(tokenResponse.ok, `Authentication failed: ${tokenResponse.status}`);
  const token = Schema.decodeUnknownSync(Schema.Struct({ access_token: Schema.String }))(
    await tokenResponse.json(),
  );
  const headers = {
    Authorization: `Bearer ${token.access_token}`,
    "Content-Type": "application/json",
    [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
  };
  const projectId = ProjectId.make(NodeCrypto.randomUUID());
  const created = await fetch(`${origin}/api/projects/mutate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "project.create",
      commandId: NodeCrypto.randomUUID(),
      projectId,
      title: "Automations",
      workspaceRoot: project,
    }),
  });
  NodeAssert.ok(created.ok, `Project creation failed: ${created.status} ${await created.text()}`);
  const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers,
  });
  NodeAssert.ok(ticketResponse.ok, `WebSocket authentication failed: ${ticketResponse.status}`);
  const ticket = Schema.decodeUnknownSync(Schema.Struct({ ticket: Schema.String }))(
    await ticketResponse.json(),
  );
  const socket = Socket.layerWebSocket(
    `${origin.replace("http:", "ws:")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket.ticket)}`,
  ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
  const protocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(socket),
    Layer.provide(RpcSerialization.layerJson),
  );

  const prompt = `This is a live verification of Signalbox automations. Save this automation exactly as written with the automation_save tool (call automation_reference first if you like), then start one run of it with automation_run, then end your turn replying with exactly SAVED. Do not change the code.\n\n\`\`\`ts\n${AUTOMATION}\`\`\``;
  NodeFS.writeFileSync(NodePath.join(evidence, "prompt.txt"), prompt);

  const program = Effect.gen(function* () {
    const client = yield* RpcClient.make(WsRpcGroup);
    yield* client["orchestration.launchThread"]({
      commandId: CommandId.make(NodeCrypto.randomUUID()),
      threadId: ThreadId.make(NodeCrypto.randomUUID()),
      projectId,
      title: "Write an automation",
      modelSelection: { instanceId: ProviderInstanceId.make(values.provider), model: values.model },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { text: prompt, attachments: [] },
    });

    // Wait for the agent to save the automation and start a run.
    const list = yield* client[AUTOMATION_WS_METHODS.automationsSubscribe]({}).pipe(
      Stream.filter(({ automations }) =>
        automations.some((automation) => automation.name === NAME && automation.lastRun !== null),
      ),
      Stream.runHead,
    );
    const automation =
      list._tag === "Some"
        ? list.value.automations.find((candidate) => candidate.name === NAME)
        : undefined;
    NodeAssert.ok(automation?.lastRun, "The agent didn't save and run the automation");
    console.log(`Saved ${automation.id}, run ${automation.lastRun.id}`);

    // The run reaches the question once the agent step's thread finishes.
    const runs = client[AUTOMATION_WS_METHODS.automationsSubscribeRun]({
      runId: automation.lastRun.id,
    });
    const waiting = yield* runs.pipe(
      Stream.tap((detail) =>
        Effect.sync(() =>
          NodeFS.writeFileSync(
            NodePath.join(evidence, "run.json"),
            JSON.stringify(detail, null, 2),
          ),
        ),
      ),
      Stream.filter(
        (detail: AutomationRunDetail) =>
          detail.run.status !== "running" ||
          detail.steps.some((step) => step.verb === "ask" && step.status === "waiting"),
      ),
      Stream.runHead,
    );
    NodeAssert.ok(waiting._tag === "Some", "The run stream ended early");
    NodeAssert.equal(
      waiting.value.run.status,
      "running",
      `The run ended before asking: ${waiting.value.run.error}`,
    );
    const agentStep = waiting.value.steps.find((step) => step.verb === "agent");
    NodeAssert.equal(agentStep?.status, "succeeded", "The agent step didn't succeed");
    NodeAssert.ok(agentStep?.threadId, "The agent step has no thread");
    const ask = waiting.value.steps.find((step) => step.verb === "ask")!;
    console.log(`Agent thread ${agentStep.threadId} answered; answering "${ask.label}"`);

    yield* client[AUTOMATION_WS_METHODS.automationsAnswer]({
      runId: automation.lastRun.id,
      stepKey: ask.key,
      choice: "yes",
    });
    const finished = yield* runs.pipe(
      Stream.tap((detail) =>
        Effect.sync(() =>
          NodeFS.writeFileSync(
            NodePath.join(evidence, "run.json"),
            JSON.stringify(detail, null, 2),
          ),
        ),
      ),
      Stream.filter((detail) => detail.run.status !== "running"),
      Stream.runHead,
    );
    NodeAssert.ok(finished._tag === "Some");
    NodeAssert.equal(
      finished.value.run.status,
      "succeeded",
      `Run failed: ${finished.value.run.error}`,
    );
    NodeAssert.match(String(finished.value.output), /^PINEAPPLE fruit 1\.5$/);
    return {
      automationId: automation.id,
      runId: automation.lastRun.id,
      output: finished.value.output,
    };
  }).pipe(Effect.scoped, Effect.provide(protocol), Effect.timeout(timeoutMs));

  const result = await Effect.runPromise(program);
  verdict = { status: "passed", ...result };
} catch (error) {
  verdict = { status: "failed", reason: error instanceof Error ? error.message : String(error) };
} finally {
  NodeFS.writeFileSync(NodePath.join(evidence, "verdict.json"), JSON.stringify(verdict, null, 2));
  console.log(JSON.stringify(verdict, null, 2));
  if (server.pid !== undefined) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {}
  }
}
process.exit((verdict as { status: string }).status === "passed" ? 0 : 1);
