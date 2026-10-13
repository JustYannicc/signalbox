/**
 * Now: what the app opens on (issue #180). One thing at a time.
 *
 * The avatar acts out what the agents are busy with, so a glance says the
 * work is moving. Below it, one sentence and at most one action: if anything
 * is blocked on you, "Let's go" into the pipeline; only once nothing is, the
 * question flips to what you want to do, with one prepared option offered.
 * The composer at the bottom is your assistant's: anything you'd steer with a
 * button ("only personal stuff today", "which notes need me?") you say there.
 * Now is that chat's latest page: your newest message and its reply show
 * under the headline, and the day's history sits above, out of sight until
 * you scroll up.
 */
import { useNavigate } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { AssistantBlock } from "../assistant/assistantFixtures";
import { CURRENT_DAY } from "../assistant/assistantModel";
import { AssistantComposer } from "../assistant/AssistantComposer";
import { AssistantConversation } from "../assistant/AssistantConversation";
import { useAssistantIdentity } from "../assistant/assistantIdentity";
import { localTurns, sendMockMessage, useMockChatVersion } from "../assistant/mockChatStore";
import { Button } from "../ui/button";
import { LiveAvatar, reactAvatar } from "./LiveAvatar";
import { ReadyLine } from "./ReadySuggestions";
import { CONTEXTS, READY } from "./topLayerFixtures";
import { useActivityCycle, useQueue } from "./topLayerHooks";
import { formatMinutes, type Intent } from "./topLayerQueue";
import { awaitingOk, useTopLayerStore } from "./topLayerStore";

