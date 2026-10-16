// @effect-diagnostics nodeBuiltinImport:off - GitHub's side is a real bare repository.
// @effect-diagnostics globalDateInEffect:off - these tests fake `Date` for the object's alarm.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  CommandId,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { compileForCloud } from "@signalbox/automation-compiler/compileForCloud";
import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import { makeRepo } from "../drive/driveTesting.ts";
import { type FakeActionsJob, makeFakeActions } from "../github/actionsTesting.ts";
import { makeFakeGitHub } from "../github/githubTesting.ts";
import { makeMemoryCloud } from "../testing.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import { UserDirectory } from "../user/UserDirectory.ts";
import * as CloudRpc from "../user/rpc.ts";
import { CloudAutomations } from "./CloudAutomations.ts";

/**
 * #372: a `w.run` step with `{ on: "github-actions" }` runs on the folder
 * repository's Actions runners: Signalbox's step workflow is dispatched with
 * the function, the object's alarm reads the run so its jobs and steps show
 * in the step, and the function's result goes on to the next step.
 */

const identity = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };
const userId = "user_1";
const threadId = ThreadId.make("thread-0000ci01");
const REDIRECT = "http://localhost:8787/api/github/callback";

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const SOURCE = `export const meta = { name: "Build on CI" } as const;
function build(target: string) {
  return { built: target, node: process.version };
}
export default workflow(async (w) => {
  const output = await w.run("Build and test", { on: "github-actions", secrets: ["NPM_TOKEN"] }, build, "web");
  await w.notify("Built", output.built);
  return output.built;
});`;

const running: ReadonlyArray<FakeActionsJob> = [
  {
    name: "Build and test",
    status: "in_progress",
    conclusion: null,
    steps: [
      { name: "Set up job", status: "completed", conclusion: "success" },
      { name: "Run the function", status: "in_progress", conclusion: null },
    ],
  },
];
const finished = (conclusion: "success" | "failure"): ReadonlyArray<FakeActionsJob> => [
  {
    name: "Build and test",
    status: "completed",
    conclusion,
    steps: [
      { name: "Set up job", status: "completed", conclusion: "success" },
      { name: "Run the function", status: "completed", conclusion },
    ],
    log: "2026-10-16T10:00:59.1234567Z building web\n2026-10-16T10:01:00.0000000Z done\n",
  },
];

const setup = Effect.gen(function* () {
  const upstream = makeRepo();
  cleanups.push(upstream.cleanup);
  upstream.write("README.md", "hello\n");
  upstream.commit("first");
  upstream.git(["branch", "-m", "main"]);
  const bare = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "actions-bare-"));
  cleanups.push(() => NodeFS.rmSync(bare, { recursive: true, force: true }));
  NodeChildProcess.execFileSync("git", ["clone", "-q", "--bare", upstream.dir, "."], {
    cwd: bare,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  const actions = makeFakeActions("owner/repo");
  const github = makeFakeGitHub({
    bare,
    repository: "owner/repo",
    defaultBranch: "main",
    more: actions.more,
  });
  const cloud = makeMemoryCloud({ github: github.layer });
  const user = cloud.userDirectory.forUser(userId);
  yield* user.recordSignIn({ id: userId, email: "a@b.c" });
  yield* user.beginGitHubConnect({ grantId: "g1", returnTo: REDIRECT });
  github.authorize(userId);
  yield* user.completeGitHubConnect("g1");
  const rpc = yield* RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
    Effect.provide(
      Layer.mergeAll(
        CloudRpc.layerHandlers({ identity, userId, sid: "test-session" }),
        CloudRpc.layerScopeAuthorization([
          AuthOrchestrationReadScope,
          AuthOrchestrationOperateScope,
          AuthSourceControlWriteScope,
        ]),
      ).pipe(Layer.provide(cloud.layerFor(userId))),
    ),
  );
  const imported = yield* rpc[WS_METHODS.projectCloneStart]({
    projectId: ProjectId.make("project-from-the-client"),
    title: "repo",
    createdAt: "2026-10-16T10:00:00.000Z",
    remoteUrl: "https://github.com/owner/repo.git",
    destinationPath: "~/repo",
  });
  yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
    commandId: CommandId.make(`launch-${threadId}`),
    threadId,
    projectId: imported.projectId,
    title: "Set up CI",
    modelSelection: scriptedModelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
  });
  yield* cloud.settle;

  const tool = (name: string, input: unknown) =>
    cloud.inUser(
      userId,
      CloudAutomations.use((automations) => automations.tool({ threadId }, name, input)),
    );
  const engine = <A, E>(use: (engine: WorkflowEngine.WorkflowEngineShape) => Effect.Effect<A, E>) =>
    cloud.inUser(userId, WorkflowEngine.WorkflowEngine.use(use));
  /** Saves SOURCE in the folder and runs it until its step waits on GitHub. */
  const runSource = (source: string) =>
    Effect.gen(function* () {
      const compiled = compileForCloud(source);
      if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
      const saved = (yield* tool("automation_save", {
        source,
        compiled: compiled.compiled,
        projectId: imported.projectId,
      })) as { readonly automation: { readonly automationId: string } };
      const started = (yield* tool("automation_run", {
        automationId: saved.automation.automationId,
      })) as { readonly run: { readonly runId: string } };
      yield* cloud.settle;
      return started.run.runId;
    });
  const run = runSource(SOURCE);
  /** Moves the clock to the object's alarm and lets it go off. */
  const alarm = Effect.gen(function* () {
    const due = cloud.alarmAt(userId);
    if (due === undefined) return expect.unreachable("no alarm is set");
    vi.setSystemTime(due + 1);
    yield* cloud.fireAlarm(userId);
    yield* cloud.settle;
  });
  const step = (runId: string) =>
    engine((engine) => engine.getRun(runId)).pipe(Effect.map((detail) => detail));
  return {
    cloud,
    github,
    actions,
    runSource,
    tool,
    engine,
    run,
    alarm,
    step,
    layers: Layer.mergeAll(cloud.drives.layer, github.layer),
    userDirectory: cloud.userDirectory,
  };
});

