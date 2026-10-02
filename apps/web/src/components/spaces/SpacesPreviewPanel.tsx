/**
 * Read-only preview of one library item: where it came from, a format-aware
 * preview, the file agents read in its place, and ways to use it. Access is
 * the source's own; Spaces never re-shares synced items. Escape or the close
 * button dismisses it.
 */
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, FolderTreeIcon, MessageSquarePlusIcon, XIcon } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { useAssistantIdentity } from "../assistant/assistantIdentity";
import { openQuickCapture } from "../capture/captureModel";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { toastManager } from "../ui/toast";
import { buildSpaceFiles } from "./spacesFiles";
import type { SpacesItemFixture } from "./spacesFixtures";
import { ItemTypeIcon, SourceMark, SyncDot } from "./SpacesGlyphs";
import {
  describeSync,
  findSource,
  formatAge,
  itemConnector,
  SPACES_TYPE_LABEL,
} from "./spacesModel";
import { pullRequestsSearch, usePullRequestsSupported } from "./spacesPullRequests";
import { SpacesRichPreview } from "./SpacesRichPreview";
import { sectionName, type Space } from "./spacesSpace";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function MetaRow(props: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{props.label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5 text-foreground">{props.children}</dd>
    </>
  );
}

export function SpacesPreviewPanel(props: {
  item: SpacesItemFixture;
  space: Space;
  onClose: () => void;
  onShowFile: (itemId: string) => void;
}) {
  const { item, space, onClose } = props;
  const source = findSource(item.source);
  const navigate = useNavigate();
  const assistant = useAssistantIdentity();
  const pullRequestsSupported = usePullRequestsSupported();
  const file = buildSpaceFiles(space, [item]).find((entry) => entry.itemId === item.id);
  // An album is a folder of photo records; point at the folder.
  const agentPath =
    file && item.type === "album" ? file.path.slice(0, file.path.lastIndexOf("/") + 1) : file?.path;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <aside
      aria-label={`Preview of ${item.name}`}
      className="flex w-80 shrink-0 flex-col border-l border-border bg-background max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-10 max-lg:shadow-lg xl:w-96"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border pr-2 pl-4">
        <ItemTypeIcon type={item.type} className="text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
          {SPACES_TYPE_LABEL[item.type]}
        </span>
        <Button size="icon-xs" variant="ghost-muted" aria-label="Close preview" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 p-4">
          <div className="flex flex-col gap-1.5">
            <h2 className="text-base font-semibold text-balance text-foreground">{item.name}</h2>
            <p className="text-xs text-muted-foreground">
              {source?.name} · {item.location}
            </p>
          </div>

          <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
            <MetaRow label="Source">
              <SourceMark connector={itemConnector(item)} />
              <span className="truncate">{source?.name}</span>
            </MetaRow>
            {source && source.sync !== "synced" ? (
              <MetaRow label="Sync">
                <SyncDot state={source.sync} label={describeSync(source)} />
                <span className="truncate">{describeSync(source)}</span>
              </MetaRow>
            ) : null}
            <MetaRow label="Access">
              <span className="truncate">Set in {source?.name}; not shared from Spaces</span>
            </MetaRow>
            <MetaRow label="Owner">
              <span className="truncate">{item.owner}</span>
            </MetaRow>
            <MetaRow label="Updated">
              <span className="truncate">
                {dateFormatter.format(new Date(item.updatedAt))}
                <span className="text-muted-foreground"> · {formatAge(item.updatedAt)}</span>
              </span>
            </MetaRow>
            {item.usedInChats > 0 ? (
              <MetaRow label="Used in">
                <span>
                  {item.usedInChats} {item.usedInChats === 1 ? "chat" : "chats"}
                </span>
              </MetaRow>
            ) : null}
          </dl>

          {item.preview ? (
            <section aria-label="Preview" className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">Preview</h3>
              <SpacesRichPreview preview={item.preview} />
            </section>
          ) : (
            <p className="text-sm leading-relaxed text-foreground">{item.excerpt}</p>
          )}

          {agentPath && file ? (
            <section aria-label="Just Files" className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">Just Files</h3>
              <div className="flex flex-col gap-2 rounded-lg bg-muted px-3 py-2.5">
                <code className="font-mono text-xs break-all text-foreground">{agentPath}</code>
                <p className="text-xs text-muted-foreground">
                  {file.access === "read-write"
                    ? `Read/write. Edits go back to ${file.origin ?? "the source"} through Executor.`
                    : `Read-only. Changes happen in ${file.origin ?? "the source"}.`}
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={() => props.onShowFile(item.id)}>
                <FolderTreeIcon />
                Show in Just Files
              </Button>
            </section>
          ) : null}
        </div>
      </ScrollArea>
      <div className="flex shrink-0 flex-col gap-2 border-t border-border p-3">
        <Button onClick={() => void navigate({ to: "/assistant" })}>Ask {assistant.name}</Button>
        <Button
          variant="outline"
          // Quick capture can't take an attachment yet; start it in the item's section.
          onClick={() =>
            openQuickCapture({
              tokens: [
                {
                  id: `section:${item.space}`,
                  kind: "section",
                  label: sectionName(item.space) ?? space.name,
                },
              ],
            })
          }
        >
          <MessageSquarePlusIcon />
          New chat with this
        </Button>
        {item.pullRequest && pullRequestsSupported ? (
          <Button
            variant="ghost"
            render={
              <Link to="/pull-requests" search={() => pullRequestsSearch(item.pullRequest)} />
            }
          >
            Pull request #{item.pullRequest.number}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          onClick={() =>
            toastManager.add({
              type: "info",
              title: `Opens in ${source?.name ?? "the source"} once sources are live`,
            })
          }
        >
          Open in {source?.name}
          <ArrowUpRightIcon />
        </Button>
      </div>
    </aside>
  );
}
