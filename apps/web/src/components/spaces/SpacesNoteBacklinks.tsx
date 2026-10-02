/**
 * "Referenced in" for a native note: the chats, tasks and projects that point
 * at it. Chats and tasks open their shared page; a project opens its agent.
 */
import { Link } from "@tanstack/react-router";
import { FolderIcon, MessagesSquareIcon, SquareCheckIcon } from "lucide-react";

import type { NoteBacklink } from "./spacesNotes";

const ICON = { chat: MessagesSquareIcon, task: SquareCheckIcon, project: FolderIcon } as const;
const KIND_LABEL = { chat: "Chat", task: "Task", project: "Project" } as const;
const ROW =
  "flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2 text-left text-sm outline-none hover:bg-accent/60 focus-visible:bg-accent";

function BacklinkRow(props: { link: NoteBacklink }) {
  const { link } = props;
  const Icon = ICON[link.kind];
  const body = (
    <>
      <Icon aria-hidden className="size-4 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-foreground">{link.label}</span>
      <span className="text-xs text-muted-foreground">{KIND_LABEL[link.kind]}</span>
    </>
  );
  return link.target.route === "shared" ? (
    <Link
      to="/shared/$threadId"
      params={{ threadId: link.target.threadId }}
      search={{}}
      className={ROW}
    >
      {body}
    </Link>
  ) : (
    <Link
      to="/agent/$agentId"
      params={{ agentId: link.target.agentId }}
      search={{}}
      className={ROW}
    >
      {body}
    </Link>
  );
}

export function SpacesNoteBacklinks(props: { backlinks: readonly NoteBacklink[] }) {
  return (
    <section aria-labelledby="note-backlinks" className="mt-14 border-t border-border pt-5">
      <h2 id="note-backlinks" className="text-sm font-medium text-foreground">
        Referenced in
      </h2>
      {props.backlinks.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Nothing yet. Mention this page in a chat or task and it shows up here.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-px">
          {props.backlinks.map((link) => (
            <li key={`${link.kind}:${link.label}`}>
              <BacklinkRow link={link} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
