// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalDateInEffect:off globalFetch:off globalConsole:off preferSchemaOverJson:off globalConsoleInEffect:off - Host-side process verifier owns its deadlines and raw wire evidence.
/**
 * Live end-to-end check of an automation supervising agents: it works through
 * real GitHub issues in blocker order, one agent and pull request per issue,
 * waits for CI, has a second agent review, and merges. Nothing supervises it
 * but the automation's own code.
 *
 * Needs a GitHub repository you own whose issues are safe to build and merge,
 * with a CI job named by --check, and an authenticated `gh`:
 *   node apps/server/scripts/verify-automations-tickets.ts --repo you/sandbox --tickets 1,2,3 \
 *     --automation path/to/work-through-tickets.ts
 * Uses existing provider CLI authentication and a fresh home. Evidence stays in
 * the printed directory, including on failure.
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
    repo: { type: "string" },
    tickets: { type: "string" },
    automation: { type: "string" },
    check: { type: "string", default: "Check" },
    provider: { type: "string", default: "claudeAgent" },
    model: { type: "string", default: "claude-sonnet-5-5" },
    builder: { type: "string", default: "claudeAgent/claude-sonnet-5-5/medium" },
    reviewer: { type: "string", default: "codex/gpt-6-luna/medium" },
    timeout: { type: "string", default: "7200" },
  },
});
NodeAssert.ok(
  values.repo && values.tickets && values.automation,
  "Pass --repo, --tickets and --automation.",
);
const tickets = values.tickets.split(",").map(Number);
const agent = (spec: string) => {
  const [provider, model, effort] = spec.split("/");
  return { provider, model, ...(effort ? { effort } : {}) };
};
const timeoutMs = Number(values.timeout) * 1000;
const root = NodePath.resolve(import.meta.dirname, "../../..");
const evidence = NodeFS.mkdtempSync(
  NodePath.join(NodeOS.tmpdir(), "signalbox-automations-tickets-"),
);
const home = NodePath.join(evidence, "home");
const project = NodePath.join(evidence, "project");
NodeChildProcess.execFileSync("gh", ["repo", "clone", values.repo, project, "--", "-q"]);
console.log(`Evidence: ${evidence}`);
const AUTOMATION = NodeFS.readFileSync(values.automation, "utf8");
const NAME = /name: "([^"]+)"/.exec(AUTOMATION)?.[1];
NodeAssert.ok(NAME, "The automation needs a literal meta name.");
const ticketState = () =>
  tickets.map(
    (number) =>
      JSON.parse(
        NodeChildProcess.execFileSync(
          "gh",
          ["issue", "view", String(number), "-R", values.repo!, "--json", "number,state"],
          {
            encoding: "utf8",
          },
        ),
      ) as { number: number; state: string },
  );

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
      title: "Tickets",
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

  const prompt = `Save this automation exactly as written with the automation_save tool, then end your turn replying with exactly SAVED. Do not change the code and do not run it.\n\n\`\`\`ts\n${AUTOMATION}\`\`\``;
  NodeFS.writeFileSync(NodePath.join(evidence, "prompt.txt"), prompt);

  const program = Effect.gen(function* () {
    const client = yield* RpcClient.make(WsRpcGroup);
    yield* client["orchestration.launchThread"]({
      commandId: CommandId.make(NodeCrypto.randomUUID()),
      threadId: ThreadId.make(NodeCrypto.randomUUID()),
      projectId,
      title: "Save the ticket automation",
      modelSelection: {
        instanceId: ProviderInstanceId.make(values.provider!),
        model: values.model!,
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { text: prompt, attachments: [] },
    });

    const list = yield* client[AUTOMATION_WS_METHODS.automationsSubscribe]({}).pipe(
      Stream.filter(({ automations }) =>
        automations.some((automation) => automation.name === NAME),
      ),
      Stream.runHead,
    );
    const automation =
      list._tag === "Some"
        ? list.value.automations.find((candidate) => candidate.name === NAME)
        : undefined;
    NodeAssert.ok(automation, "The agent didn't save the automation");
    console.log(`Saved ${automation.id}`);

    const started = yield* client[AUTOMATION_WS_METHODS.automationsRunNow]({
      automationId: automation.id,
      input: {
        repo: values.repo,
        tickets,
        check: values.check,
        atOnce: 2,
        builder: agent(values.builder!),
        reviewer: agent(values.reviewer!),
      },
    });
    console.log(`Run ${started.id}`);

    let lastLine = "";
    const finished = yield* client[AUTOMATION_WS_METHODS.automationsSubscribeRun]({
      runId: started.id,
    }).pipe(
      Stream.tap((detail: AutomationRunDetail) =>
        Effect.sync(() => {
          NodeFS.writeFileSync(
            NodePath.join(evidence, "run.json"),
            JSON.stringify(detail, null, 2),
          );
          const active = detail.steps.filter(
            (step) => step.status === "running" || step.status === "waiting",
          );
          const line = `${detail.run.status} | ${detail.steps.length} steps | ${active.map((step) => step.label).join(", ")}`;
          if (line !== lastLine) console.log(`[${new Date().toISOString()}] ${line}`);
          lastLine = line;
        }),
      ),
      Stream.filter(
        (detail) =>
          detail.run.status !== "running" ||
          detail.steps.some((step) => step.verb === "ask" && step.status === "waiting"),
      ),
      Stream.runHead,
    );
    NodeAssert.ok(finished._tag === "Some", "The run stream ended early");
    const stuck = finished.value.steps.find(
      (step) => step.verb === "ask" && step.status === "waiting",
    );
    NodeAssert.ok(!stuck, `A ticket got stuck: ${stuck?.label}`);
    NodeAssert.equal(
      finished.value.run.status,
      "succeeded",
      `Run failed: ${finished.value.run.error}`,
    );
    const states = ticketState();
    NodeAssert.ok(
      states.every((issue) => issue.state === "CLOSED"),
      `Not all tickets closed: ${JSON.stringify(states)}`,
    );
    return {
      automationId: automation.id,
      runId: started.id,
      output: finished.value.output,
      tickets: states,
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
