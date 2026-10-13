/**
 * NOT WIRED UP YET. The "where was I, what's next" note you leave when
 * switching away from deep work, so coming back doesn't mean rebuilding the
 * context. Pulled out of the pipeline (rounds are quick calls, not deep work);
 * where it belongs is open, see the resume-note issue.
 */
import { useState } from "react";

import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

export function ResumeNotePanel(props: {
  contextName: string;
  draft: string;
  onSave: (note: string) => void;
  onLeave: () => void;
  onStay: () => void;
}) {
  const [note, setNote] = useState(props.draft);
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-5 shadow-sm/5">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-base font-semibold">Leaving {props.contextName}</h2>
        <p className="text-sm text-muted-foreground">
          Your drafts stay. Add where your head was, so coming back doesn't mean rebuilding it.
        </p>
      </div>
      <Textarea
        autoFocus
        size="sm"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        aria-label="Resume note"
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => props.onSave(note.trim())} disabled={!note.trim()}>
          Save and leave
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onLeave}>
          Leave without a note
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onStay}>
          Stay
        </Button>
      </div>
    </div>
  );
}
