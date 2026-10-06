import type { AutomationBuiltIn } from "@t3tools/contracts";

import { WATCH_PULL_REQUEST } from "./watchPullRequest.ts";

/**
 * Built-in automations: defaults Signalbox ships in code, so behaviour that
 * would otherwise be special-case server code is an automation anyone can
 * read, run, attach to a thread and customize. They're resolved by name:
 * a project's own automation with the same name wins, which is what
 * Customize makes.
 *
 * To run in a project a built-in needs a host row there (runs, steps and
 * models are per project). That row is marked with the built-in's slug, is
 * re-saved from this code whenever the code changes, and refuses edits, so
 * the code here stays the only source. Customize clears the mark, which
 * makes the row an ordinary automation the project owns.
 */

export interface BuiltInAutomation {
  readonly slug: string;
  /** Its `meta.name`; a test holds the source to it. */
  readonly name: string;
  readonly description: string;
  readonly source: string;
}

export const BUILT_IN_AUTOMATIONS: ReadonlyArray<BuiltInAutomation> = [
  {
    slug: "watch-pull-request",
    name: "Watch pull request",
    description:
      "Watches a thread's pull request, wakes its agent when checks fail or pass or the branch conflicts, and stops when it merges or closes. Run it attached to the thread.",
    source: WATCH_PULL_REQUEST,
  },
];

const ID_PREFIX = "builtin:";

/** The id agents use for a built-in before it runs anywhere: `builtin:<slug>`. */
export const builtInId = (builtIn: BuiltInAutomation) => `${ID_PREFIX}${builtIn.slug}`;

export const builtInById = (id: string) =>
  id.startsWith(ID_PREFIX) ? BUILT_IN_AUTOMATIONS.find((b) => builtInId(b) === id) : undefined;

/** A built-in by its `meta.name`, for `w.start` and runs by name. */
export const builtInByName = (name: string) => BUILT_IN_AUTOMATIONS.find((b) => b.name === name);

/** The built-in a row hosts, when it's a host row. */
export const builtInOfRow = (row: { readonly builtin_slug?: string | null }) =>
  row.builtin_slug ? BUILT_IN_AUTOMATIONS.find((b) => b.slug === row.builtin_slug) : undefined;

export const builtInSummary = (builtIn: BuiltInAutomation): AutomationBuiltIn => ({
  id: builtInId(builtIn),
  name: builtIn.name,
  description: builtIn.description,
});
