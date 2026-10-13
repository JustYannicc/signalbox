import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { WorkflowEngine } from "./WorkflowEngine.ts";
import { DEFAULTS, PROJECT, saveOk, withEngine } from "./WorkflowEngine.testkit.ts";

const source = (body: string, meta = "") =>
  `export const meta = { name: "Report"${meta} } as const;
export default workflow(async (w) => { ${body} });`;

const saveDraft = (code: string) =>
  Effect.gen(function* () {
    const engine = yield* WorkflowEngine;
    const saved = yield* engine.save({
      source: code,
      projectId: PROJECT,
      defaults: DEFAULTS,
      draft: true,
    });
    if (!saved.ok) throw new Error(saved.diagnostics.map((entry) => entry.message).join("\n"));
    return saved.automation;
  });

it.effect("a draft waits beside the live version until it's published or discarded", () =>
  withEngine(
    {},
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const live = yield* saveOk(source(`await w.notify("Say", "v1");`, `, intent: "tell me hi"`));
      expect(live).toMatchObject({ version: 1, draftVersion: null, intent: "tell me hi" });

      const drafted = yield* saveDraft(
        source(`await w.notify("Say", "v2");`, `, triggers: [{ cron: "0 9 * * 1" }]`),
      );
      expect(drafted).toMatchObject({ id: live.id, version: 1, draftVersion: 2, triggers: [] });
      const detail = yield* engine.get(live.id);
      expect(detail.source).toContain("v1");
      expect(detail.draft).toMatchObject({ version: 2 });
      expect(detail.draft?.source).toContain("v2");

      // Runs keep using the live version while the draft waits.
      const run = yield* engine.startRun({ automationId: live.id, trigger: "manual" });
      yield* engine.drain;
      expect((yield* engine.getRun(run.id)).run).toMatchObject({ version: 1, status: "succeeded" });

      const published = yield* engine.publish(live.id);
      expect(published).toMatchObject({ version: 2, draftVersion: null, intent: null });
      expect(published.nextRunAt).not.toBeNull();
      expect((yield* engine.get(live.id)).draft).toBeNull();
      expect((yield* engine.publish(live.id).pipe(Effect.flip)).message).toContain("no draft");

      // Discarding leaves the live version alone, and versions never repeat.
      yield* saveDraft(source(`await w.notify("Say", "v3");`));
      const discarded = yield* engine.discardDraft(live.id);
      expect(discarded).toMatchObject({ version: 2, draftVersion: null });
      expect(yield* saveDraft(source(`await w.notify("Say", "v4");`))).toMatchObject({
        draftVersion: 4,
      });
      // Saving live replaces the pending draft.
      expect(yield* saveOk(source(`await w.notify("Say", "v5");`))).toMatchObject({
        version: 5,
        draftVersion: null,
      });
    }),
  ),
);

it.effect("an automation saved only as a draft stays off until it's published", () =>
  withEngine(
    {},
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const draft = yield* saveDraft(
        source(`await w.notify("Say", "hi");`, `, triggers: [{ cron: "0 9 * * 1" }]`),
      );
      expect(draft).toMatchObject({ version: 0, draftVersion: 1, enabled: false, nextRunAt: null });
      expect((yield* engine.get(draft.id)).source).toContain("hi");

      const refused = yield* engine
        .startRun({ automationId: draft.id, trigger: "manual" })
        .pipe(Effect.flip);
      expect(refused.message).toContain("isn't published");
      expect((yield* engine.setEnabled(draft.id, true).pipe(Effect.flip)).message).toContain(
        "Publish",
      );
      expect((yield* engine.discardDraft(draft.id).pipe(Effect.flip)).message).toContain(
        "never published",
      );

      const published = yield* engine.publish(draft.id);
      expect(published).toMatchObject({ version: 1, draftVersion: null, enabled: true });
      expect(published.nextRunAt).not.toBeNull();
    }),
  ),
);
