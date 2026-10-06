/**
 * Accounts that stopped working, for the attention dot on Usage and the
 * notification that one broke. Only what the user must fix counts: a dead
 * login or a hub that cannot be read. Paused accounts, cooldowns, and a
 * single failed usage read do not; attention is spent only when it is needed.
 *
 * @module limitProblems
 */
import type { EnvironmentId, ServerProvider, UsageLimitSourceId } from "@t3tools/contracts";
import { ACCOUNT_HUB_SOURCE_ID } from "@t3tools/contracts/accountHub";

import { collectLimitAccounts, type LimitPresentations } from "./usageLimits.ts";

export interface LimitProblem {
  /** Stable while the problem lasts, so a notification fires once per problem. */
  readonly key: string;
  readonly environmentId: EnvironmentId;
  /** The hub that reported it; a notifier baselines each source on its first read. */
  readonly sourceId: UsageLimitSourceId;
  readonly driver: ServerProvider["driver"] | null;
  readonly title: string;
  readonly detail: string;
}

export function collectLimitProblems(presentations: LimitPresentations): readonly LimitProblem[] {
  const problems: LimitProblem[] = [];
  for (const account of collectLimitAccounts(presentations)) {
    const hub = account.hubAccount;
    if (!hub?.signedOut || hub.disabled) continue;
    problems.push({
      key: `signed-out:${hub.environmentId}:${hub.sourceId}:${hub.accountId}`,
      environmentId: hub.environmentId,
      sourceId: hub.sourceId,
      driver: account.driver,
      title: "Account signed out",
      detail: `${account.email ?? account.displayName ?? hub.accountId} needs a new sign-in.`,
    });
  }
  for (const [environmentId, presentation] of presentations) {
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      if (!source.error) continue;
      problems.push({
        key: `source:${environmentId}:${source.id}`,
        environmentId,
        sourceId: source.id,
        driver: null,
        title:
          source.id === ACCOUNT_HUB_SOURCE_ID
            ? "The account hub is not working"
            : `${source.label} is not working`,
        detail: source.error,
      });
    }
  }
  return problems;
}
