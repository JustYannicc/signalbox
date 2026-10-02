/**
 * Home's Drafts group: unsent work, most recently edited first. One row per
 * T3 draft session with content (several per project show separately; a row
 * opens `/draft/$draftId`), plus the New bar's unsent capture (reopens New).
 * The X discards, the same way the Pipeline's draft rows do.
 */
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { useNavigate, useParams } from "@tanstack/react-router";
import { SquarePenIcon, XIcon, ZapIcon } from "lucide-react";
import { memo, useCallback, useMemo, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  composerDraftHasUserContent,
  DraftId,
  useComposerDraftStore,
  type ComposerThreadDraftState,
} from "../../composerDraftStore";
import { cn } from "../../lib/utils";
import { releaseComposerDraftUploads } from "../../lib/composerDraftUploads";
import { useProjects } from "../../state/entities";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { captureDraftHasContent, useCaptureDraftStore } from "../capture/captureDraftStore";
import { openQuickCapture } from "../capture/captureModel";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useSidebar } from "../ui/sidebar";
import { useDraftEditTimes } from "./draftEditTimes";

const SEPARATOR = "\u0000";
// Row key for the New bar's draft; T3 draft ids never collide with it.
const CAPTURE_ROW_KEY = "capture";

function draftPreview(draft: ComposerThreadDraftState | undefined): string {
  if (!draft) return "";
  const firstLine =
    replaceComposerContextReferences(draft.prompt, (occurrence) => occurrence.label)
      .trim()
      .split("\n", 1)[0] ?? "";
  if (firstLine.length > 0) return firstLine.slice(0, 120);
  const attachments =
    Math.max(draft.images.length, draft.persistedAttachments.length) +
    draft.files.length +
    draft.terminalContexts.length +
    draft.previewAnnotations.length +
    draft.reviewComments.length;
  return `${attachments} attachment${attachments === 1 ? "" : "s"}`;
}

function compactAge(timestamp: string): string {
  const label = formatRelativeTimeLabel(timestamp);
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

function discardDraft(rowKey: string) {
  if (rowKey === CAPTURE_ROW_KEY) {
    useCaptureDraftStore.getState().clear();
    return;
  }
  // The /draft/$draftId route sends you home by itself when its draft goes away.
  const draftId = DraftId.make(rowKey);
  releaseComposerDraftUploads(draftId);
  useComposerDraftStore.getState().clearDraftThread(draftId);
}

const HomeDraftRow = memo(function HomeDraftRow(props: {
  rowKey: string;
  preview: string;
  context: string;
  editedAt: string;
  isActive: boolean;
  onOpen: (rowKey: string) => void;
}) {
  const Icon = props.rowKey === CAPTURE_ROW_KEY ? ZapIcon : SquarePenIcon;
  return (
    <li
      className={cn(
        "group/home-draft relative flex h-9 items-center gap-2 rounded-md px-2.5 text-sm",
        props.isActive
          ? "bg-sidebar-row-selected font-medium text-sidebar-foreground"
          : "text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
      )}
    >
      <button
        type="button"
        aria-current={props.isActive ? "page" : undefined}
        aria-label={`Draft in ${props.context}: ${props.preview}`}
        onClick={() => props.onOpen(props.rowKey)}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left outline-hidden after:absolute after:inset-0 after:rounded-md after:ring-ring focus-visible:after:ring-2"
      >
        <Icon aria-hidden className="size-4 shrink-0 opacity-70" />
        <span className="min-w-0 flex-1 truncate">{props.preview}</span>
        <span className="max-w-24 shrink-0 truncate text-xs font-normal text-sidebar-muted-foreground/60">
          {props.context}
        </span>
      </button>
      <span className="w-7 shrink-0 text-right text-xs font-normal text-sidebar-muted-foreground/60 tabular-nums group-has-focus-visible/home-draft:opacity-0 group-hover/home-draft:opacity-0 pointer-coarse:hidden">
        {compactAge(props.editedAt)}
      </span>
      <div className="absolute inset-y-0 right-1 z-10 flex items-center opacity-0 group-has-focus-visible/home-draft:opacity-100 group-hover/home-draft:opacity-100 pointer-coarse:opacity-100">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`Discard draft: ${props.preview}`}
                onClick={() => discardDraft(props.rowKey)}
                className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground outline-hidden ring-ring hover:bg-sidebar-row-active hover:text-sidebar-foreground focus-visible:ring-2"
              />
            }
          >
            <XIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">Discard draft</TooltipPopup>
        </Tooltip>
      </div>
    </li>
  );
});