const provided = <A, E>(
  test: (context: Effect.Success<typeof setup>) => Effect.Effect<A, E, never>,
) =>
  Effect.gen(function* () {
    vi.useFakeTimers({ toFake: ["Date"] });
    const context = yield* setup;
    return yield* test(context).pipe(
      Effect.provide(context.layers),
      Effect.provideService(UserDirectory, context.userDirectory),
    );
  });

describe("w.run on GitHub Actions", () => {
  it.effect("runs the function on a runner, shows the run live, and passes its result on", () =>
    provided(({ actions, run, alarm, step }) =>
      Effect.gen(function* () {
        const runId = yield* run;

        // Dispatched on the default branch with the function, its module and arguments.
        expect(actions.runs).toHaveLength(1);
        const dispatched = actions.runs[0]!;
        expect(dispatched.ref).toBe("main");
        expect(dispatched.inputs).toMatchObject({ label: "Build and test", environment: "" });
        expect(dispatched.inputs.step).toMatch(new RegExp(`^${runId}/`));
        expect(JSON.parse(dispatched.inputs.payload!)).toMatchObject({
          name: "build",
          args: ["web"],
          secrets: ["NPM_TOKEN"],
          module: expect.stringContaining("export { build };"),
        });
        let detail = yield* step(runId);
        expect(detail.steps[0]).toMatchObject({
          status: "waiting",
          external: { system: "github-actions", scope: "owner/repo", status: "queued" },
        });

        // The runner picks it up: the object's alarm reads its jobs and steps.
        actions.progress(0, running);
        yield* alarm;
        detail = yield* step(runId);
        expect(detail.steps[0]?.external).toMatchObject({
          status: "running",
          jobs: [
            {
              name: "Build and test",
              status: "running",
              steps: [
                { name: "Set up job", status: "succeeded" },
                { name: "Run the function", status: "running" },
              ],
              logTail: null,
            },
          ],
        });

        // It finishes: the result artifact settles the step and the run goes on.
        actions.finish(0, "success", finished("success"), {
          ok: true,
          value: { built: "web", node: "v24.0.0" },
        });
        yield* alarm;
        detail = yield* step(runId);
        expect(detail.run.status).toBe("succeeded");
        expect(detail.output).toBe("web");
        expect(detail.steps[0]).toMatchObject({
          status: "succeeded",
          result: { built: "web", node: "v24.0.0" },
          external: {
            status: "succeeded",
            jobs: [{ status: "succeeded", logTail: "building web\ndone" }],
          },
        });
        expect(detail.steps[1]).toMatchObject({ verb: "notify", status: "succeeded" });
      }),
    ),
  );

  it.effect("fails with the function's error when it throws on the runner", () =>
    provided(({ actions, run, alarm, step }) =>
      Effect.gen(function* () {
        const runId = yield* run;
        actions.finish(0, "failure", finished("failure"), {
          ok: false,
          error: "Error: tests failed",
        });
        yield* alarm;
        const detail = yield* step(runId);
        expect(detail.run.status).toBe("failed");
        expect(detail.steps[0]).toMatchObject({
          status: "failed",
          error: "Error: tests failed",
          errorDetail: { link: "https://github.test/owner/repo/actions/runs/1000" },
        });
      }),
    ),
  );

  it.effect("says how to install the step workflow when the repository has none", () =>
    provided(({ actions, run, step }) =>
      Effect.gen(function* () {
        actions.settings.installed = false;
        const runId = yield* run;
        const detail = yield* step(runId);
        expect(detail.run.status).toBe("failed");
        expect(detail.steps[0]?.error).toContain("doesn't have Signalbox's step workflow");
        expect(detail.steps[0]?.errorDetail?.fix).toContain(".github/workflows/signalbox-step.yml");
      }),
    ),
  );

  it.effect("refuses options a step on GitHub Actions can't use, before dispatching", () =>
    provided(({ actions, runSource, step }) =>
      Effect.gen(function* () {
        const runId = yield* runSource(
          SOURCE.replace('secrets: ["NPM_TOKEN"]', 'secrets: "NPM_TOKEN"'),
        );
        const detail = yield* step(runId);
        expect(detail.steps[0]?.error).toContain("don't fit a step on GitHub Actions");
        expect(actions.runs).toHaveLength(0);
      }),
    ),
  );

  it.effect("stops the run on GitHub when the automation run is cancelled", () =>
    provided(({ actions, run, tool, step, cloud }) =>
      Effect.gen(function* () {
        const runId = yield* run;
        actions.progress(0, running);
        yield* tool("automation_cancel_run", { runId });
        yield* cloud.settle;
        expect(actions.runs[0]).toMatchObject({ status: "completed", conclusion: "cancelled" });
        expect((yield* step(runId)).run.status).toBe("cancelled");
      }),
    ),
  );
});
