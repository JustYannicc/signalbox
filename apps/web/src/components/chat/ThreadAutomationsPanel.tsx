import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

/**
 * signalbox: main's scheduled tasks are hidden in this fork; Home automations
 * replace them, so a thread lists no scheduled tasks. Kept as an empty mount
 * so `ThreadDetailsPanel` stays as upstream wrote it. The server feature and
 * `settings/ScheduledTasksSettings.tsx` stay for clean upstream merges.
 */
export function ThreadAutomationsPanel(_props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  return null;
}