interface DraftRow {
  readonly rowKey: string;
  readonly preview: string;
  readonly context: string;
  readonly editedAt: string;
}

export function HomeDrafts(props: { label: ReactNode }) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const projects = useProjects();
  const editedAtByDraftKey = useDraftEditTimes((state) => state.editedAtByDraftKey);
  const routeDraftId = useParams({
    strict: false,
    select: (params) => {
      const target = resolveThreadRouteTarget(params);
      return target?.kind === "draft" ? target.draftId : null;
    },
  });
  // Encoded as strings so the shallow compare skips re-renders unless a
  // listed draft's project or first line actually changed.
  const encodedDrafts = useComposerDraftStore(
    useShallow((store) => {
      const rows: string[] = [];
      for (const [draftKey, session] of Object.entries(store.draftThreadsByThreadKey)) {
        if (session.promotedTo != null) continue;
        const composer = store.draftsByThreadKey[draftKey];
        if (!composerDraftHasUserContent(composer)) continue;
        rows.push(
          [
            draftKey,
            session.createdAt,
            `${session.environmentId}:${session.projectId}`,
            draftPreview(composer),
          ].join(SEPARATOR),
        );
      }
      return rows;
    }),
  );
  const captureRow = useCaptureDraftStore(
    useShallow((state) => {
      if (!captureDraftHasContent(state)) return null;
      const firstLine = state.text.trim().split("\n", 1)[0] ?? "";
      const preview =
        firstLine.slice(0, 120) ||
        state.tokens.map((token) => token.label).join(", ") ||
        `${state.links.length} link${state.links.length === 1 ? "" : "s"}`;
      // Minute precision: typing in the New bar must not re-render this every keystroke.
      const minute = state.updatedAt ? `${state.updatedAt.slice(0, 16)}:00.000Z` : "";
      return [preview, minute] as const;
    }),
  );

  const rows = useMemo(() => {
    const projectTitleByKey = new Map(
      projects.map((project) => [`${project.environmentId}:${project.id}`, project.title]),
    );
    const list: DraftRow[] = encodedDrafts.map((encoded) => {
      const [rowKey = "", createdAt = "", projectKey = "", preview = ""] = encoded.split(SEPARATOR);
      return {
        rowKey,
        preview,
        context: projectTitleByKey.get(projectKey) ?? "Unknown project",
        editedAt: editedAtByDraftKey[rowKey] ?? createdAt,
      };
    });
    if (captureRow) {
      list.push({
        rowKey: CAPTURE_ROW_KEY,
        preview: captureRow[0],
        context: "New",
        editedAt: captureRow[1],
      });
    }
    return list.toSorted((left, right) => right.editedAt.localeCompare(left.editedAt));
  }, [captureRow, editedAtByDraftKey, encodedDrafts, projects]);

  const openDraft = useCallback(
    (rowKey: string) => {
      if (isMobile) setOpenMobile(false);
      if (rowKey === CAPTURE_ROW_KEY) {
        openQuickCapture({ source: "resume" });
        return;
      }
      void navigate({ to: "/draft/$draftId", params: { draftId: rowKey } });
    },
    [isMobile, navigate, setOpenMobile],
  );

  if (rows.length === 0) return null;

  return (
    <section aria-label="Drafts">
      {props.label}
      <ul className="flex flex-col gap-px">
        {rows.map((row) => (
          <HomeDraftRow
            key={row.rowKey}
            rowKey={row.rowKey}
            preview={row.preview}
            context={row.context}
            editedAt={row.editedAt}
            isActive={row.rowKey === routeDraftId}
            onOpen={openDraft}
          />
        ))}
      </ul>
    </section>
  );
}
