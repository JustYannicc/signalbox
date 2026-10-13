/**
 * A folder's unsent drafts, at the top of what it lists. Same row as Home's
 * Drafts group, plus a lock: drafts are only yours, even in a team folder.
 * Rows use T3's warm draft tint. A project's drafts are real T3 drafts and
 * open the draft composer. A section's or the top level's open that level's
 * agent (Appa at the top) with the draft in its composer; the draft stays in
 * its folder until you send or discard it, so clicking around never loses it.
 */
import { LockIcon, SquarePenIcon, XIcon } from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "../../../timestampFormat";
import { useLevelOptions } from "../../levels/LevelOptionsProvider";
import { TOP_LEVEL, type LevelKey } from "../../levels/levels";
import { useSidebar } from "../../ui/sidebar";
import { toastManager } from "../../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { useLevelDraftStore, useLevelDrafts, type LevelDraft } from "./levelDrafts";
import { DRAFT_PEN_CLASS_NAME, DRAFT_SURFACE_CLASS_NAME, ProjectDraftRows } from "../HomeDrafts";

function compactAge(timestamp: string): string {
  const label = formatRelativeTimeLabel(timestamp);
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
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

const LevelDraftRow = memo(function LevelDraftRow(props: {
  draft: LevelDraft;
  /** The level's agent; null at the top level, where Appa takes it. */
  agentId: string | null;
}) {
  const { draft, agentId } = props;
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  // Open while the agent's composer holds exactly this draft.
  const isActive = useLocation({
    select: (location) => (location.search as { prompt?: string }).prompt === draft.text,
  });
  const open = () => {
    if (isMobile) setOpenMobile(false);
    if (agentId) {
      void navigate({ to: "/agent/$agentId", params: { agentId }, search: { prompt: draft.text } });
    } else {
      void navigate({ to: "/assistant", search: { prompt: draft.text } });
    }
  };
  return (
    <li
      className={cn(
        "group/home-draft relative flex h-9 items-center gap-2 rounded-md px-2.5 text-sm",
        isActive
          ? "bg-sidebar-row-selected font-medium text-sidebar-foreground"
          : DRAFT_SURFACE_CLASS_NAME,
      )}
    >
      <button
        type="button"
        aria-current={isActive ? "page" : undefined}
        aria-label={`Draft, only you: ${draft.text}`}
        onClick={open}
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
  const options = useLevelOptions();
  const agentId =
    props.level === TOP_LEVEL
      ? null
      : (options.find((option) => option.key === props.level)?.agentId ?? null);
  return (
    <>
      {props.level.startsWith("project:") ? <ProjectDraftRows level={props.level} /> : null}
      {drafts.map((draft) => (
        <LevelDraftRow key={draft.id} draft={draft} agentId={agentId} />
      ))}
    </>
  );
}
