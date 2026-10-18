import { workflowNodeIdForStepKey, type RuntimeMode } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { compileForCloud } from "@signalbox/automation-compiler/compileForCloud";
import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";
import { HostedRuns, type HostStepRequest } from "@signalbox/automations/runner/hostedDriver";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as Environment from "../environment.ts";
import { makeMemoryCloud } from "../testing.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import * as UserDriveIndex from "../user/UserDriveIndex.ts";
import * as UserFolders from "../user/UserFolders.ts";
import { projectIdForContext, projectIdForDrive } from "../user/contextProjects.ts";
import * as CloudCompiler from "./cloudCompiler.ts";

const USER = "automation_composition_test";
const CURRENT_DRIVE = "folder/personal/composition-current";
const PARENT_DRIVE = "folder/personal/composition-parent";
const ANCESTOR_DRIVE = "folder/personal/composition-ancestor";
const WAITING_PARENT_SOURCE = `export const meta = { name: "Retry holder" } as const;
export default workflow(async (w) => {
  await w.sleep("Hold the run", { days: 1 });
  return null;
});`;

const source = (name: string, body: string, metaFields = "") =>
  `export const meta = { name: ${JSON.stringify(name)}${metaFields ? `, ${metaFields}` : ""} } as const;
export default workflow(async (w, input) => {
  ${body}
});`;

const makeHarness = () =>
  Effect.gen(function* () {
    const cloud = makeMemoryCloud();
    yield* cloud.userDirectory
      .forUser(USER)
      .recordSignIn({ id: USER, email: "composition@example.test" });

    const save = (
      workflowSource: string,
      runtimeMode: RuntimeMode = "full-access",
      projectId = Environment.SCRATCH_PROJECT_ID,
    ) =>
      cloud.inUser(
        USER,
        Effect.gen(function* () {
          const compiled = compileForCloud(workflowSource);
          if (!compiled.ok) return yield* Effect.die(compiled.diagnostics);
          const compiler = yield* CloudCompiler.CloudCompiler;
          const engine = yield* WorkflowEngine.WorkflowEngine;
          const result = yield* compiler.withStaged(
            workflowSource,
            compiled.compiled,
            engine.save({
              source: workflowSource,
              projectId,
              defaults: {
                modelSelection: scriptedModelSelection,
                runtimeMode,
                interactionMode: "default",
              },
            }),
          );
          if (!result.ok) return yield* Effect.die(result.diagnostics);
          return result.automation;
        }),
      );

    const start = (automationId: string, input?: unknown) =>
      cloud.inUser(
        USER,
        WorkflowEngine.WorkflowEngine.use((engine) =>
          engine.startRun({ automationId, input, trigger: "manual" }),
        ),
      );

    const waitForTerminal = (runId: string) =>
      cloud.inUser(
        USER,
        WorkflowEngine.WorkflowEngine.use((engine) =>
          engine.subscribeRun(runId).pipe(
            Stream.filter(({ run }) => run.status !== "running"),
            Stream.take(1),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          ),
        ),
      );

    const startAndWait = (automationId: string, input?: unknown) =>
      Effect.gen(function* () {
        const run = yield* start(automationId, input);
        return yield* waitForTerminal(run.id);
      });

    const getRun = (runId: string) =>
      cloud.inUser(
        USER,
        WorkflowEngine.WorkflowEngine.use((engine) => engine.getRun(runId)),
      );

    const childLinks = (parentRunId: string) =>
      cloud.inUser(
        USER,
        SqlClient.SqlClient.use(
          (sql) =>
            sql<{ readonly child_run_id: string; readonly wait: number }>`
            SELECT child_run_id, wait FROM signalbox_automation_children
            WHERE parent_run_id = ${parentRunId}
          `,
        ).pipe(Effect.provide(cloud.userObject(USER))),
      );

    const arrangePersonalFolderChain = () =>
      cloud.inUser(
        USER,
        Effect.gen(function* () {
          const drives = yield* UserDriveIndex.UserDriveIndex;
          const folders = yield* UserFolders.UserFolders;
          for (const [driveId, name] of [
            [CURRENT_DRIVE, "Composition current"],
            [PARENT_DRIVE, "Composition parent"],
            [ANCESTOR_DRIVE, "Composition ancestor"],
          ] as const) {
            yield* drives.record({ driveId, name, role: "editor", sharedBy: null, revision: 1 });
          }
          const state = yield* folders.state;
          const folderId = (driveId: string) => {
            const folder = state.tree.folders.find((candidate) => candidate.driveId === driveId);
            if (!folder) throw new Error(`Missing folder for ${driveId}`);
            return folder.id;
          };
          yield* folders.move({ id: folderId(PARENT_DRIVE), parentId: folderId(ANCESTOR_DRIVE) });
          yield* folders.move({ id: folderId(CURRENT_DRIVE), parentId: folderId(PARENT_DRIVE) });
        }).pipe(Effect.provide(cloud.userObject(USER))),
      );

    return {
      cloud,
      save,
      start,
      startAndWait,
      waitForTerminal,
      getRun,
      childLinks,
      arrangePersonalFolderChain,
    };
  });

