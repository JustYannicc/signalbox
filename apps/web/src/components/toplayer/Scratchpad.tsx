/**
 * A context's scratchpad (issue #180): your words stay exactly as typed, and
 * the context's agent offers what it thinks you meant underneath, visibly its
 * own. OK turns the note into the agent's work and takes it off the pad;
 * ignoring it leaves a plain note that never becomes a pipeline ask.
 * Private by default; shared projects also get a pad the team can see.
 */
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, LockIcon, UsersIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { contextById } from "./topLayerFixtures";
import { awaitingOk, useTopLayerStore, type NoteState } from "./topLayerStore";

/** PLACEHOLDER for the project agent reading a fresh note. */
function mockInterpretation(text: string): string {
  const trimmed = text.trim().replace(/[?!.]+$/, "");
  const body = trimmed.replace(/^after #\d+ merges,?\s*/i, "");
  return `Turn "${body.charAt(0).toUpperCase()}${body.slice(1)}" into a task.`;
}

export function NoteRow(props: { note: NoteState; showContext?: boolean }) {
  const { note } = props;
  const navigate = useNavigate();
  const confirmNote = useTopLayerStore((state) => state.confirmNote);
  const dismiss = useTopLayerStore((state) => state.dismissInterpretation);
  const context = contextById(note.contextId);
  const agentName = context?.agentName ?? "Your assistant";

  const confirm = () => {
    confirmNote(note.id);
    toastManager.add({
      type: "success",
      title: `Now the ${agentName}'s work`,
      description: note.trigger ? `It starts ${note.trigger}.` : "It's off your scratchpad.",
      ...(context
        ? {
            actionProps: {
              children: "Trace",
              onClick: () =>
                void navigate({ to: "/agent/$agentId", params: { agentId: context.agentId } }),
            },
          }
        : {}),
    });
  };

  return (
    <li className="flex flex-col gap-1.5 py-2.5">
      <div className="flex items-baseline gap-2">
        <p className="min-w-0 flex-1 text-sm text-foreground text-pretty">{note.text}</p>
        {note.author !== "you" ? (
          <span className="shrink-0 text-xs text-muted-foreground">{note.author}</span>
        ) : null}
      </div>
      {props.showContext ? (
        <p className="text-xs text-muted-foreground">{context?.name ?? "Global scratchpad"}</p>
      ) : null}
      {awaitingOk(note) ? (
        <div className="flex flex-col gap-1.5 rounded-lg bg-muted/50 px-2.5 py-2">
          <p className="text-xs text-muted-foreground">{agentName} reads this as</p>
          <p className="text-sm text-muted-foreground text-pretty">
            {note.interpretation}
            {note.trigger ? (
              <span className="ml-1.5 inline-flex rounded-md border border-border px-1.5 text-xs">
                {note.trigger}
              </span>
            ) : null}
          </p>
          <div className="flex gap-1">
            <Button size="xs" variant="outline" onClick={confirm}>
              <CheckIcon />
              OK, do it
            </Button>
            <Button size="xs" variant="ghost-muted" onClick={() => dismiss(note.id)}>
              Not this
            </Button>
          </div>
        </div>
      ) : note.interpretation === null ? (
        <p className="text-xs text-muted-foreground">
          {agentName} isn't sure what this means yet. It'll stay a note.
        </p>
      ) : null}
    </li>
  );
}

export function Scratchpad(props: { contextId: string | null; className?: string }) {
  const context = contextById(props.contextId);
  const [scope, setScope] = useState<"private" | "shared">("private");
  const [draft, setDraft] = useState("");
  const notes = useTopLayerStore((state) => state.notes);
  const addNote = useTopLayerStore((state) => state.addNote);
  const interpret = useTopLayerStore((state) => state.interpret);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);

  const visible = notes.filter(
    (note) => note.contextId === props.contextId && note.scope === scope,
  );

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    const trigger = /after #\d+ merges/i.exec(text)?.[0].toLowerCase();
    const id = `note-${Date.now()}`;
    addNote({
      id,
      contextId: props.contextId,
      scope,
      author: "you",
      text,
      interpretation: null,
      ...(trigger ? { trigger } : {}),
    });
    setDraft("");
    timers.current.push(window.setTimeout(() => interpret(id, mockInterpretation(text)), 1400));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      add();
    }
  };

  return (
    <section aria-label="Scratchpad" className={cn("flex min-h-0 flex-col gap-2", props.className)}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground">Scratchpad</h2>
        {context?.shared ? (
          <div className="flex gap-0.5" role="group" aria-label="Scratchpad scope">
            <Button
              size="xs"
              variant={scope === "private" ? "secondary" : "ghost-muted"}
              aria-pressed={scope === "private"}
              onClick={() => setScope("private")}
            >
              <LockIcon />
              Only you
            </Button>
            <Button
              size="xs"
              variant={scope === "shared" ? "secondary" : "ghost-muted"}
              aria-pressed={scope === "shared"}
              onClick={() => setScope("shared")}
            >
              <UsersIcon />
              Team
            </Button>
          </div>
        ) : (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <LockIcon className="size-3" />
            Only you
          </span>
        )}
      </div>
      <Textarea
        size="sm"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={
          scope === "shared"
            ? "Jot something the team can see"
            : "Jot something, half-formed is fine"
        }
        aria-label="New note"
      />
      {visible.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border overflow-y-auto">
          {visible.map((note) => (
            <NoteRow key={note.id} note={note} />
          ))}
        </ul>
      ) : (
        <p className="py-2 text-xs text-muted-foreground">Nothing here. Enter adds a note.</p>
      )}
    </section>
  );
}
