/**
 * The composer for team chats and tasks: `MockBoundComposer` with the real
 * agent controls and file chips. A message goes to the item's agent; @people
 * also notifies them. Mentioning someone who can't see the item offers "Share
 * and notify"; sending anyway asks "Send without Flynn?", and nobody without
 * access is ever notified. "Wait for…" (or the question suggestion) holds the
 * agent until those people reply. Sends append locally and start a placeholder
 * agent turn (`agentReply.ts`) that runs live, then settles.
 */
import { AtSignIcon, HourglassIcon } from "lucide-react";
import { useState } from "react";

import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { MockBoundComposer } from "../chat/MockBoundComposer";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { notifiedLine, startAgentTurn } from "./agentReply";
import { localMessageId, nowLabel, useLocalMessagesStore } from "./localMessages";
import { useMentionDirectory } from "./mentionDirectory";
import { mentionedPeople } from "./mentions";
import type { HarnessRef, ReplyMode, TeamMessage, TeamPerson } from "./multiplayerModel";
import { waitingForReplies } from "./replyMode";
import { joinNames } from "./sharing";
import { currentPerson } from "./teamThreads";
import { WaitForControl } from "./WaitForControl";

/** Posts the first message of a chat started from New; the agent's turn starts right away. */
export function postOpeningMessage(threadId: string, prompt: string, harness: HarnessRef): void {
  startAgentTurn(threadId, {
    harness,
    startedById: currentPerson.id,
    prompt,
    before: [
      {
        id: localMessageId(),
        author: { kind: "person", personId: currentPerson.id },
        body: prompt,
        at: nowLabel(),
        createdAt: new Date().toISOString(),
      },
    ],
  });
}

/**
 * PLACEHOLDER for Jev: a message that mentions teammates and asks something
 * reads as a question for them.
 */
function looksLikeQuestion(text: string): boolean {
  return text.includes("?");
}

export const TEAM_COMPOSER_PLACEHOLDER = "Ask anything, @ to bring in people or your agents";

interface Outgoing {
  readonly prompt: string;
  readonly files: readonly string[];
}

