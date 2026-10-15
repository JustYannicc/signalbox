/**
 * The automations this deploy can run, compiled by the server's real compiler
 * (`scripts/compile-automations.ts`). A run is pinned to the source hash it
 * started on, the way today's engine pins a run to its version row.
 */
import "./installWorkflowGlobal.ts";

import fixAnAlert from "../generated/fix-an-alert.js";
import manifest from "../generated/manifest.json";
import mergeGate from "../generated/merge-gate.js";
import waitFor from "../generated/wait-for.js";
import watchPullRequest from "../generated/watch-pull-request.js";
import type { Definition } from "./guest.ts";

export interface Automation {
  readonly slug: string;
  readonly name: string;
  readonly version: string;
  readonly definition: Definition;
}

const definitions: Record<string, Definition> = {
  "wait-for": waitFor as Definition,
  "watch-pull-request": watchPullRequest as Definition,
  "merge-gate": mergeGate as Definition,
  "fix-an-alert": fixAnAlert as Definition,
};

/** Built-ins by name, the way `w.start` and `w.restart` find them. */
export const automations: ReadonlyMap<string, Automation> = new Map(
  Object.entries(definitions).map(([slug, definition]) => {
    const entry = (manifest as Record<string, { name: string; sourceSha256: string }>)[slug]!;
    return [slug, { slug, name: entry.name, version: entry.sourceSha256, definition }];
  }),
);
