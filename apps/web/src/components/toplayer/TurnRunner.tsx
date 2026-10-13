/**
 * The pipeline, entered on purpose (issue #180). One context at a time, its
 * open questions asked together as one round, grilling-style: each with the
 * agent's recommended answer and room to answer in your own words. Sending the
 * round hands it back to the agent and the next context loads by itself; a
 * newly arrived ask never replaces the round you're in. Leaving early keeps
 * your half-written answers. No resume note here: rounds are quick, shallow
 * calls, not deep work (see `ResumeNotePanel` and its issue).
 */
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, SendIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "../ui/button";
import { GO_WITH_RECOMMENDATION, RoundQuestion } from "./AskCard";
import { LiveAvatar, reactAvatar } from "./LiveAvatar";
import { NoteRow, Scratchpad } from "./Scratchpad";
import { ASKS, contextById } from "./topLayerFixtures";
import { useQueue } from "./topLayerHooks";
import { formatMinutes } from "./topLayerQueue";
import { awaitingOk, useTopLayerStore } from "./topLayerStore";

interface PinnedTurn {
  readonly contextId: string;
  readonly askIds: readonly string[];
}

/**
 * The authored moment: a new round settles in from slightly below. A callback
 * ref, so it runs once per mounted (keyed) element.
 */
