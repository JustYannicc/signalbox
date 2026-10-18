import { WorkflowMeta } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const SavedWorkflowMeta = Schema.Struct({
  ...WorkflowMeta.fields,
  // Keep provenance: an edited explicit cron must not donate its old zone to an implicit sibling.
  defaultCronTimezones: Schema.optional(
    Schema.Array(Schema.Struct({ cron: Schema.String, timezone: Schema.String })),
  ),
});

export const withDefaultCronTimezones = (
  meta: WorkflowMeta,
  defaultTimezone: string,
  previous?: typeof SavedWorkflowMeta.Type,
) => {
  const previousDefaults =
    previous?.defaultCronTimezones ??
    previous?.triggers?.flatMap((trigger) =>
      "cron" in trigger && trigger.timezone === undefined
        ? [{ cron: trigger.cron, timezone: "UTC" }]
        : [],
    ) ??
    [];
  const zones = Map.groupBy(previousDefaults, (trigger) => trigger.cron);
  const defaultCronTimezones: Array<{ cron: string; timezone: string }> = [];
  const triggers = meta.triggers?.map((trigger) => {
    if (!("cron" in trigger) || trigger.timezone !== undefined) return trigger;
    const timezone = zones.get(trigger.cron)?.shift()?.timezone ?? defaultTimezone;
    const resolved = { ...trigger, timezone };
    defaultCronTimezones.push(resolved);
    return resolved;
  });
  return { ...meta, triggers, defaultCronTimezones };
};
