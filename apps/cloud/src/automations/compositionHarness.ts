import type { RuntimeMode } from "@t3tools/contracts";
import { compileForCloud } from "@signalbox/automation-compiler/compileForCloud";
import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as Environment from "../environment.ts";
import { makeMemoryCloud } from "../testing.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import * as UserDriveIndex from "../user/UserDriveIndex.ts";
import * as UserFolders from "../user/UserFolders.ts";
import * as CloudCompiler from "./cloudCompiler.ts";

export const COMPOSITION_TEST_USER = "automation_composition_test";
export const CURRENT_DRIVE = "folder/personal/composition-current";
export const PARENT_DRIVE = "folder/personal/composition-parent";
export const ANCESTOR_DRIVE = "folder/personal/composition-ancestor";

export const source = (name: string, body: string, metaFields = "") =>
  `export const meta = { name: ${JSON.stringify(name)}${metaFields ? `, ${metaFields}` : ""} } as const;
export default workflow(async (w, input) => {
  ${body}
});`;

export const makeCompositionHarness = () =>
  Effect.gen(function* () {
    const cloud = makeMemoryCloud();
    yield* cloud.userDirectory
      .forUser(COMPOSITION_TEST_USER)
      .recordSignIn({ id: COMPOSITION_TEST_USER, email: "composition@example.test" });

    const save = (
      workflowSource: string,
      runtimeMode: RuntimeMode = "full-access",
      projectId = Environment.SCRATCH_PROJECT_ID,
    ) =>
      cloud.inUser(
        COMPOSITION_TEST_USER,
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
        COMPOSITION_TEST_USER,
        WorkflowEngine.WorkflowEngine.use((engine) =>
          engine.startRun({ automationId, input, trigger: "manual" }),
        ),
      );

    const waitForTerminal = (runId: string) =>
      cloud.inUser(
        COMPOSITION_TEST_USER,
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
        COMPOSITION_TEST_USER,
        WorkflowEngine.WorkflowEngine.use((engine) => engine.getRun(runId)),
      );

    const childLinks = (parentRunId: string) =>
      cloud.inUser(
        COMPOSITION_TEST_USER,
        SqlClient.SqlClient.use(
          (sql) =>
            sql<{ readonly child_run_id: string; readonly wait: number }>`
            SELECT child_run_id, wait FROM signalbox_automation_children
            WHERE parent_run_id = ${parentRunId}
          `,
        ).pipe(Effect.provide(cloud.userObject(COMPOSITION_TEST_USER))),
      );

    const arrangePersonalFolderChain = () =>
      cloud.inUser(
        COMPOSITION_TEST_USER,
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
        }).pipe(Effect.provide(cloud.userObject(COMPOSITION_TEST_USER))),
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