function settleIn(element: HTMLDivElement | null) {
  if (!element || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  element.animate(
    [
      { opacity: 0, transform: "translateY(10px)", filter: "blur(3px)" },
      { opacity: 1, transform: "none", filter: "none" },
    ],
    { duration: 380, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
  );
}

function AllDone(props: { receiptLine: ReactNode; stillOpen: number; onExit: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => reactAvatar("celebrate", "happy", 1800), 250);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 pt-20 pb-16">
      {props.receiptLine}
      <div ref={settleIn} className="flex flex-col items-center gap-5 text-center">
        <LiveAvatar size={112} />
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">That's everything</h1>
          <p className="text-sm text-muted-foreground text-pretty">
            {props.stillOpen > 0
              ? `Every agent can keep going. ${props.stillOpen} ${props.stillOpen === 1 ? "question you skipped comes" : "questions you skipped come"} back next time.`
              : "Every agent has what it needs. You'll hear when one is blocked on you again."}
          </p>
        </div>
        <Button variant="outline" onClick={props.onExit}>
          <ArrowLeftIcon />
          Back
        </Button>
      </div>
    </div>
  );
}

export function TurnRunner(props: { onExit: () => void }) {
  const queue = useQueue();
  const answers = useTopLayerStore((state) => state.answers);
  const drafts = useTopLayerStore((state) => state.drafts);
  const notes = useTopLayerStore((state) => state.notes);
  const receipt = useTopLayerStore((state) => state.receipt);
  const answer = useTopLayerStore((state) => state.answer);
  const setDraft = useTopLayerStore((state) => state.setDraft);
  const finishTurn = useTopLayerStore((state) => state.finishTurn);
  const undoReceipt = useTopLayerStore((state) => state.undoReceipt);
  const [pinned, setPinned] = useState<PinnedTurn | null>(null);
  const [justSent, setJustSent] = useState<string | null>(null);
  const [later, setLater] = useState<ReadonlySet<string>>(new Set());
  const [phase, setPhase] = useState<"round" | "notes">("round");
  const [typing, setTyping] = useState(false);

  // Pin the round on arrival so answering never reshuffles the queue under
  // you, and don't serve the context you just answered straight back.
  // Adjusted during render rather than in an effect.
  const next = queue.turns.find((turn) => turn.context.id !== justSent);
  if (pinned === null && next) {
    setPinned({ contextId: next.context.id, askIds: next.asks.map((ask) => ask.id) });
    setPhase("round");
  }

  const context = contextById(pinned?.contextId ?? null);
  const asks = (pinned?.askIds ?? []).flatMap((id) => {
    const ask = ASKS.find((candidate) => candidate.id === id);
    return ask && !answers[id] ? [ask] : [];
  });
  const rideAlong = notes.filter(
    (note) => note.contextId === pinned?.contextId && awaitingOk(note),
  );
  const ready = asks.filter((ask) => later.has(ask.id) || drafts[ask.id]?.trim());

  const advance = () => {
    if (!pinned) return;
    setJustSent(pinned.contextId);
    setPinned(null);
  };

  const send = () => {
    if (!pinned || ready.length === 0) return;
    for (const ask of ready) {
      const text = drafts[ask.id]?.trim();
      answer(ask.id, later.has(ask.id) || !text ? { kind: "later" } : { kind: "said", text });
    }
    finishTurn({ contextId: pinned.contextId, askIds: ready.map((ask) => ask.id) });
    reactAvatar("nod", "happy");
    if (rideAlong.length > 0) setPhase("notes");
    else advance();
  };

  const receiptContext = receipt ? contextById(receipt.contextId) : undefined;
  const pushedBack = receipt
    ? receipt.askIds.filter((id) => {
        const given = answers[id];
        return given?.kind === "said" && given.text !== GO_WITH_RECOMMENDATION;
      }).length
    : 0;
  const receiptLine =
    receipt && receiptContext && receipt.contextId !== pinned?.contextId ? (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <CheckIcon className="size-3.5 shrink-0 text-success" />
        <span className="min-w-0 flex-1 text-pretty">
          {receiptContext.name}: {receipt.askIds.length}{" "}
          {receipt.askIds.length === 1 ? "answer" : "answers"} sent.{" "}
          {pushedBack > 0
            ? `The ${receiptContext.agentName} is working through what you said and only comes back if it needs more.`
            : `The ${receiptContext.agentName} takes it from here.`}
        </span>
        <Button
          size="micro"
          variant="ghost-muted"
          onClick={() => {
            undoReceipt();
            setJustSent(null);
            setPinned({ contextId: receipt.contextId, askIds: receipt.askIds });
          }}
        >
          Undo
        </Button>
      </div>
    ) : null;

  if (!context || !pinned) {
    return (
      <AllDone
        receiptLine={receiptLine}
        stillOpen={queue.turns.reduce((sum, turn) => sum + turn.asks.length, 0)}
        onExit={props.onExit}
      />
    );
  }

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-8 px-4 pt-6 pb-16 lg:grid-cols-[minmax(0,1fr)_18rem] lg:pt-8">
      <div className="flex min-w-0 flex-col gap-5">
        <div className="flex items-center gap-3">
          <Button size="sm" variant="ghost" onClick={props.onExit}>
            <ArrowLeftIcon />
            Leave
          </Button>
          <div className="min-w-0 flex-1" />
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatMinutes(queue.minutes)} left
          </span>
        </div>
        {receiptLine}

        <div key={`${context.id}:${phase}`} ref={settleIn} className="flex flex-col gap-4">
          <header className="flex items-center gap-4">
            <LiveAvatar
              size={64}
              expression={typing ? "listening" : "idle"}
              activity={typing ? undefined : context.activity}
            />
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="text-xs text-muted-foreground">
                {context.area === "work" ? "Work" : "Personal"} · {context.agentName}
              </p>
              <h1 className="text-2xl font-semibold tracking-tight">{context.name}</h1>
            </div>
          </header>
          <p className="text-sm text-muted-foreground text-pretty">{context.progressNote}</p>

          {phase === "round" && asks.length > 0 ? (
            <>
              <div className="flex flex-col divide-y divide-border">
                {asks.map((ask, index) => (
                  <RoundQuestion
                    key={ask.id}
                    number={index + 1}
                    ask={ask}
                    context={context}
                    draft={drafts[ask.id] ?? ""}
                    later={later.has(ask.id)}
                    onDraft={(text) => setDraft(ask.id, text)}
                    onLater={(value) =>
                      setLater((current) => {
                        const nextLater = new Set(current);
                        if (value) nextLater.add(ask.id);
                        else nextLater.delete(ask.id);
                        return nextLater;
                      })
                    }
                    onTyping={setTyping}
                  />
                ))}
              </div>
              <div className="sticky bottom-0 -mx-4 flex items-center gap-3 border-t border-border bg-background/95 px-4 py-3 backdrop-blur-sm">
                <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                  {ready.length === asks.length
                    ? "All answered."
                    : ready.length === 0
                      ? "Answer what you can. Anything you skip comes back later."
                      : `${asks.length - ready.length} unanswered. ${asks.length - ready.length === 1 ? "It comes" : "They come"} back later.`}
                </p>
                <Button disabled={ready.length === 0} onClick={send}>
                  <SendIcon />
                  Send {ready.length > 0 ? ready.length : ""}{" "}
                  {ready.length === 1 ? "answer" : "answers"}
                </Button>
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-5 shadow-sm/5">
              {rideAlong.length > 0 ? (
                <>
                  <div className="flex flex-col gap-0.5">
                    <h2 className="text-base font-semibold">While you're here</h2>
                    <p className="text-sm text-muted-foreground">
                      {rideAlong.length === 1 ? "A note" : "Notes"} from your scratchpad the{" "}
                      {context.agentName} could act on. Skipping leaves them as notes.
                    </p>
                  </div>
                  <ul className="flex flex-col divide-y divide-border">
                    {rideAlong.map((note) => (
                      <NoteRow key={note.id} note={note} />
                    ))}
                  </ul>
                </>
              ) : (
                <h2 className="text-base font-semibold">All sent</h2>
              )}
              <Button className="self-start" onClick={advance}>
                {queue.turns.some((turn) => turn.context.id !== context.id) ? "Next" : "Done"}
                <ArrowRightIcon />
              </Button>
            </div>
          )}
        </div>
      </div>

      <Scratchpad
        key={context.id}
        contextId={context.id}
        className="lg:sticky lg:top-6 lg:max-h-[calc(100dvh-8rem)] lg:self-start"
      />
    </div>
  );
}
