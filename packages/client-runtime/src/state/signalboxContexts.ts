import {
  SIGNALBOX_CONTEXTS_WS_METHODS,
  type SignalboxContext,
  type SignalboxContextId,
  type SignalboxContextsSnapshot,
  type SignalboxSection,
  type SignalboxSectionId,
} from "@t3tools/contracts/signalboxContexts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * A Signalbox Cloud user's contexts and sections, for one environment. Only
 * environments advertising `capabilities.signalboxCloud` serve them. Every
 * change, from any of the user's clients, arrives as a fresh snapshot.
 */
export function createSignalboxContextsAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // One section change at a time per environment, so moves land in the order made.
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
  const command = <TTag extends Exclude<keyof typeof SIGNALBOX_CONTEXTS_WS_METHODS, "subscribe">>(
    name: TTag,
  ) =>
    createEnvironmentRpcCommand(runtime, {
      label: `environment-data:signalbox-contexts:${name}`,
      tag: SIGNALBOX_CONTEXTS_WS_METHODS[name],
      scheduler,
      concurrency,
    });
  return {
    snapshot: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:signalbox-contexts:snapshot",
      tag: SIGNALBOX_CONTEXTS_WS_METHODS.subscribe,
    }),
    createSection: command("createSection"),
    renameSection: command("renameSection"),
    moveSection: command("moveSection"),
    deleteSection: command("deleteSection"),
  };
}

export interface SectionNode {
  readonly section: SignalboxSection;
  readonly children: ReadonlyArray<SectionNode>;
}

export interface ContextTree {
  readonly context: SignalboxContext;
  readonly sections: ReadonlyArray<SectionNode>;
}

/** Each context with its sections nested, everything in the snapshot's order. */
export function buildContextTrees(snapshot: SignalboxContextsSnapshot): ReadonlyArray<ContextTree> {
  const childrenOf = new Map<string, Array<SignalboxSection>>();
  for (const section of snapshot.sections) {
    const key = `${section.contextId}\u0000${section.parentId ?? ""}`;
    const siblings = childrenOf.get(key) ?? [];
    siblings.push(section);
    childrenOf.set(key, siblings);
  }
  const nodes = (contextId: string, parentId: string | null): ReadonlyArray<SectionNode> =>
    (childrenOf.get(`${contextId}\u0000${parentId ?? ""}`) ?? []).map((section) => ({
      section,
      children: nodes(contextId, section.id),
    }));
  return snapshot.contexts.map((context) => ({ context, sections: nodes(context.id, null) }));
}

/** Where a section is dropped or nudged to, relative to what's already there. */
export type SectionPlacement =
  | {
      readonly kind: "before" | "after" | "inside";
      readonly targetId: SignalboxSectionId;
    }
  | { readonly kind: "context-end"; readonly contextId: SignalboxContextId };

export type SectionNudge = "up" | "down" | "indent" | "outdent";

export interface SectionMove {
  readonly sectionId: SignalboxSectionId;
  readonly parentId: SignalboxSectionId | null;
  readonly index: number;
}

/**
 * The `moveSection` input that puts a section at `placement`, or null when the
 * placement is invalid (another context, onto itself, or below itself) or
 * changes nothing.
 */
export function sectionMoveFor(
  snapshot: SignalboxContextsSnapshot,
  sectionId: SignalboxSectionId,
  placement: SectionPlacement,
): SectionMove | null {
  const byId = new Map(snapshot.sections.map((section) => [section.id, section]));
  const section = byId.get(sectionId);
  if (!section) return null;
  const siblingsUnder = (parentId: SignalboxSectionId | null) =>
    snapshot.sections.filter(
      (candidate) =>
        candidate.contextId === section.contextId &&
        candidate.parentId === parentId &&
        candidate.id !== section.id,
    );
  const resolve = (): { parentId: SignalboxSectionId | null; index: number } | null => {
    if (placement.kind === "context-end") {
      if (placement.contextId !== section.contextId) return null;
      return { parentId: null, index: siblingsUnder(null).length };
    }
    const target = byId.get(placement.targetId);
    if (!target || target.contextId !== section.contextId) return null;
    // Never into itself or anything below it.
    for (let cursor: SignalboxSection | undefined = target; cursor;) {
      if (cursor.id === section.id) return null;
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
    }
    if (placement.kind === "inside") {
      return { parentId: target.id, index: siblingsUnder(target.id).length };
    }
    const siblings = siblingsUnder(target.parentId);
    const at = siblings.findIndex((candidate) => candidate.id === target.id);
    return { parentId: target.parentId, index: placement.kind === "before" ? at : at + 1 };
  };
  const resolved = resolve();
  if (!resolved) return null;
  const current = snapshot.sections
    .filter(
      (candidate) =>
        candidate.contextId === section.contextId && candidate.parentId === section.parentId,
    )
    .findIndex((candidate) => candidate.id === section.id);
  if (resolved.parentId === section.parentId && resolved.index === current) return null;
  return { sectionId, ...resolved };
}

/**
 * Keyboard-style outline moves: past the neighbouring sibling, into the
 * previous sibling (at its end), or out to just after the parent.
 */
export function sectionNudgeFor(
  snapshot: SignalboxContextsSnapshot,
  sectionId: SignalboxSectionId,
  nudge: SectionNudge,
): SectionMove | null {
  const section = snapshot.sections.find((candidate) => candidate.id === sectionId);
  if (!section) return null;
  const siblings = snapshot.sections.filter(
    (candidate) =>
      candidate.contextId === section.contextId && candidate.parentId === section.parentId,
  );
  const at = siblings.findIndex((candidate) => candidate.id === section.id);
  const previous = siblings[at - 1];
  const next = siblings[at + 1];
  switch (nudge) {
    case "up":
      return previous
        ? sectionMoveFor(snapshot, sectionId, { kind: "before", targetId: previous.id })
        : null;
    case "down":
      return next
        ? sectionMoveFor(snapshot, sectionId, { kind: "after", targetId: next.id })
        : null;
    case "indent":
      return previous
        ? sectionMoveFor(snapshot, sectionId, { kind: "inside", targetId: previous.id })
        : null;
    case "outdent":
      return section.parentId === null
        ? null
        : sectionMoveFor(snapshot, sectionId, { kind: "after", targetId: section.parentId });
  }
}
