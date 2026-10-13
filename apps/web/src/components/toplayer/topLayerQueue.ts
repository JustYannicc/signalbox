/**
 * The pipeline's order, as plain rules (issue #180). Same open asks plus same
 * intent always give the same turns in the same order; the assistant shapes the
 * queue only by setting the intent, never by hand-sorting it.
 *
 * Rules, in order: a real deadline first (soonest first), then whatever
 * unblocks the most other work, then fit with today's intent, then the
 * context's own order. An intent hides contexts that don't fit, except ones
 * with a hard deadline, which pass and say why.
 */
import type { AskFixture, ContextArea, ContextFixture } from "./topLayerFixtures";

export type Intent = "all" | ContextArea;

export interface Turn {
  readonly context: ContextFixture;
  readonly asks: readonly AskFixture[];
  readonly minutes: number;
  /** Set when the context doesn't fit the intent but passes on a deadline. */
  readonly exceptBecause: string | null;
}

export interface Queue {
  readonly turns: readonly Turn[];
  readonly minutes: number;
  /** Contexts the intent keeps out of sight; none of them has a deadline. */
  readonly heldBack: readonly ContextFixture[];
}

function soonestDeadline(asks: readonly AskFixture[]): AskFixture["hardDeadline"] {
  let soonest: AskFixture["hardDeadline"];
  for (const ask of asks) {
    if (ask.hardDeadline && (!soonest || ask.hardDeadline.hoursLeft < soonest.hoursLeft)) {
      soonest = ask.hardDeadline;
    }
  }
  return soonest;
}

function compareAsks(a: AskFixture, b: AskFixture): number {
  const aHours = a.hardDeadline?.hoursLeft ?? Number.POSITIVE_INFINITY;
  const bHours = b.hardDeadline?.hoursLeft ?? Number.POSITIVE_INFINITY;
  if (aHours !== bHours) return aHours - bHours;
  return b.unblocks - a.unblocks;
}

export function buildQueue(input: {
  readonly contexts: readonly ContextFixture[];
  readonly asks: readonly AskFixture[];
  readonly isOpen: (ask: AskFixture) => boolean;
  readonly intent: Intent;
}): Queue {
  const candidates = input.contexts.flatMap((context, order) => {
    const asks = input.asks
      .filter((ask) => ask.contextId === context.id && input.isOpen(ask))
      .toSorted(compareAsks);
    if (asks.length === 0) return [];
    const deadline = soonestDeadline(asks);
    const fits = input.intent === "all" || context.area === input.intent;
    return [
      {
        order,
        fits,
        hoursLeft: deadline?.hoursLeft ?? Number.POSITIVE_INFINITY,
        unblocks: asks.reduce((sum, ask) => sum + ask.unblocks, 0),
        turn: {
          context,
          asks,
          minutes: asks.reduce((sum, ask) => sum + ask.minutes, 0),
          exceptBecause: !fits && deadline ? deadline.label : null,
        } satisfies Turn,
        passes: fits || deadline !== undefined,
      },
    ];
  });

  const turns = candidates
    .filter((candidate) => candidate.passes)
    .toSorted(
      (a, b) =>
        a.hoursLeft - b.hoursLeft ||
        b.unblocks - a.unblocks ||
        Number(b.fits) - Number(a.fits) ||
        a.order - b.order,
    )
    .map((candidate) => candidate.turn);

  return {
    turns,
    minutes: turns.reduce((sum, turn) => sum + turn.minutes, 0),
    heldBack: candidates
      .filter((candidate) => !candidate.passes)
      .map((candidate) => candidate.turn.context),
  };
}

/** "About 15 minutes", rounded the way a person would say it. */
export function formatMinutes(minutes: number): string {
  if (minutes <= 1) return "a minute";
  if (minutes < 60) return `about ${Math.max(2, Math.round(minutes))} minutes`;
  const hours = Math.round((minutes / 60) * 2) / 2;
  return `about ${hours} ${hours === 1 ? "hour" : "hours"}`;
}
