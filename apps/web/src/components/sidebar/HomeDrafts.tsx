/**
 * Home's Drafts: every unsent draft with something in it, newest first, so a
 * quick capture (or a draft you walked away from) is one click from its draft
 * page. Renders nothing when there are none.
 */
import { useAtomValue } from "@effect/atom-react";
import { ownerLevelName, threadHomeLookup } from "@t3tools/client-runtime/state/signalboxFolders";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { useNavigate, useParams } from "@tanstack/react-router";
import { SquarePenIcon, XIcon } from "lucide-react";
import { memo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

import {
  composerDraftHasUserContent,
  DraftId,
  useComposerDraftStore,
  type ComposerThreadDraftState,
  type DraftSessionState,
} from "../../composerDraftStore";
import { discardComposerDraft } from "../../lib/discardComposerDraft";
import { cn } from "../../lib/utils";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { folderTreesAtom } from "./folders/folderThreads";

interface DraftRow {
  readonly draftId: DraftId;
  readonly preview: string;
  readonly createdAt: string;
  readonly session: DraftSessionState;
}

function draftPreview(composer: ComposerThreadDraftState): string {
  const firstLine =
    replaceComposerContextReferences(composer.prompt, (occurrence) => occurrence.label)
      .trim()
      .split("\n", 1)[0] ?? "";
  if (firstLine.length > 0) return firstLine;
  // images mirrors persistedAttachments once rehydrated; before that only the persisted list is set.
  const count =
    Math.max(composer.images.length, composer.persistedAttachments.length) +
    composer.files.length +
    composer.terminalContexts.length +
    composer.previewAnnotations.length +
    composer.reviewComments.length;
  return count > 0 ? `${count} attachment${count === 1 ? "" : "s"}` : "Draft";
}

/**
 * Per composer draft, which is replaced on every edit: a keystroke recomputes
 * only the draft it changed, not every draft's whole prompt.
 */
const draftSummaries = new WeakMap<
  ComposerThreadDraftState,
  { readonly listed: boolean; readonly preview: string }
>();

function summarize(composer: ComposerThreadDraftState) {
  let summary = draftSummaries.get(composer);
  if (summary === undefined) {
    const listed = composerDraftHasUserContent(composer);
    summary = { listed, preview: listed ? draftPreview(composer) : "" };
    draftSummaries.set(composer, summary);
  }
  return summary;
}

const sameRows = (left: ReadonlyArray<DraftRow>, right: ReadonlyArray<DraftRow>) =>
  left.length === right.length &&
  left.every(
    (row, index) =>
      row.draftId === right[index]!.draftId &&
      row.preview === right[index]!.preview &&
      row.session === right[index]!.session,
  );

/**
 * The open draft keeps the presence it had when you opened it: a fresh draft
 * doesn't pop in while you type, and one you clear doesn't vanish under you.
 */
function useDraftRows(routeDraftId: string | null): ReadonlyArray<DraftRow> {
  const [frozen, setFrozen] = useState<{ routeDraftId: string | null; listed: boolean }>({
    routeDraftId: null,
    listed: false,
  });
  const routeDraftListed = useComposerDraftStore((store) => {
    const composer = routeDraftId === null ? undefined : store.draftsByThreadKey[routeDraftId];
    return composer !== undefined && composerDraftHasUserContent(composer);
  });
  if (frozen.routeDraftId !== routeDraftId) {
    setFrozen({ routeDraftId, listed: routeDraftListed });
  }
  const previous = useRef<ReadonlyArray<DraftRow>>([]);
  return useComposerDraftStore((store) => {
    const rows: DraftRow[] = [];
    for (const [draftKey, session] of Object.entries(store.draftThreadsByThreadKey)) {
      if (session.promotedTo != null) continue;
      const composer = store.draftsByThreadKey[draftKey];
      if (!composer) continue;
      const summary = summarize(composer);
      const listed =
        draftKey === routeDraftId && frozen.routeDraftId === routeDraftId
          ? frozen.listed
          : summary.listed;
      if (!listed) continue;
      rows.push({
        draftId: DraftId.make(draftKey),
        preview: summary.listed ? summary.preview : draftPreview(composer),
        createdAt: session.createdAt,
        session,
      });
    }
    rows.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    if (sameRows(previous.current, rows)) return previous.current;
    previous.current = rows;
    return rows;
  });
}

/** Where each draft lives, by name: its folder, else its owner's top level. */
function usePlaceName(): (session: DraftSessionState) => string | null {
  const trees = useAtomValue(folderTreesAtom);
  return (session) => {
    const tree = trees.get(session.environmentId);
    if (!tree) return null;
    const home = threadHomeLookup(tree.snapshot)({
      id: session.threadId,
      projectId: session.projectId,
    });
    if (home !== null)
      return tree.snapshot.folders.find((folder) => folder.id === home)?.name ?? null;
    const owner = tree.owners.find((candidate) =>
      candidate.context.projectIds.includes(session.projectId),
    );
    return owner ? ownerLevelName(owner.context) : null;
  };
}

export function HomeDrafts() {
  const routeDraftId = useParams({
    strict: false,
    select: (params) => {
      const target = resolveThreadRouteTarget(params);
      return target?.kind === "draft" ? target.draftId : null;
    },
  });
  const rows = useDraftRows(routeDraftId);
  const placeName = usePlaceName();
  const navigate = useNavigate();
  const openDraft = (draftId: DraftId) =>
    void navigate({ to: "/draft/$draftId", params: { draftId } });
  if (rows.length === 0) return null;
  return (
    <section aria-label="Drafts" className="max-h-[35%] shrink-0 overflow-y-auto px-2 pb-2">
      <h3 className="flex h-8 items-center gap-2 px-2 text-xs font-medium text-sidebar-muted-foreground/70">
        <span className="shrink-0">Drafts</span>
        <span className="tabular-nums">{rows.length}</span>
      </h3>
      <ul className="flex flex-col">
        {rows.map((row) => (
          <DraftRowItem
            key={row.draftId}
            draftId={row.draftId}
            preview={row.preview}
            place={placeName(row.session)}
            active={row.draftId === routeDraftId}
            onOpen={openDraft}
          />
        ))}
      </ul>
    </section>
  );
}

const DraftRowItem = memo(function DraftRowItem(props: {
  readonly draftId: DraftId;
  readonly preview: string;
  readonly place: string | null;
  readonly active: boolean;
  readonly onOpen: (draftId: DraftId) => void;
}) {
  const { draftId, onOpen } = props;
  const handleKeyDown = (event: KeyboardEvent) => {
    // Keys on the nested discard button belong to it.
    if ((event.target as HTMLElement).closest("button")) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(draftId);
    }
  };
  const handleDiscard = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    discardComposerDraft(draftId);
  };
  return (
    <li className="list-none">
      <div
        role="button"
        tabIndex={0}
        aria-label={`${props.preview}, unsent draft${props.place ? ` in ${props.place}` : ""}`}
        aria-current={props.active ? "page" : undefined}
        className={cn(
          "group/draft-row flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md ps-2.5 pe-1 text-left text-sm text-sidebar-foreground outline-hidden select-none ring-ring focus-visible:ring-2 focus-visible:ring-inset",
          props.active ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
        )}
        onClick={() => onOpen(draftId)}
        onKeyDown={handleKeyDown}
      >
        <SquarePenIcon aria-hidden className="size-3.5 shrink-0 text-warning-foreground" />
        <span className="min-w-0 flex-1 truncate">{props.preview}</span>
        {props.place ? (
          <span className="max-w-[40%] shrink-0 truncate text-xs text-sidebar-muted-foreground/70 group-hover/draft-row:hidden group-focus-within/draft-row:hidden">
            {props.place}
          </span>
        ) : null}
        <span className="hidden shrink-0 group-focus-within/draft-row:inline-flex group-hover/draft-row:inline-flex">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost-muted"
                  size="icon-micro"
                  aria-label="Discard draft"
                  onClick={handleDiscard}
                >
                  <XIcon />
                </Button>
              }
            />
            <TooltipPopup side="top">Discard draft</TooltipPopup>
          </Tooltip>
        </span>
      </div>
    </li>
  );
});
