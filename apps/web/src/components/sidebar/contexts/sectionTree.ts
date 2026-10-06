/**
 * Shared state for one cloud environment's section tree: the latest snapshot,
 * the section commands, and the per-device view state (rename, drag, folds).
 */
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
} from "@t3tools/client-runtime/state/runtime";
import {
  type SectionMove,
  type SectionPlacement,
  sectionMoveFor,
} from "@t3tools/client-runtime/state/signalboxContexts";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  type SignalboxContextId,
  type SignalboxContextsSnapshot,
  SIGNALBOX_SECTION_NAME_MAX_LENGTH,
  type SignalboxSectionId,
  SignalboxSectionId as SectionIdSchema,
} from "@t3tools/contracts/signalboxContexts";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { createContext, use, useCallback, useMemo, useState } from "react";

import { useLocalStorage } from "../../../hooks/useLocalStorage";
import { randomUUID } from "../../../lib/utils";
import { signalboxContexts } from "../../../state/signalboxContexts";
import { useAtomCommand } from "../../../state/use-atom-command";
import { resolveRenameCommit } from "../../chat/ChatHeader";
import { toastManager } from "../../ui/toast";

const NEW_SECTION_NAME = "New section";

/**
 * Folded contexts and sections, on this device only, keyed by environment so
 * Personal in one cloud folds independently of Personal in another.
 */
const COLLAPSED_STORAGE_KEY = "signalbox:sidebar:collapsed-sections:v1";
const CollapsedKeys = Schema.Array(Schema.String);
const NO_COLLAPSED_KEYS: ReadonlyArray<string> = [];

export const contextFoldKey = (contextId: SignalboxContextId) => `context:${contextId}`;

interface DropIndicator {
  readonly targetKey: string;
  readonly kind: SectionPlacement["kind"];
}

function useSectionTreeState(environmentId: EnvironmentId, snapshot: SignalboxContextsSnapshot) {
  const [collapsedKeys, setCollapsedKeys] = useLocalStorage(
    COLLAPSED_STORAGE_KEY,
    NO_COLLAPSED_KEYS,
    CollapsedKeys,
  );
  const foldPrefix = `${environmentId}/`;
  const collapsed = useMemo(
    () =>
      new Set(
        collapsedKeys
          .filter((key) => key.startsWith(foldPrefix))
          .map((key) => key.slice(foldPrefix.length)),
      ),
    [collapsedKeys, foldPrefix],
  );
  const [renamingId, setRenamingId] = useState<SignalboxSectionId | null>(null);
  const [draggingId, setDraggingId] = useState<SignalboxSectionId | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);

  const create = useAtomCommand(signalboxContexts.createSection);
  const rename = useAtomCommand(signalboxContexts.renameSection);
  const move = useAtomCommand(signalboxContexts.moveSection);
  const remove = useAtomCommand(signalboxContexts.deleteSection);

  /** True when the change landed; otherwise tells the user, unless it was just cancelled. */
  const report = useCallback((result: AtomCommandResult<unknown, unknown>) => {
    if (!AsyncResult.isFailure(result)) return true;
    if (isAtomCommandInterrupted(result)) return false;
    toastManager.add({
      type: "error",
      title: "Couldn't update your sections",
      description: "The sidebar shows the latest saved state. Try again.",
    });
    return false;
  }, []);

  const toggleFold = useCallback(
    (key: string) => {
      const scoped = foldPrefix + key;
      setCollapsedKeys((keys) =>
        keys.includes(scoped) ? keys.filter((existing) => existing !== scoped) : [...keys, scoped],
      );
    },
    [foldPrefix, setCollapsedKeys],
  );

  const createSection = useCallback(
    async (contextId: SignalboxContextId, parentId: SignalboxSectionId | null) => {
      const sectionId = SectionIdSchema.make(randomUUID());
      // Unfold the parent so the new row, which opens in rename mode, is visible.
      const parentKey = parentId ?? contextFoldKey(contextId);
      if (collapsed.has(parentKey)) toggleFold(parentKey);
      setRenamingId(sectionId);
      const result = await create({
        environmentId,
        input: { sectionId, contextId, parentId, name: NEW_SECTION_NAME },
      });
      if (!report(result)) {
        setRenamingId((current) => (current === sectionId ? null : current));
      }
    },
    [collapsed, create, environmentId, report, toggleFold],
  );

  const renameSection = useCallback(
    async (sectionId: SignalboxSectionId, name: string) => {
      setRenamingId(null);
      const current = snapshot.sections.find((section) => section.id === sectionId);
      if (!current) return;
      const commit = resolveRenameCommit({ title: name, originalTitle: current.name });
      // An emptied name keeps the old one.
      if (commit.action !== "commit") return;
      report(
        await rename({
          environmentId,
          input: { sectionId, name: commit.title.slice(0, SIGNALBOX_SECTION_NAME_MAX_LENGTH) },
        }),
      );
    },
    [environmentId, rename, report, snapshot.sections],
  );

  const moveSection = useCallback(
    async (input: SectionMove | null) => {
      if (input) report(await move({ environmentId, input }));
    },
    [environmentId, move, report],
  );

  const deleteSection = useCallback(
    async (sectionId: SignalboxSectionId) => {
      report(await remove({ environmentId, input: { sectionId } }));
    },
    [environmentId, remove, report],
  );

  /** The move a drop at `placement` would make, if the dragged section may go there. */
  const dropMove = useCallback(
    (placement: SectionPlacement) =>
      draggingId === null ? null : sectionMoveFor(snapshot, draggingId, placement),
    [draggingId, snapshot],
  );

  return useMemo(
    () => ({
      snapshot,
      collapsed,
      toggleFold,
      renamingId,
      setRenamingId,
      draggingId,
      setDraggingId,
      dropIndicator,
      setDropIndicator,
      dropMove,
      createSection,
      renameSection,
      moveSection,
      deleteSection,
    }),
    [
      snapshot,
      collapsed,
      toggleFold,
      renamingId,
      draggingId,
      dropIndicator,
      dropMove,
      createSection,
      renameSection,
      moveSection,
      deleteSection,
    ],
  );
}

type SectionTreeState = ReturnType<typeof useSectionTreeState>;

export const SectionTreeContext = createContext<SectionTreeState | null>(null);

export { useSectionTreeState };

export function useSectionTree(): SectionTreeState {
  const state = use(SectionTreeContext);
  if (!state) throw new Error("useSectionTree must be used inside a SectionTreeContext");
  return state;
}

/**
 * Top quarter drops before, bottom quarter after, the middle nests inside. An
 * unfolded section's bottom edge sits above its first subsection, so a drop
 * there nests instead of landing after the whole subtree.
 */
export function dropKindAt(
  event: { readonly clientY: number; readonly currentTarget: Element },
  showsChildren: boolean,
): "before" | "after" | "inside" {
  const rect = event.currentTarget.getBoundingClientRect();
  const offset = (event.clientY - rect.top) / Math.max(rect.height, 1);
  if (offset < 0.25) return "before";
  if (offset > 0.75 && !showsChildren) return "after";
  return "inside";
}

export const SECTION_DRAG_MIME = "application/x-signalbox-section";
