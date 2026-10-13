/**
 * A folder's unsent drafts, at the top of what it lists. Same row as Home's
 * Drafts group, plus a lock: drafts are only yours, even in a team folder.
 * Rows use T3's warm draft tint. Opening one resumes it in the New bar with
 * its folder chip (or the composer, for a project's real drafts); X discards.
 */
import { LockIcon, SquarePenIcon, XIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "../../../timestampFormat";
import { useCaptureDraftStore } from "../../capture/captureDraftStore";
import { openQuickCapture } from "../../capture/captureModel";
import type { LevelKey } from "../../levels/levels";
import { useSidebar } from "../../ui/sidebar";
import { toastManager } from "../../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import {
  levelCaptureToken,
  useLevelDraftStore,
  useLevelDrafts,
  type LevelDraft,
} from "./levelDrafts";
import { DRAFT_PEN_CLASS_NAME, DRAFT_SURFACE_CLASS_NAME, ProjectDraftRows } from "../HomeDrafts";

function compactAge(timestamp: string): string {
  const label = formatRelativeTimeLabel(timestamp);
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

function resume(draft: LevelDraft) {
  const capture = useCaptureDraftStore.getState();
  // Only real unsent text or links block it; a lone chip (e.g. @Appa) gets replaced.
  if (capture.text.trim().length > 0 || capture.links.length > 0) {
    toastManager.add({
      type: "info",
      title: "Finish or discard what's in New first",
      timeout: 3000,
    });
    openQuickCapture({ source: "resume" });
    return;
  }
  const token = levelCaptureToken(draft.level);
  capture.restore({
    text: draft.text,
    tokens: token ? [token] : [],
    links: [],
    updatedAt: new Date().toISOString(),
  });
  useLevelDraftStore.getState().remove(draft.id);
  openQuickCapture({ source: "resume" });
}

function discard(draft: LevelDraft) {
  const store = useLevelDraftStore.getState();
  store.remove(draft.id);
  toastManager.add({
    id: `level-draft-${draft.id}`,
    type: "success",
    title: "Draft discarded",
    timeout: 4000,
    actionProps: { children: "Undo", onClick: () => store.restore(draft.id) },
  });
}

const LevelDraftRow = memo(function LevelDraftRow(props: { draft: LevelDraft }) {
  const { draft } = props;
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <li
      className={cn(
        "group/home-draft relative flex h-9 items-center gap-2 rounded-md px-2.5 text-sm",
        DRAFT_SURFACE_CLASS_NAME,
      )}
    >
      <button
        type="button"
        aria-label={`Draft, only you: ${draft.text}`}
        onClick={() => {
          if (isMobile) setOpenMobile(false);
          resume(draft);
        }}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left outline-hidden after:absolute after:inset-0 after:rounded-md after:ring-ring after:ring-inset focus-visible:after:ring-2"
      >
        <SquarePenIcon aria-hidden className={DRAFT_PEN_CLASS_NAME} />
        <span className="min-w-0 flex-1 truncate">{draft.text}</span>
      </button>
      <span className="relative z-10 flex shrink-0 items-center gap-1.5 group-has-focus-visible/home-draft:opacity-0 group-hover/home-draft:opacity-0 pointer-coarse:hidden">
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className="inline-flex text-sidebar-muted-foreground/60"
                aria-label="Only you"
              />
            }
          >
            <LockIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">Draft · only you until you send it</TooltipPopup>
        </Tooltip>
        <span className="w-7 text-right text-xs font-normal text-sidebar-muted-foreground/60 tabular-nums">
          {compactAge(draft.editedAt)}
        </span>
      </span>
      <div className="absolute inset-y-0 right-1 z-10 flex items-center opacity-0 group-has-focus-visible/home-draft:opacity-100 group-hover/home-draft:opacity-100 pointer-coarse:opacity-100">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`Discard draft: ${draft.text}`}
                onClick={() => discard(draft)}
                className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground outline-hidden ring-ring ring-inset hover:bg-sidebar-row-active hover:text-sidebar-foreground focus-visible:ring-2"
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

/** The drafts sitting at `level` (a project's real T3 drafts first); nothing when there are none. */
export function LevelDraftRows(props: { level: LevelKey }) {
  const drafts = useLevelDrafts(props.level);
  return (
    <>
      {props.level.startsWith("project:") ? <ProjectDraftRows level={props.level} /> : null}
      {drafts.map((draft) => (
        <LevelDraftRow key={draft.id} draft={draft} />
      ))}
    </>
  );
}
