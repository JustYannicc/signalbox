/**
 * PLACEHOLDER conversation engine so talking to the assistant or an agent never
 * dead-ends: a sent message is appended locally, and after a short beat a canned
 * reply follows. It either answers, or hands the request to a plausible agent
 * picked by keywords (a new hand-off card). Approving or declining a hand-off
 * flips its status. Nothing leaves this tab; a reload forgets it all.
 */
import { useSyncExternalStore } from "react";

import type {
  AssistantBlock,
  DelegationFixture,
  DelegationStatus,
  TurnFixture,
} from "./assistantFixtures";

interface MockChatState {
  readonly turnsByChat: Readonly<Record<string, readonly TurnFixture[]>>;
  readonly delegations: readonly DelegationFixture[];
  readonly statusById: Readonly<Record<string, DelegationStatus>>;
  readonly version: number;
}

let state: MockChatState = { turnsByChat: {}, delegations: [], statusById: {}, version: 0 };
const listeners = new Set<() => void>();

function update(next: Partial<MockChatState>) {
  state = { ...state, ...next, version: state.version + 1 };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-renders on any local change; pair it with the non-reactive reads below. */
export function useMockChatVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => state.version,
    () => state.version,
  );
}

export function localTurns(chatKey: string): readonly TurnFixture[] {
  return state.turnsByChat[chatKey] ?? [];
}

export function localDelegation(id: string): DelegationFixture | undefined {
  return state.delegations.find((delegation) => delegation.id === id);
}

/** A fixture hand-off with any local status change applied, to it and its last hop. */
export function withLocalStatus(delegation: DelegationFixture): DelegationFixture {
  const status = state.statusById[delegation.id];
  if (!status || status === delegation.status) return delegation;
  const hops = delegation.hops.map((hop, index) =>
    index === delegation.hops.length - 1 ? { ...hop, status } : hop,
  );
  return {
    ...delegation,
    status,
    hops,
    statusDetail: STATUS_DETAIL[status] ?? delegation.statusDetail,
  };
}

const STATUS_DETAIL: Partial<Record<DelegationStatus, string>> = {
  working: "Approved. Carrying on",
  input: "Held. Tell it what to do instead",
};

export function setLocalStatus(delegationId: string, status: DelegationStatus) {
  update({ statusById: { ...state.statusById, [delegationId]: status } });
}

const clock = () =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date());

/** Keyword routing for the canned replies: the first match wins. */
const ROUTES: readonly { pattern: RegExp; nodeId: string; label: string }[] = [
  { pattern: /\b(t3code|sidebar|pr|branch|commit)\b/i, nodeId: "project:t3code", label: "t3code" },
  {
    pattern: /\b(northwind|terminal|a920|neptune|printer|refund|jira)\b/i,
    nodeId: "project:terminal-app",
    label: "terminal-app",
  },
  {
    pattern: /\b(workflow|automation|every|whenever)\b/i,
    nodeId: "automations",
    label: "Automations",
  },
  {
    pattern: /\b(lease|flight|trip|holiday|dentist|personal|buy)\b/i,
    nodeId: "section:personal",
    label: "Personal",
  },
];

function cannedReply(chatKey: string, text: string, speakerNodeId: string): AssistantBlock[] {
  const route = ROUTES.find(
    (candidate) => candidate.pattern.test(text) && candidate.nodeId !== speakerNodeId,
  );
  if (!route) {
    if (!text.trim().endsWith("?")) {
      return [{ kind: "text", text: "Noted. Nothing to hand off, so it stays here." }];
    }
    return [
      {
        kind: "lookup",
        lookup: {
          tool: "gmail",
          account: "Personal Gmail",
          groupId: "personal",
          query: text.trim().replace(/\s+/g, " ").slice(0, 60),
          result: "No matching threads. Nothing sent or changed.",
        },
      },
      {
        kind: "text",
        text: "Nothing in your mail answers that. Should an agent dig into it?",
      },
    ];
  }
  const at = clock();
  const summary = text.trim().replace(/\s+/g, " ").slice(0, 80);
  const delegation: DelegationFixture = {
    id: `d-local-${chatKey}-${state.version}`,
    at,
    status: "working",
    summary: summary.charAt(0).toLowerCase() + summary.slice(1),
    message: text.trim(),
    groupId: "",
    hops: [{ to: route.nodeId, at, status: "working", message: text.trim() }],
    statusDetail: "Just started",
  };
  update({ delegations: [...state.delegations, delegation] });
  return [
    { kind: "text", text: `Handed to ${route.label}. Its progress shows on the card.` },
    { kind: "delegation", delegationId: delegation.id },
  ];
}

const REPLY_DELAY_MS = 700;

/** Appends the user's message now and a canned reply after a short beat. */
export function sendMockMessage(input: {
  chatKey: string;
  text: string;
  files: ReadonlyArray<File>;
  speakerNodeId: string;
}) {
  const { chatKey } = input;
  const append = (turn: TurnFixture) =>
    update({
      turnsByChat: { ...state.turnsByChat, [chatKey]: [...localTurns(chatKey), turn] },
    });
  append({
    id: `local-${chatKey}-${state.version}`,
    role: "user",
    at: clock(),
    blocks: [{ kind: "text", text: input.text.trim() }],
    ...(input.files.length > 0
      ? { files: input.files.map((file) => ({ name: file.name, size: file.size })) }
      : {}),
  });
  window.setTimeout(() => {
    append({
      id: `local-${chatKey}-${state.version}`,
      role: "assistant",
      at: clock(),
      blocks: cannedReply(chatKey, input.text, input.speakerNodeId),
    });
  }, REPLY_DELAY_MS);
}