describe("composed automation runs", () => {
  it.effect("waits for the child and returns its validated output", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const child = yield* harness.save(
        source(
          "Echo child",
          `return { echoed: input.value };`,
          `input: Schema.Struct({ value: Schema.String }), output: Schema.Struct({ echoed: Schema.String })`,
        ).replace(
          "export const meta",
          'import * as Schema from "effect/Schema";\nexport const meta',
        ),
      );
      const parent = yield* harness.save(
        source("Parent", `return await w.start("Echo child", input);`),
      );

      const detail = yield* harness.startAndWait(parent.id, { value: "hello" });
      const links = yield* harness.childLinks(detail.run.id);

      expect(detail.run.status).toBe("succeeded");
      expect(detail.output).toEqual({ echoed: "hello" });
      expect(links).toHaveLength(1);
      expect(links[0]?.wait).toBe(1);
      expect(detail.steps[0]?.childRun).toEqual({
        runId: links[0]!.child_run_id,
        automationId: child.id,
      });
      const childRun = yield* harness.getRun(links[0]!.child_run_id);
      expect(childRun.run.automationId).toBe(child.id);
      expect(childRun.input).toEqual({ value: "hello" });
      expect(childRun.output).toEqual({ echoed: "hello" });
    }),
  );

  it.effect("fails the parent with a link when its awaited child fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.save(source("Broken child", `throw new Error("child exploded");`));
      const parent = yield* harness.save(
        source("Failure parent", `return await w.start("Broken child", {});`),
      );

      const detail = yield* harness.startAndWait(parent.id);
      const links = yield* harness.childLinks(detail.run.id);

      expect(detail.run.status).toBe("failed");
      expect(detail.run.error).toContain("Child automation failed");
      expect(links).toHaveLength(1);
      expect(detail.steps[0]?.childRun).toEqual({
        runId: links[0]!.child_run_id,
        automationId: (yield* harness.getRun(links[0]!.child_run_id)).run.automationId,
      });
      expect(detail.steps[0]?.errorDetail?.link).toBeNull();
      const childRun = yield* harness.getRun(links[0]!.child_run_id);
      expect(childRun.run.status).toBe("failed");
      expect(childRun.run.error).toContain("child exploded");
    }),
  );

  it.effect("returns a child run id immediately when wait is false", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.save(
        source(
          "Long child",
          `await w.sleep("Stay open", { days: 1 });
         return "finished";`,
        ),
      );
      const parent = yield* harness.save(
        source("Fire and forget", `return await w.start("Long child", input, { wait: false });`),
      );

      const detail = yield* harness.startAndWait(parent.id, { task: "later" });
      const result = detail.output;
      if (typeof result !== "object" || result === null || !("runId" in result))
        return yield* Effect.die("wait:false did not return a child run id");
      const childRunId = result.runId;
      if (typeof childRunId !== "string")
        return yield* Effect.die("wait:false returned a malformed child run id");
      const links = yield* harness.childLinks(detail.run.id);
      const childRun = yield* harness.getRun(childRunId);

      expect(detail.run.status).toBe("succeeded");
      expect(links).toEqual([{ child_run_id: childRunId, wait: 0 }]);
      expect(detail.steps[0]?.childRun?.runId).toBe(childRunId);
      expect(childRun.run.status).toBe("running");
      expect(childRun.input).toEqual({ task: "later" });
      yield* harness.cloud.inUser(
        USER,
        WorkflowEngine.WorkflowEngine.use((engine) => engine.cancelRun(childRunId)),
      );
    }),
  );

  it.effect("keeps one child when the backend delivers the same running start step twice", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const child = yield* harness.save(source("Raced child", `return input;`));
      const parent = yield* harness.save(WAITING_PARENT_SOURCE);
      const parentRun = yield* harness.start(parent.id);
      yield* harness.cloud.workflows.idle;

      const request: HostStepRequest = {
        key: "same-start-step",
        verb: "start",
        label: "Start child",
        args: ["Raced child", { value: 7 }, { wait: false }],
      };
      yield* harness.cloud.inUser(
        USER,
        SqlClient.SqlClient.use(
          (sql) =>
            sql`
            INSERT INTO signalbox_automation_steps (
              run_id, step_key, node_id, verb, label, status, args_json, started_at
            ) VALUES (
              ${parentRun.id}, ${request.key}, ${workflowNodeIdForStepKey(request.key)},
              ${request.verb}, ${request.label}, 'running', ${JSON.stringify(request.args)},
              '2026-10-18T12:00:00.000Z'
            )
          `,
        ).pipe(Effect.provide(harness.cloud.userObject(USER))),
      );

      const answers = yield* harness.cloud.inUser(
        USER,
        HostedRuns.use((hosted) =>
          Effect.all(
            [hosted.step(parentRun.id, request, []), hosted.step(parentRun.id, request, [])],
            { concurrency: "unbounded" },
          ),
        ),
      );
      const runIds = answers.map((answer) => {
        if (answer.type !== "done" || typeof answer.value !== "object" || answer.value === null)
          return null;
        if (!("runId" in answer.value) || typeof answer.value.runId !== "string") return null;
        return answer.value.runId;
      });
      const links = yield* harness.childLinks(parentRun.id);
      const childRuns = yield* harness.cloud.inUser(
        USER,
        SqlClient.SqlClient.use(
          (sql) =>
            sql<{ readonly run_id: string; readonly automation_id: string }>`
            SELECT run_id, automation_id FROM signalbox_automation_runs
            WHERE parent_run_id = ${parentRun.id}
          `,
        ).pipe(Effect.provide(harness.cloud.userObject(USER))),
      );

      expect(runIds[0]).toBeTruthy();
      expect(runIds[0]).toBe(runIds[1]);
      expect(links).toEqual([{ child_run_id: runIds[0], wait: 0 }]);
      expect(childRuns).toEqual([{ run_id: runIds[0], automation_id: child.id }]);
      expect(
        (yield* harness.getRun(parentRun.id)).steps.find((step) => step.key === request.key)
          ?.childRun,
      ).toEqual({ runId: runIds[0], automationId: child.id });
      yield* harness.cloud.inUser(
        USER,
        WorkflowEngine.WorkflowEngine.use((engine) => engine.cancelRun(parentRun.id)),
      );
    }),
  );

  it.effect("preserves the enabled and access checks when starting a child", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const paused = yield* harness.save(source("Paused child", `return null;`));
      yield* harness.cloud.inUser(
        USER,
        WorkflowEngine.WorkflowEngine.use((engine) => engine.setEnabled(paused.id, false)),
      );
      const pausedParent = yield* harness.save(
        source("Paused parent", `return await w.start("Paused child", null);`),
      );
      const pausedRun = yield* harness.startAndWait(pausedParent.id);
      expect(pausedRun.run.status).toBe("failed");
      expect(pausedRun.run.error).toContain("is paused");
      expect(yield* harness.childLinks(pausedRun.run.id)).toEqual([]);

      yield* harness.save(source("Elevated child", `return null;`));
      const limitedParent = yield* harness.save(
        source("Limited parent", `return await w.start("Elevated child", null);`),
        "approval-required",
      );
      const limitedRun = yield* harness.startAndWait(limitedParent.id);
      expect(limitedRun.run.status).toBe("failed");
      expect(limitedRun.run.error).toContain("more than this automation's approval-required");
      expect(yield* harness.childLinks(limitedRun.run.id)).toEqual([]);
    }),
  );

  it.effect("stops a nested start at the configured depth", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const names = ["Depth A", "Depth B", "Depth C", "Depth D", "Depth E", "Depth F", "Depth G"];
      let firstId: string | undefined;
      for (let index = 0; index < names.length; index++) {
        const next = names[index + 1];
        const body = next
          ? `return await w.start(${JSON.stringify(next)}, input);`
          : `return "too deep";`;
        const saved = yield* harness.save(source(names[index]!, body));
        if (index === 0) firstId = saved.id;
      }
      if (!firstId) return yield* Effect.die("The first depth test automation wasn't saved.");
      const detail = yield* harness.startAndWait(firstId);

      expect(detail.run.status).toBe("failed");
      expect(detail.run.error).toContain("nested 5 automations deep");
    }),
  );

  it.effect("waits through a child restart and returns the final output", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.save(
        source(
          "Restarting child",
          `if (input.pass === 0) return w.restart({ pass: 1 });
         return { pass: input.pass, result: "final" };`,
        ),
      );
      const parent = yield* harness.save(
        source("Restart parent", `return await w.start("Restarting child", { pass: 0 });`),
      );

      const detail = yield* harness.startAndWait(parent.id);
      const links = yield* harness.childLinks(detail.run.id);
      const childRun = yield* harness.getRun(links[0]!.child_run_id);
      const chain = yield* harness.cloud.inUser(
        USER,
        SqlClient.SqlClient.use(
          (sql) =>
            sql<{ readonly run_id: string; readonly output_json: string | null }>`
            SELECT run_id, output_json FROM signalbox_automation_runs
            WHERE parent_run_id = ${detail.run.id}
          `,
        ).pipe(Effect.provide(harness.cloud.userObject(USER))),
      );
      const linkedRun = chain.find((candidate) => candidate.run_id === links[0]?.child_run_id);
      const intermediate = chain.find((candidate) => candidate.run_id !== links[0]?.child_run_id);

      expect(detail.run.status).toBe("succeeded");
      expect(detail.output).toEqual({ pass: 1, result: "final" });
      expect(chain).toHaveLength(2);
      expect(links).toHaveLength(1);
      expect(detail.steps[0]?.childRun?.runId).toBe(links[0]!.child_run_id);
      expect(linkedRun).toBeDefined();
      expect(JSON.parse(linkedRun!.output_json!)).toEqual(detail.output);
      expect(JSON.parse(intermediate!.output_json!)).toHaveProperty("restartedAs");
      expect(childRun.output).toEqual(detail.output);
    }),
  );

  it.effect("rejects child input and output that violate their contracts", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const contractImport = 'import * as Schema from "effect/Schema";\n';
      const inputChild = yield* harness.save(
        contractImport +
          source(
            "String input child",
            `return input.value;`,
            `input: Schema.Struct({ value: Schema.String })`,
          ),
      );
      const invalidTopLevelStart = yield* Effect.exit(harness.start(inputChild.id, { value: 42 }));
      const topLevelDetails = yield* harness.cloud.inUser(
        USER,
        WorkflowEngine.WorkflowEngine.use((engine) => engine.get(inputChild.id)),
      );
      expect(invalidTopLevelStart._tag).toBe("Failure");
      expect(topLevelDetails.runs).toEqual([]);
      const badInputParent = yield* harness.save(
        source("Bad input parent", `return await w.start("String input child", { value: 42 });`),
      );
      const badInput = yield* harness.startAndWait(badInputParent.id);

      expect(badInput.run.status).toBe("failed");
      expect(badInput.run.error).toContain("Input doesn't match meta.input");
      expect(yield* harness.childLinks(badInput.run.id)).toEqual([]);

      yield* harness.save(
        contractImport + source("String output child", `return 42;`, `output: Schema.String`),
      );
      const badOutputParent = yield* harness.save(
        source("Bad output parent", `return await w.start("String output child", null);`),
      );
      const badOutput = yield* harness.startAndWait(badOutputParent.id);
      const links = yield* harness.childLinks(badOutput.run.id);

      expect(badOutput.run.status).toBe("failed");
      expect(badOutput.run.error).toContain("Output doesn't match meta.output");
      expect(links).toHaveLength(1);
      const childRun = yield* harness.getRun(links[0]!.child_run_id);
      expect(childRun.run.status).toBe("failed");
      expect(childRun.run.error).toContain("Output doesn't match meta.output");
    }),
  );

  it.effect(
    "validates child output against the version it started when a newer version is saved",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const contractImport = 'import * as Schema from "effect/Schema";\n';
        const childSource = (body: string, output: string) =>
          contractImport + source("Versioned child", body, `output: ${output}`);
        const child = yield* harness.save(
          childSource(
            `await w.waitFor("Wait for release", { event: "composition.release" });
         return "version 1";`,
            "Schema.String",
          ),
        );
        const parent = yield* harness.save(
          source("Pinned child parent", `return await w.start("Versioned child", null);`),
        );
        const parentRun = yield* harness.start(parent.id);
        yield* harness.cloud.settle;
        const parentWaiting = yield* harness.getRun(parentRun.id);
        const childRunId = parentWaiting.steps[0]?.childRun?.runId;
        if (!childRunId) return yield* Effect.die("The parent did not record its child run.");
        const waitingChild = yield* harness.getRun(childRunId);
        const wait = waitingChild.steps.find((step) => step.verb === "waitFor");
        if (!wait) return yield* Effect.die("The child did not reach its named event wait.");

        yield* harness.save(childSource(`return 2;`, "Schema.Number"));
        yield* harness.cloud.inUser(
          USER,
          WorkflowEngine.WorkflowEngine.use((engine) =>
            engine.emit({ event: "composition.release" }),
          ),
        );
        yield* harness.cloud.settle;
        const done = yield* harness.waitForTerminal(parentRun.id);
        const finishedChild = yield* harness.getRun(childRunId);
        const liveChild = yield* harness.cloud.inUser(
          USER,
          WorkflowEngine.WorkflowEngine.use((engine) => engine.get(child.id)),
        );

        expect([done.run.status, done.output]).toEqual(["succeeded", "version 1"]);
        expect([finishedChild.run.version, finishedChild.run.status, finishedChild.output]).toEqual(
          [1, "succeeded", "version 1"],
        );
        expect(liveChild.automation.version).toBe(2);
      }),
  );

  it.effect("resolves local, nearest parent, ancestor, and owner blocks before built-ins", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.arrangePersonalFolderChain();
      const currentProject = projectIdForDrive(CURRENT_DRIVE);
      const parentProject = projectIdForDrive(PARENT_DRIVE);
      const ancestorProject = projectIdForDrive(ANCESTOR_DRIVE);
      const ownerProject = projectIdForContext(PERSONAL_CONTEXT_ID);
      const current = yield* harness.save(
        source("Lookup target", `return "current";`),
        "full-access",
        currentProject,
      );
      const nearest = yield* harness.save(
        source("Lookup target", `return "parent";`),
        "full-access",
        parentProject,
      );
      const ancestor = yield* harness.save(
        source("Lookup target", `return "ancestor";`),
        "full-access",
        ancestorProject,
      );
      const owner = yield* harness.save(
        source("Lookup target", `return "owner";`),
        "full-access",
        ownerProject,
      );
      const parent = yield* harness.save(
        source("Lookup parent", `return await w.start("Lookup target", input);`),
        "full-access",
        currentProject,
      );

      const expectTarget = (value: string) =>
        Effect.gen(function* () {
          const detail = yield* harness.startAndWait(parent.id);
          expect([detail.run.status, detail.output]).toEqual(["succeeded", value]);
        });
      yield* expectTarget("current");
      yield* harness.cloud.inUser(
        USER,
        WorkflowEngine.WorkflowEngine.use((engine) => engine.remove(current.id)),
      );
      yield* expectTarget("parent");
      yield* harness.cloud.inUser(
        USER,
        WorkflowEngine.WorkflowEngine.use((engine) => engine.remove(nearest.id)),
      );
      yield* expectTarget("ancestor");
      yield* harness.cloud.inUser(
        USER,
        WorkflowEngine.WorkflowEngine.use((engine) => engine.remove(ancestor.id)),
      );
      yield* expectTarget("owner");
      yield* harness.cloud.inUser(
        USER,
        WorkflowEngine.WorkflowEngine.use((engine) => engine.remove(owner.id)),
      );

      const builtinRun = yield* harness.cloud.inUser(
        USER,
        WorkflowEngine.WorkflowEngine.use((engine) =>
          engine.startRun({
            automationId: "builtin:wait-for",
            projectId: currentProject,
            builtInDefaults: {
              modelSelection: scriptedModelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
            },
            input: {
              threadId: "composition-lookup-test",
              until: "a release",
              on: "thread.created",
              where: { threadId: "composition-lookup-test" },
            },
            trigger: "manual",
          }),
        ),
      );
      yield* harness.cloud.workflows.idle;
      const builtinHost = yield* harness.getRun(builtinRun.id);
      const builtinId = builtinHost.run.automationId;
      const builtinDetails = yield* harness.cloud.inUser(
        USER,
        WorkflowEngine.WorkflowEngine.use((engine) => engine.get(builtinId)),
      );
      expect(builtinHost.run.status).toBe("running");
      expect(builtinHost.steps.find((step) => step.verb === "waitFor")?.status).toBe("waiting");
      expect(builtinDetails.automation.builtIn).toBe(true);
      yield* harness.cloud.inUser(
        USER,
        WorkflowEngine.WorkflowEngine.use((engine) => engine.cancelRun(builtinRun.id)),
      );

      const inheritedWait = yield* harness.save(
        source("Wait for", `return "inherited wait block";`),
        "full-access",
        ancestorProject,
      );
      const waitParent = yield* harness.save(
        source(
          "Lookup wait-for",
          `return await w.start("Wait for", {
            threadId: "composition-lookup-test",
            until: "a release",
            on: "thread.created",
            where: { threadId: "composition-lookup-test" }
          }, { wait: false });`,
        ),
        "full-access",
        currentProject,
      );
      const inherited = yield* harness.startAndWait(waitParent.id);
      const inheritedChildId = (inherited.output as { readonly runId: string }).runId;
      const inheritedChild = yield* harness.getRun(inheritedChildId);
      expect(inherited.output).toEqual({ runId: inheritedChildId });
      expect(inheritedChild.output).toBe("inherited wait block");
      expect(inheritedChild.run.automationId).toBe(inheritedWait.id);
      yield* harness.cloud.inUser(
        USER,
        WorkflowEngine.WorkflowEngine.use((engine) => engine.remove(inheritedWait.id)),
      );

      const fallback = yield* harness.startAndWait(waitParent.id);
      const fallbackChildId = (fallback.output as { readonly runId: string }).runId;
      const fallbackChild = yield* harness.getRun(fallbackChildId);
      expect(fallback.run.status).toBe("succeeded");
      expect(fallbackChild.run.status).toBe("running");
      expect(fallbackChild.run.automationId).toBe(builtinId);
      yield* harness.cloud.inUser(
        USER,
        WorkflowEngine.WorkflowEngine.use((engine) => engine.cancelRun(fallbackChildId)),
      );
    }),
  );

  it.effect("rejects invalid input from restart before creating a continuation", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const sourceWithInput =
        'import * as Schema from "effect/Schema";\n' +
        source(
          "Invalid restart input",
          `if (input.pass === 0) return w.restart({ pass: "wrong" });
           return input.pass;`,
          `input: Schema.Struct({ pass: Schema.Number })`,
        );
      const automation = yield* harness.save(sourceWithInput);

      const detail = yield* harness.startAndWait(automation.id, { pass: 0 });
      const saved = yield* harness.cloud.inUser(
        USER,
        WorkflowEngine.WorkflowEngine.use((engine) => engine.get(automation.id)),
      );

      expect(detail.run.status).toBe("failed");
      expect(detail.run.error).toContain("Input doesn't match meta.input");
      expect(saved.runs).toHaveLength(1);
    }),
  );

  it.effect("cancels an awaited child when its parent is cancelled", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.save(
        source(
          "Cancellable child",
          `await w.waitFor("Wait to be cancelled", { event: "composition.cancel.release" });
         return "finished";`,
        ),
      );
      const parent = yield* harness.save(
        source("Cancellable parent", `return await w.start("Cancellable child", null);`),
      );
      const started = yield* harness.start(parent.id);
      yield* harness.cloud.settle;
      const waitingParent = yield* harness.getRun(started.id);
      const childRunId = waitingParent.steps[0]?.childRun?.runId;
      if (!childRunId) return yield* Effect.die("The parent did not record its awaited child.");
      const waitingChild = yield* harness.getRun(childRunId);
      expect(waitingParent.run.status).toBe("running");
      expect(waitingParent.steps[0]?.status).toBe("waiting");
      expect(waitingChild.run.status).toBe("running");
      expect(waitingChild.steps[0]?.status).toBe("waiting");

      yield* harness.cloud.inUser(
        USER,
        WorkflowEngine.WorkflowEngine.use((engine) => engine.cancelRun(started.id)),
      );
      const cancelledParent = yield* harness.getRun(started.id);
      const cancelledChild = yield* harness.getRun(childRunId);

      expect(cancelledParent.run.status).toBe("cancelled");
      expect(cancelledChild.run.status).toBe("cancelled");
    }),
  );
});
