import type { AutomationRow, WorkflowStore } from "@signalbox/automations/WorkflowStore";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";

import { makeBlockLibrary } from "@signalbox/automations/blockLibrary";

const row = (input: {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
  readonly enabled?: boolean;
  readonly version?: number;
  readonly draftVersion?: number | null;
  readonly runtimeMode?: "approval-required" | "full-access";
  readonly builtinSlug?: string | null;
}): AutomationRow => ({
  automation_id: input.id,
  name: input.name,
  description: null,
  enabled: input.enabled === false ? 0 : 1,
  version: input.version ?? 1,
  project_id: input.projectId,
  defaults_json: JSON.stringify({
    modelSelection: null,
    runtimeMode: input.runtimeMode ?? "approval-required",
    interactionMode: "default",
  }),
  triggers_json: "[]",
  webhook_token: "",
  next_run_at: null,
  created_at: "2026-10-18T00:00:00.000Z",
  updated_at: "2026-10-18T00:00:00.000Z",
  timeout_ms: null,
  overlap: null,
  intent: null,
  draft_version: input.draftVersion ?? null,
  webhook_secret_set: 0,
  builtin_slug: input.builtinSlug ?? null,
});

const contract = (schema: Schema.Top) =>
  SchemaRepresentation.toJson(SchemaRepresentation.toRepresentation(schema.ast));

const meta = (description: string, input: Schema.Top, output: Schema.Top) =>
  JSON.stringify({
    name: "unused by lookup",
    description,
    input: contract(input),
    output: contract(output),
  });

describe("automation block library", () => {
  it.effect(
    "keeps the nearest saved winner and reports its selected version and availability",
    () =>
      Effect.gen(function* () {
        const scopes = ["current", "parent", "owner"];
        const rows = new Map<string, ReadonlyArray<AutomationRow>>([
          [
            "current",
            [
              row({
                id: "paused-nearest",
                name: "Shared",
                projectId: "current",
                enabled: false,
                version: 2,
                draftVersion: 3,
                runtimeMode: "full-access",
              }),
              row({
                id: "draft-nearest",
                name: "Draft winner",
                projectId: "current",
                version: 0,
                draftVersion: 5,
              }),
              row({
                id: "privileged-nearest",
                name: "Privileged",
                projectId: "current",
                runtimeMode: "full-access",
              }),
              row({
                id: "materialized-task-done",
                name: "Task done",
                projectId: "current",
                builtinSlug: "task-done",
              }),
            ],
          ],
          [
            "parent",
            [
              row({ id: "parent-shared", name: "Shared", projectId: "parent" }),
              row({ id: "parent-draft", name: "Draft winner", projectId: "parent" }),
              row({
                id: "parent-privileged",
                name: "Privileged",
                projectId: "parent",
                runtimeMode: "approval-required",
              }),
              row({ id: "parent-task-done", name: "Task done", projectId: "parent" }),
              row({ id: "inherited", name: "Inherited", projectId: "parent" }),
            ],
          ],
          ["owner", [row({ id: "owner-only", name: "Owner block", projectId: "owner" })]],
          ["sibling", [row({ id: "sibling-only", name: "Sibling leak", projectId: "sibling" })]],
          [
            "foreign",
            [row({ id: "foreign-only", name: "Foreign owner leak", projectId: "foreign" })],
          ],
        ]);
        const metadata = new Map([
          [
            "paused-nearest@2",
            meta(
              "Live version metadata",
              Schema.Struct({ issue: Schema.String }),
              Schema.Struct({ closed: Schema.Boolean }),
            ),
          ],
          ["paused-nearest@3", meta("Draft version metadata", Schema.String, Schema.Number)],
          [
            "draft-nearest@5",
            meta("Draft only metadata", Schema.Struct({ title: Schema.String }), Schema.String),
          ],
          [
            "parent-task-done@1",
            meta("Saved override", Schema.Struct({ reason: Schema.String }), Schema.String),
          ],
        ]);
        const projectReads: string[] = [];
        const store: Pick<WorkflowStore, "listAutomationsForProject" | "getVersionMeta"> = {
          listAutomationsForProject: (projectId) => {
            projectReads.push(projectId);
            return Effect.succeed(rows.get(projectId) ?? []);
          },
          getVersionMeta: (automationId, version) =>
            Effect.succeed(metadata.get(`${automationId}@${version}`) ?? null),
        };
        const listBlocks = makeBlockLibrary({
          store,
          projects: () => Effect.succeed(scopes),
        });

        const result = yield* listBlocks("current");
        const blocks = new Map(result.blocks.map((block) => [block.name, block]));
        const shared = blocks.get("Shared");
        const draft = blocks.get("Draft winner");
        const privileged = blocks.get("Privileged");
        const taskDone = blocks.get("Task done");
        const builtin = blocks.get("Watch pull request");

        expect(result.projectId).toBe("current");
        expect(shared).toMatchObject({
          source: { type: "folder", projectId: "current" },
          availability: {
            enabled: false,
            hasLiveVersion: true,
            runtimeMode: "full-access",
          },
          description: "Live version metadata",
        });
        expect(SchemaRepresentation.fromJson(shared!.input!).representation._tag).toBe("Objects");
        expect(SchemaRepresentation.fromJson(shared!.output!).representation._tag).toBe("Objects");
        expect(draft).toMatchObject({
          source: { type: "folder", projectId: "current" },
          availability: { enabled: true, hasLiveVersion: false },
          description: "Draft only metadata",
        });
        expect(privileged?.availability.runtimeMode).toBe("full-access");
        expect(taskDone).toMatchObject({
          source: { type: "folder", projectId: "parent" },
          description: "Saved override",
        });
        expect(blocks.get("Inherited")?.source).toEqual({ type: "folder", projectId: "parent" });
        expect(blocks.get("Owner block")?.source).toEqual({ type: "folder", projectId: "owner" });
        expect(blocks.has("Sibling leak")).toBe(false);
        expect(blocks.has("Foreign owner leak")).toBe(false);
        expect(projectReads).toEqual(scopes);
        expect(builtin).toMatchObject({
          source: { type: "builtin", slug: "watch-pull-request" },
          availability: { enabled: true, hasLiveVersion: true, runtimeMode: null },
        });
      }),
  );
});
