/**
 * One question in a pipeline round, shaped like a grilling question: why it's
 * being asked, what happens either way, the agent's recommended answer, and
 * room to answer in your own words. Options and "Go with that" only fill the
 * answer in; you can always push back, add context or say something else.
 */
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, LockIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import type { AskFixture, ContextFixture } from "./topLayerFixtures";

export const GO_WITH_RECOMMENDATION = "Go with your recommendation.";

export function RoundQuestion(props: {
  number: number;
  ask: AskFixture;
  context: ContextFixture;
  draft: string;
  later: boolean;
  onDraft: (text: string) => void;
  onLater: (later: boolean) => void;
  onTyping: (typing: boolean) => void;
}) {
  const { ask, context } = props;
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const chips = [
    { label: "Go with that", text: GO_WITH_RECOMMENDATION },
    ...(ask.options ?? []).map((option) => ({ label: option.label, text: option.label })),
  ];

  return (
    <article className="flex flex-col gap-3 py-7 first:pt-2">
      <div className="flex items-baseline gap-3">
        <span className="w-6 shrink-0 text-sm font-medium text-muted-foreground tabular-nums">
          Q{props.number}
        </span>
        <h2 className="text-lg font-semibold tracking-tight text-balance">{ask.ask}</h2>
      </div>

      <div className="flex flex-col gap-3 pl-9">
        <p className="text-sm text-muted-foreground text-pretty">
          {ask.whyNow} {ask.consequences}
        </p>

        <div className="flex flex-col gap-1 rounded-xl bg-muted/50 px-3.5 py-3">
          <p className="text-xs font-medium text-muted-foreground">
            {context.agentName} recommends
          </p>
          <p className="text-sm text-foreground text-pretty">{ask.recommendation}</p>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <button
            type="button"
            aria-expanded={evidenceOpen}
            onClick={() => setEvidenceOpen((open) => !open)}
            className="flex w-fit items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <ChevronRightIcon
              className={`size-3.5 transition-transform motion-reduce:transition-none ${evidenceOpen ? "rotate-90" : ""}`}
            />
            Evidence ({ask.evidence.length})
          </button>
          {ask.kind === "spend" ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <LockIcon className="size-3" />
              Spending money always waits for you
            </span>
          ) : null}
        </div>
        {evidenceOpen ? (
          <ul className="flex flex-col gap-1 pl-4.5 text-sm">
            {ask.evidence.map((item) => (
              <li key={item}>
                <Link
                  to="/agent/$agentId"
                  params={{ agentId: context.agentId }}
                  className="text-foreground underline-offset-4 hover:underline"
                >
                  {item}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}

        {props.later ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="min-w-0 flex-1">Later. It drops off today's list.</span>
            <Button size="xs" variant="ghost-muted" onClick={() => props.onLater(false)}>
              Answer now
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-1.5">
              {chips.map((chip) => (
                <Button
                  key={chip.label}
                  size="xs"
                  variant={props.draft === chip.text ? "secondary" : "outline"}
                  aria-pressed={props.draft === chip.text}
                  onClick={() => props.onDraft(props.draft === chip.text ? "" : chip.text)}
                >
                  {chip.label}
                </Button>
              ))}
              <Button size="xs" variant="ghost-muted" onClick={() => props.onLater(true)}>
                Later
              </Button>
            </div>
            <Textarea
              value={props.draft}
              onChange={(event) => props.onDraft(event.target.value)}
              onFocus={() => props.onTyping(true)}
              onBlur={() => props.onTyping(false)}
              placeholder="Your answer. Push back, add context, or say what you actually think."
              aria-label={`Your answer to Q${props.number}`}
            />
          </div>
        )}
      </div>
    </article>
  );
}
