import { automationEventMatches, type Automation } from "@t3tools/contracts";

/** The webhook events needed to serve each automation event. */
const EVENT_SOURCES = {
  "pr.opened": ["pull_request"],
  "pr.updated": ["pull_request", "pull_request_review_thread"],
  "pr.merged": ["pull_request"],
  "pr.closed": ["pull_request"],
  "pr.conflicted": ["pull_request"],
  "pr.checks.completed": ["check_run", "check_suite"],
  "pr.checks.passed": ["check_run", "check_suite"],
  "pr.checks.failed": ["check_run", "check_suite"],
  "pr.reviewed": ["pull_request_review"],
  "pr.commented": ["issue_comment", "pull_request_review_comment"],
  "release.published": ["release"],
  "issue.opened": ["issues"],
} as const;

export interface DesiredSubscription {
  readonly projectId: string;
  readonly repository: string;
  readonly events: ReadonlyArray<string>;
}

/** Explicit repository filters take precedence; otherwise the folder's repository is used. */
export function desiredSubscriptions(
  automations: ReadonlyArray<Automation>,
  repositoryOf: (projectId: string) => string | null,
): ReadonlyArray<DesiredSubscription> {
  const desired = new Map<string, { projectId: string; repository: string; events: Set<string> }>();
  for (const automation of automations) {
    if (!automation.enabled) continue;
    for (const trigger of automation.triggers) {
      if (!("on" in trigger) || trigger.watch) continue;
      const patterns = typeof trigger.on === "string" ? [trigger.on] : trigger.on;
      const events = Object.entries(EVENT_SOURCES).flatMap(([name, events]) =>
        patterns.some((pattern) => automationEventMatches(pattern, name)) ? events : [],
      );
      if (events.length === 0) continue;
      const where = trigger.where?.repository;
      const repositories =
        typeof where === "string"
          ? [where]
          : Array.isArray(where)
            ? where.filter((entry): entry is string => typeof entry === "string")
            : [repositoryOf(automation.projectId)].filter(
                (entry): entry is string => entry !== null,
              );
      for (const repository of repositories) {
        const normalized = repository.toLowerCase();
        if (!/^[a-z0-9-]+\/[a-z0-9._-]+$/.test(normalized)) continue;
        const key = `${automation.projectId}/${normalized}`;
        const row = desired.get(key) ?? {
          projectId: automation.projectId,
          repository: normalized,
          events: new Set<string>(),
        };
        for (const event of events) row.events.add(event);
        desired.set(key, row);
      }
    }
  }
  return [...desired.values()].map((row) => ({ ...row, events: [...row.events].sort() }));
}