export function TeamComposer(props: {
  /** The item id; keys the send lock, agent selection and local messages. */
  itemId: string;
  containerId: string;
  /** Who can see the item; mentioning anyone else offers to share. */
  hasAccess: (personId: string) => boolean;
  onShareAndNotify: (people: readonly TeamPerson[]) => void;
  /** The thread so far, to decide whether the agent answers now. */
  messages: readonly TeamMessage[];
  replyMode: ReplyMode;
  /** Who answers: the harness and model last used here. */
  harness: HarnessRef;
  /** Prefill, e.g. from `?prompt=`. */
  initialPrompt?: string;
  /** Who the agent is waiting for; sends don't trigger it meanwhile. */
  waitingFor: readonly TeamPerson[];
  /** People who can be waited for: everyone with access but you. */
  waitCandidates: readonly TeamPerson[];
  onWaitFor: (ids: readonly string[]) => void;
  /** An approval the running turn waits on, shown first. */
  approvalBanner?: ComposerBannerStackItem | null;
}) {
  const [prompt, setPrompt] = useState(props.initialPrompt ?? "");
  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState<
    (Outgoing & { readonly missing: readonly TeamPerson[] }) | null
  >(null);
  const { source } = useMentionDirectory({
    containerId: props.containerId,
    includeAgents: true,
    hasAccess: props.hasAccess,
  });
  const others = (text: string) =>
    mentionedPeople(text).filter((person) => person.id !== currentPerson.id);
  const bannerPeople = others(prompt).filter(
    (person) => !props.hasAccess(person.id) && !dismissedIds.has(person.id),
  );
  const names = joinNames(bannerPeople, "They");
  const [declinedWaitIds, setDeclinedWaitIds] = useState<ReadonlySet<string>>(new Set());
  const waitingIds = new Set(props.waitingFor.map((person) => person.id));
  const askedPeople = looksLikeQuestion(prompt)
    ? others(prompt).filter(
        (person) =>
          props.hasAccess(person.id) &&
          !waitingIds.has(person.id) &&
          !declinedWaitIds.has(person.id),
      )
    : [];
  const askedNames = joinNames(askedPeople, "them");

  /** Appends your message and starts the agent's turn; `notified` all have access. */
  const deliver = (outgoing: Outgoing, notified: readonly TeamPerson[]) => {
    const yours: TeamMessage = {
      id: localMessageId(),
      author: { kind: "person", personId: currentPerson.id },
      body: outgoing.prompt,
      at: nowLabel(),
      createdAt: new Date().toISOString(),
      ...(outgoing.files.length > 0 ? { files: outgoing.files } : {}),
    };
    // A wait (or "everyone" mode) holds the answer until those people post.
    const holds =
      props.waitingFor.length > 0 ||
      (props.replyMode === "everyone" && waitingForReplies([...props.messages, yours]).length > 0);
    if (!holds) {
      startAgentTurn(props.itemId, {
        harness: props.harness,
        startedById: currentPerson.id,
        prompt: outgoing.prompt,
        notified,
        before: [yours],
      });
      return;
    }
    useLocalMessagesStore
      .getState()
      .addTeam(props.itemId, [yours, ...notifiedLine(notified, Date.now() + 500)]);
  };

  const send = (outgoing: Outgoing) => {
    const mentioned = others(outgoing.prompt);
    const missing = mentioned.filter((person) => !props.hasAccess(person.id));
    if (missing.length > 0) {
      setConfirming({ ...outgoing, missing });
      return;
    }
    deliver(outgoing, mentioned);
    setPrompt("");
  };

  return (
    <>
      <MockBoundComposer
        targetKey={`team:${props.itemId}`}
        placeholder={TEAM_COMPOSER_PLACEHOLDER}
        prompt={prompt}
        onPromptChange={setPrompt}
        agentControls
        attachments
        mentions={source}
        controls={
          <WaitForControl
            candidates={props.waitCandidates}
            waitingFor={props.waitingFor}
            onChange={props.onWaitFor}
          />
        }
        banners={
          bannerPeople.length > 0 || askedPeople.length > 0 || props.approvalBanner
            ? [
                ...(props.approvalBanner ? [props.approvalBanner] : []),
                ...(askedPeople.length > 0
                  ? [
                      {
                        id: "wait-suggestion",
                        variant: "info" as const,
                        icon: <HourglassIcon />,
                        title: `Looks like a question for ${askedNames}`,
                        description: `Wait for ${askedNames} before the agent replies?`,
                        actions: (
                          <>
                            <Button
                              size="xs"
                              onClick={() =>
                                props.onWaitFor([
                                  ...waitingIds,
                                  ...askedPeople.map((person) => person.id),
                                ])
                              }
                            >
                              Wait
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() =>
                                setDeclinedWaitIds(
                                  (current) =>
                                    new Set([
                                      ...current,
                                      ...askedPeople.map((person) => person.id),
                                    ]),
                                )
                              }
                            >
                              Reply now
                            </Button>
                          </>
                        ),
                      },
                    ]
                  : []),
                ...(bannerPeople.length > 0
                  ? [
                      {
                        id: "mention-access",
                        variant: "info" as const,
                        icon: <AtSignIcon />,
                        title: `${names} ${bannerPeople.length === 1 ? "doesn't" : "don't"} have access`,
                        description: "Share this with them, history included, and notify them?",
                        actions: (
                          <Button size="xs" onClick={() => props.onShareAndNotify(bannerPeople)}>
                            Share and notify
                          </Button>
                        ),
                        dismissLabel: "Not now",
                        onDismiss: () =>
                          setDismissedIds(
                            (current) =>
                              new Set([...current, ...bannerPeople.map((person) => person.id)]),
                          ),
                      },
                    ]
                  : []),
              ]
            : undefined
        }
        onSend={(text, files) => send({ prompt: text, files: files.map((file) => file.name) })}
      />
      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Send without {joinNames(confirming?.missing ?? [], "them")}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {joinNames(confirming?.missing ?? [], "They")} can't see this, so they won't be
              notified.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="outline"
              onClick={() => {
                if (!confirming) return;
                props.onShareAndNotify(confirming.missing);
                deliver(confirming, others(confirming.prompt));
                setConfirming(null);
                setPrompt("");
              }}
            >
              Share and send
            </Button>
            <Button
              onClick={() => {
                if (!confirming) return;
                deliver(
                  confirming,
                  others(confirming.prompt).filter((person) => props.hasAccess(person.id)),
                );
                setConfirming(null);
                setPrompt("");
              }}
            >
              Send without them
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
