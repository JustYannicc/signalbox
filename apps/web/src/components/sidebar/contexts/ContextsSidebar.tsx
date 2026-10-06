/**
 * Signalbox Cloud contexts in the Home sidebar: Personal and every work
 * organization at once, each with the user's own sections. Sections sync
 * through the user's cloud object, so every client shows the same tree.
 * Renders nothing until a cloud environment is connected.
 */
import {
  buildContextTrees,
  type ContextTree,
} from "@t3tools/client-runtime/state/signalboxContexts";
import type { EnvironmentId } from "@t3tools/contracts";
import type { SignalboxContextsSnapshot } from "@t3tools/contracts/signalboxContexts";
import { PlusIcon } from "lucide-react";
import type { DragEvent } from "react";
import { useMemo } from "react";

import { useCloudEnvironmentIds, useContextsSnapshot } from "../../../state/signalboxContexts";
import { CollapsibleSectionHeader } from "../../ui/collapsible-section-header";
import { SidebarMenuButton } from "../../ui/sidebar";
import { SectionRow } from "./SectionRow";
import {
  contextFoldKey,
  SectionTreeContext,
  useSectionTree,
  useSectionTreeState,
} from "./sectionTree";

function ContextGroup(props: { tree: ContextTree }) {
  const tree = useSectionTree();
  const { context, sections } = props.tree;
  const foldKey = contextFoldKey(context.id);
  const expanded = !tree.collapsed.has(foldKey);
  const isDropTarget = tree.dropIndicator?.targetKey === foldKey;

  // Dropping on the header moves a section to the end of the context's top level.
  const placement = { kind: "context-end", contextId: context.id } as const;
  const onDragOver = (event: DragEvent<HTMLButtonElement>) => {
    if (!tree.dropMove(placement)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (!isDropTarget) tree.setDropIndicator({ targetKey: foldKey, kind: "context-end" });
  };
  const onDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const move = tree.dropMove(placement);
    tree.setDropIndicator(null);
    tree.setDraggingId(null);
    void tree.moveSection(move);
  };

  return (
    <section aria-label={context.name} className="flex flex-col">
      <CollapsibleSectionHeader
        expanded={expanded}
        tone={isDropTarget ? "accent" : "muted"}
        onClick={() => tree.toggleFold(foldKey)}
        onDragOver={onDragOver}
        onDragLeave={(event) => {
          if (isDropTarget && !event.currentTarget.contains(event.relatedTarget as Node | null)) {
            tree.setDropIndicator(null);
          }
        }}
        onDrop={onDrop}
      >
        {context.name}
      </CollapsibleSectionHeader>
      {expanded ? (
        <>
          <ul className="flex flex-col gap-px">
            {sections.map((node) => (
              <SectionRow key={node.section.id} node={node} depth={0} />
            ))}
          </ul>
          <SidebarMenuButton size="sm" onClick={() => void tree.createSection(context.id, null)}>
            <PlusIcon className="size-3.5" />
            <span>New section</span>
          </SidebarMenuButton>
        </>
      ) : null}
    </section>
  );
}

function EnvironmentContextsTree(props: {
  environmentId: EnvironmentId;
  snapshot: SignalboxContextsSnapshot;
}) {
  const state = useSectionTreeState(props.environmentId, props.snapshot);
  const trees = useMemo(() => buildContextTrees(props.snapshot), [props.snapshot]);
  return (
    <SectionTreeContext value={state}>
      {trees.map((tree) => (
        <ContextGroup key={tree.context.id} tree={tree} />
      ))}
    </SectionTreeContext>
  );
}

function EnvironmentContexts(props: { environmentId: EnvironmentId }) {
  const snapshot = useContextsSnapshot(props.environmentId);
  // Until the first snapshot arrives there is nothing worth a placeholder.
  return snapshot ? (
    <EnvironmentContextsTree environmentId={props.environmentId} snapshot={snapshot} />
  ) : null;
}

export function ContextsSidebar() {
  const environmentIds = useCloudEnvironmentIds();
  if (environmentIds.length === 0) return null;
  return (
    <nav
      aria-label="Contexts"
      className="flex max-h-[45%] shrink-0 flex-col gap-1 overflow-y-auto px-2 pt-2"
    >
      {environmentIds.map((environmentId) => (
        <EnvironmentContexts key={environmentId} environmentId={environmentId} />
      ))}
    </nav>
  );
}