/** PLACEHOLDER for the assistant reading intent out of what you wrote. */
function intentFrom(text: string): Intent | null {
  const lower = text.toLowerCase();
  if (!/\b(only|just)\b/.test(lower)) return null;
  if (lower.includes("personal")) return "personal";
  if (lower.includes("work")) return "work";
  return null;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What sits under the avatar: one sentence, and the one thing to do about it. */
function Headline(props: { onStart: () => void }) {
  const queue = useQueue();
  const intent = useTopLayerStore((state) => state.intent);
  const resumeNotes = useTopLayerStore((state) => state.resumeNotes);
  const first = queue.turns[0];
  const resumeContext = CONTEXTS.find((context) => resumeNotes[context.id]);
  const except = queue.turns.find((turn) => turn.exceptBecause !== null);
  const focus =
    intent === "all" ? "" : `${intent === "personal" ? "Personal" : "Work"} only today. `;

  if (!first) {
    return (
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">Nothing needs you.</h1>
        <p className="text-base text-muted-foreground text-balance">
          {focus}Everything's moving. What do you want to do?
        </p>
        <ReadyLine items={READY.filter((item) => intent === "all" || item.area === intent)} />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">
          {resumeContext
            ? `You were in the middle of ${resumeContext.name}.`
            : queue.turns.length === 1
              ? `${first.context.name} needs you.`
              : "A few things need you."}
        </h1>
        <p className="text-base text-muted-foreground text-balance">
          {focus}
          {capitalize(formatMinutes(queue.minutes))}, then everything keeps moving.
          {except ? ` ${except.context.name} too: ${except.exceptBecause}.` : ""}
        </p>
      </div>
      <Button
        size="lg"
        onClick={() => {
          reactAvatar("hop", "happy", 900);
          props.onStart();
        }}
      >
        {resumeContext ? "Pick up" : "Let's go"}
        <ArrowRightIcon />
      </Button>
    </div>
  );
}

/**
 * What the assistant is thinking about: whichever agent's work it's watching
 * right now, as a thought bubble off its head. Swaps with a soft fade.
 */
function ThoughtBubble(props: { text: string }) {
  return (
    <div className="pointer-events-none absolute bottom-3/4 left-1/2 flex w-max max-w-40 flex-col items-start sm:left-3/4 sm:max-w-60">
      <p
        key={props.text}
        ref={fadeIn}
        className="rounded-2xl border border-border bg-card px-3.5 py-2 text-sm text-foreground shadow-sm/5 text-pretty"
      >
        {props.text}
      </p>
      <span className="mt-1 ml-3 size-2.5 rounded-full border border-border bg-card" />
      <span className="mt-0.5 ml-1 size-1.5 rounded-full border border-border bg-card" />
    </div>
  );
}

function fadeIn(element: HTMLElement | null) {
  if (!element || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  element.animate(
    [
      { opacity: 0, transform: "translateY(4px) scale(0.97)" },
      { opacity: 1, transform: "none" },
    ],
    { duration: 320, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
  );
}

const CHAT_KEY = `assistant:${CURRENT_DAY.date}`;

/** Lands on Now with the chat's history above it, out of sight until you scroll up. */
function scrollNowIntoView(element: HTMLElement | null) {
  element?.scrollIntoView({ block: "start" });
}

export function OpenScreen(props: { onStart: () => void }) {
  const { name } = useAssistantIdentity();
  const navigate = useNavigate();
  const queue = useQueue();
  const setIntent = useTopLayerStore((state) => state.setIntent);
  const [prompt, setPrompt] = useState("");
  const typing = prompt.trim().length > 0;
  const now = useActivityCycle();
  const endRef = useRef<HTMLDivElement>(null);

  // The day's assistant chat: everything before your newest message is
  // history above Now; your newest message and its reply sit under it.
  useMockChatVersion();
  const sent = localTurns(CHAT_KEY);
  const lastAsk = sent.findLastIndex((turn) => turn.role === "user");
  const history = [...CURRENT_DAY.turns, ...(lastAsk >= 0 ? sent.slice(0, lastAsk) : sent)];
  const latest = lastAsk >= 0 ? sent.slice(lastAsk) : [];
  const speaker = { name, nodeId: "assistant" };
  const openInChat = () => void navigate({ to: "/assistant" });

  // Follow the newest exchange as it arrives (your message, then the reply).
  useEffect(() => {
    if (latest.length > 0) endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [latest.length]);

  // PLACEHOLDER: what the assistant would answer to the things the old buttons did.
  const replyTo = (text: string): AssistantBlock[] | undefined => {
    const intent = intentFrom(text);
    if (intent) {
      setIntent(intent);
      const except = queue.turns.find(
        (turn) => turn.context.area !== intent && turn.asks.some((ask) => ask.hardDeadline),
      );
      const reason = except?.asks.find((ask) => ask.hardDeadline)?.whyNow.toLowerCase();
      return [
        {
          kind: "text",
          text: `${intent === "personal" ? "Personal" : "Work"} only today. ${
            intent === "personal" ? "Work" : "Personal stuff"
          } stays out of sight.${
            except && reason
              ? ` One exception: ${except.context.name}, because ${reason} I'll keep that one in.`
              : ""
          }`,
        },
      ];
    }
    if (/\bnotes?\b/i.test(text)) {
      const waiting = useTopLayerStore.getState().notes.filter(awaitingOk);
      return [
        {
          kind: "text",
          text:
            waiting.length === 0
              ? "No notes are waiting on you."
              : `${waiting.length} notes have a suggestion waiting for your OK: ${waiting
                  .map((note) => `"${note.text}"`)
                  .join(
                    ", ",
                  )}. They come up at the end of each project's round, so nothing to chase.`,
        },
      ];
    }
    return undefined;
  };

  const send = (text: string) => {
    const reply = replyTo(text);
    reactAvatar(null, "thinking", 900);
    sendMockMessage({
      chatKey: CHAT_KEY,
      text,
      files: [],
      speakerNodeId: "assistant",
      ...(reply ? { reply } : {}),
    });
  };

  return (
    <div className="mx-auto flex w-full max-w-(--chat-max-width) flex-col px-5 sm:px-6">
      <div className="flex flex-col pt-8 pb-16 opacity-80">
        <p className="pb-6 text-center text-xs text-muted-foreground">Earlier today with {name}</p>
        <AssistantConversation
          chat={{ ...CURRENT_DAY, turns: history }}
          speaker={speaker}
          onTrace={openInChat}
        />
      </div>

      <section
        ref={scrollNowIntoView}
        aria-label="Now"
        className="flex flex-col"
        // Exactly one screen tall at least, so the history above stays out of
        // sight until you scroll up, however tall the window is.
        style={{ minHeight: "calc(100dvh - var(--workspace-topbar-height))" }}
      >
        <div className="flex flex-1 flex-col items-center pt-12 sm:pt-16">
          <div className="relative">
            <LiveAvatar
              size={144}
              expression={typing ? "listening" : "idle"}
              activity={typing ? undefined : (now?.activity ?? "resting")}
              idle={!now}
              greet
            />
            <ThoughtBubble
              text={
                typing
                  ? "Listening…"
                  : now
                    ? `${now.agentName} is ${now.doing}`
                    : "All quiet. Nothing's running."
              }
            />
          </div>
          <div className="mt-8 w-full">
            <Headline onStart={props.onStart} />
          </div>
        </div>

        {latest.length > 0 ? (
          <div className="pt-12">
            <AssistantConversation
              chat={{ carriedOver: [], turns: latest }}
              speaker={speaker}
              onTrace={openInChat}
            />
          </div>
        ) : null}

        <div ref={endRef} className="sticky bottom-0 bg-background pt-6 pb-4">
          <AssistantComposer
            recipient={name}
            targetKey="top-layer"
            placeholder={`Talk to ${name}`}
            prompt={prompt}
            onPromptChange={setPrompt}
            onSend={(text) => send(text)}
          />
        </div>
      </section>
    </div>
  );
}
