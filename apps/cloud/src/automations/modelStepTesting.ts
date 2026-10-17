import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { compileForCloud } from "@signalbox/automation-compiler/compileForCloud";
import * as Environment from "../environment.ts";
import { makeMemoryCloud } from "../testing.ts";
import * as CloudCompiler from "./cloudCompiler.ts";
import { HOOK_USER } from "./hookTesting.ts";
import * as UserPools from "../user/UserPools.ts";
import * as UserShell from "../user/UserShell.ts";

export const claudeModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-5-5",
} as const;

interface CapturedRequest {
  readonly path: "/v1/messages" | "/v1/responses";
  readonly body: Record<string, unknown>;
  readonly headers: Headers;
}

interface UpstreamReply {
  readonly text: string;
  readonly status?: number;
}

type UpstreamResponder = (request: CapturedRequest) => UpstreamReply;

const poolName = `${HOOK_USER}:personal`;
const actor = { userId: HOOK_USER };

const completionResponse = (path: CapturedRequest["path"], reply: UpstreamReply) => {
  if (reply.status !== undefined && reply.status !== 200)
    return Response.json({ error: "provider unavailable" }, { status: reply.status });
  if (path === "/v1/messages")
    return Response.json({
      type: "message",
      stop_reason: "end_turn",
      content: [{ type: "text", text: reply.text }],
      usage: { input_tokens: 11, output_tokens: 7 },
    });
  return Response.json({
    status: "completed",
    output: [
      {
        type: "message",
        status: "completed",
        content: [{ type: "output_text", text: reply.text }],
      },
    ],
    usage: { input_tokens: 13, output_tokens: 5 },
  });
};

const installGateway = (
  personal: ReturnType<ReturnType<typeof makeMemoryCloud>["pools"]["objectFor"]>,
  initialResponder: UpstreamResponder,
) => {
  const requests: Array<CapturedRequest> = [];
  const originalServe = personal.cliProxyApi.serve;
  let responder = initialResponder;
  personal.cliProxyApi.serve = async (request) => {
    const path = new URL(request.url).pathname;
    if (path !== "/v1/messages" && path !== "/v1/responses") return originalServe(request);
    const captured: CapturedRequest = {
      path,
      body: (await request.json()) as Record<string, unknown>,
      headers: new Headers(request.headers),
    };
    requests.push(captured);
    if (
      path === "/v1/responses" &&
      (captured.body.stream !== false ||
        captured.body.store !== false ||
        "max_output_tokens" in captured.body ||
        "max_tokens" in captured.body)
    )
      return Response.json({ error: "Unsupported Codex account request" }, { status: 400 });
    return completionResponse(path, responder(captured));
  };
  return {
    requests,
    setResponder: (next: UpstreamResponder) => {
      responder = next;
    },
  };
};

export const makeModelStepHarness = () =>
  Effect.gen(function* () {
    const cloud = makeMemoryCloud();
    yield* cloud.userDirectory
      .forUser(HOOK_USER)
      .recordSignIn({ id: HOOK_USER, email: "models@example.test" });

    const save = (source: string, projectId = Environment.SCRATCH_PROJECT_ID) =>
      cloud.inUser(
        HOOK_USER,
        Effect.gen(function* () {
          const result = compileForCloud(source);
          if (!result.ok) return yield* Effect.die(result.diagnostics);
          const compiler = yield* CloudCompiler.CloudCompiler;
          const engine = yield* WorkflowEngine.WorkflowEngine;
          const saved = yield* compiler.withStaged(
            source,
            result.compiled,
            engine.save({
              source,
              projectId,
              defaults: {
                modelSelection: claudeModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
              },
            }),
          );
          if (!saved.ok) return yield* Effect.die(saved.diagnostics);
          return saved.automation;
        }),
      );

    const start = (automationId: string) =>
      cloud.inUser(
        HOOK_USER,
        WorkflowEngine.WorkflowEngine.use((engine) =>
          engine.startRun({ automationId, trigger: "manual" }),
        ),
      );

    const waitForTerminal = (runId: string) =>
      cloud.inUser(
        HOOK_USER,
        WorkflowEngine.WorkflowEngine.use((engine) =>
          engine.subscribeRun(runId).pipe(
            Stream.filter(({ run }) => run.status !== "running"),
            Stream.take(1),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          ),
        ),
      );

    const getRun = (runId: string) =>
      cloud.inUser(
        HOOK_USER,
        WorkflowEngine.WorkflowEngine.use((engine) => engine.getRun(runId)),
      );

    const startAndWait = (automationId: string) =>
      Effect.gen(function* () {
        const started = yield* start(automationId);
        yield* waitForTerminal(started.id);
        return yield* getRun(started.id);
      });

    const threadProjectionIds = () =>
      UserShell.UserShell.use((shell) => shell.snapshot).pipe(
        Effect.provide(cloud.userObject(HOOK_USER)),
        Effect.map((snapshot) => [
          ...snapshot.threads.map((thread) => thread.id),
          ...snapshot.archivedThreads.map((thread) => thread.id),
        ]),
      );

    return { cloud, save, startAndWait, threadProjectionIds };
  });

export const connectModelPool = (
  cloud: ReturnType<typeof makeMemoryCloud>,
  providers: ReadonlyArray<"claude" | "codex">,
  responder: UpstreamResponder,
) =>
  Effect.gen(function* () {
    yield* UserPools.UserPools.use((pools) => pools.state(actor)).pipe(
      Effect.provide(cloud.userObject(HOOK_USER)),
    );
    const personal = cloud.pools.objectFor(poolName);
    const gateway = installGateway(personal, responder);
    const pool = cloud.pools.directory.forPool(poolName);
    for (const provider of providers) {
      const login = yield* pool.startLogin(actor, provider);
      if (login.user_code !== undefined) {
        if (!personal.cliProxyApi.authorizeDevice(login.user_code))
          return yield* Effect.die(`Could not authorize the ${provider} test account.`);
      } else {
        yield* pool.completeLogin(
          actor,
          `http://localhost/callback?code=test-code&state=${login.state}`,
        );
      }
      yield* pool.loginStatus(actor, login.state);
    }
    return { personal, gateway };
  });

export const promptOf = ({ path, body }: CapturedRequest) =>
  path === "/v1/messages"
    ? ((body.messages as Array<{ readonly content: string }>)[0]?.content ?? "")
    : String(body.input ?? "");
