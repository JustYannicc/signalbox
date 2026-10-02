/**
 * Lookups, labels and the trace tree for the Assistant prototype. Everything
 * reads the placeholder fixtures; swap the imports when real read models exist.
 */
import type { LucideIcon } from "lucide-react";

import { THREAD_STATUS_DISPLAY } from "../threadStatusDisplay";
import {
  ASSISTANT_DAYS,
  ASSISTANT_GROUPS,
  DELEGATIONS,
  TRACE_NODES,
  type ChatFixture,
  type DayFixture,
  type DelegationFixture,
  type DelegationStatus,
  type HopFixture,
  type TraceNodeFixture,
  type TraceNodeKind,
} from "./assistantFixtures";
import { localDelegation, withLocalStatus } from "./mockChatStore";
import { WORKFLOW_DELEGATIONS, WORKFLOW_NODES } from "./workflowAgents";

export interface StatusDisplay {
  /** Short label for rows ("Approval", "Waiting on Flynn"). */
  readonly label: string;
  /** Full wording for details and screen readers. */
  readonly description: string;
  readonly icon: LucideIcon;
  readonly colorClass: string;
  readonly needsYou: boolean;
}

/** The Pipeline's icon and label for a hand-off, naming the person for "waiting". */
export function statusDisplay(status: DelegationStatus, waitingOn?: string): StatusDisplay {
  const info = THREAD_STATUS_DISPLAY[status];
  const waitingLabel = status === "waiting" && waitingOn ? `Waiting on ${waitingOn}` : null;
  return {
    label: waitingLabel ?? info.label,
    description: waitingLabel ?? info.description,
    icon: info.icon,
    colorClass: info.className,
    needsYou: info.needsYou,
  };
}

export const NODE_KIND_LABEL: Record<TraceNodeKind, string> = {
  assistant: "Assistant",
  section: "Section agent",
  project: "Project agent",
  workflow: "Workflow agent",
  trigger: "Trigger",
  automations: "Automations",
  thread: "Thread",
};

export const CUSTOMIZE_TABS = ["identity", "soul", "about", "notifications"] as const;
export type CustomizeTab = (typeof CUSTOMIZE_TABS)[number];

export interface AssistantSearch {
  /** ISO date of a past day; absent means the current chat. */
  readonly day?: string;
  /** PLACEHOLDER switch: show the new-day screen instead of the continuing chat. */
  readonly fresh?: 1;
  /** Opens Customize on a tab, so other surfaces (e.g. Plugins) can link into it. */
  readonly customize?: CustomizeTab;
  /** Prefills the composer, e.g. from the New bar's ⌘↵. */
  readonly prompt?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validateAssistantSearch(raw: Record<string, unknown>): AssistantSearch {
  const day = typeof raw.day === "string" && ISO_DATE.test(raw.day) ? raw.day : undefined;
  const fresh = raw.fresh === 1 || raw.fresh === "1" || raw.fresh === true;
  const customize = CUSTOMIZE_TABS.find((tab) => tab === raw.customize);
  const prompt = typeof raw.prompt === "string" && raw.prompt.length > 0 ? raw.prompt : undefined;
  return {
    ...(day ? { day } : {}),
    ...(fresh && !day ? { fresh: 1 as const } : {}),
    ...(customize ? { customize } : {}),
    ...(prompt && !day ? { prompt } : {}),
  };
}

/** Newest day first; the first entry is the live chat. */
export const CURRENT_DAY: DayFixture = ASSISTANT_DAYS[0]!;
export const PAST_DAYS: readonly DayFixture[] = ASSISTANT_DAYS.slice(1);

export function resolveDay(date: string | undefined): DayFixture {
  return ASSISTANT_DAYS.find((day) => day.date === date) ?? CURRENT_DAY;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Tue 29 Sep" for an ISO calendar date. Built by hand: ICU writes "Sept" in en-GB. */
export function formatDayTitle(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  return `${WEEKDAYS[day.getUTCDay()]} ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]}`;
}

const ALL_NODES = [...TRACE_NODES, ...WORKFLOW_NODES];
const ALL_DELEGATIONS = [...DELEGATIONS, ...WORKFLOW_DELEGATIONS];

export function findNode(id: string): TraceNodeFixture | undefined {
  return ALL_NODES.find((node) => node.id === id);
}

/** A hand-off with any local change (e.g. an approval) applied. */
export function findDelegation(id: string): DelegationFixture | undefined {
  const found = ALL_DELEGATIONS.find((delegation) => delegation.id === id) ?? localDelegation(id);
  return found ? withLocalStatus(found) : undefined;
}

export function findGroupName(id: string | undefined): string | undefined {
  return ASSISTANT_GROUPS.find((group) => group.id === id)?.name;
}

export function delegationTarget(delegation: DelegationFixture): TraceNodeFixture | undefined {
  const last = delegation.hops.at(-1);
  return last ? findNode(last.to) : undefined;
}

/** Where a target lives ("Personal › t3code"), or what it is for agents. */
export function describeTarget(node: TraceNodeFixture): string {
  if (node.kind !== "thread") return NODE_KIND_LABEL[node.kind];
  return node.path.length > 0 ? node.path.join(" › ") : "Top level";
}

/** Delegations visible in a chat: carried-over items first, then the chat's own. */
export function dayDelegations(day: ChatFixture): DelegationFixture[] {
  const ids = [
    ...day.carriedOver.map((item) => item.delegationId),
    ...day.turns.flatMap((turn) =>
      turn.blocks.flatMap((block) => (block.kind === "delegation" ? [block.delegationId] : [])),
    ),
  ];
  return [...new Set(ids)].flatMap((id) => {
    const delegation = findDelegation(id);
    return delegation ? [delegation] : [];
  });
}

export interface TraceTreeNode {
  readonly node: TraceNodeFixture;
  /** Set when some hand-off ends here: the status of that hop. */
  status: DelegationStatus | undefined;
  waitingOn: string | undefined;
  readonly children: TraceTreeNode[];
}

const originOf = (delegation: DelegationFixture) => delegation.origin ?? "assistant";

/**
 * Merges every hand-off's hops into trees, one per origin: the assistant for
 * work it handed off, an automation's trigger for workflow runs.
 */
export function buildTraceForest(delegations: readonly DelegationFixture[]): TraceTreeNode[] {
  const byId = new Map<string, TraceTreeNode>();
  const roots: TraceTreeNode[] = [];
  const entryFor = (node: TraceNodeFixture, parent: TraceTreeNode | null) => {
    let entry = byId.get(node.id);
    if (!entry) {
      entry = { node, status: undefined, waitingOn: undefined, children: [] };
      byId.set(node.id, entry);
      (parent ? parent.children : roots).push(entry);
    }
    return entry;
  };
  for (const delegation of delegations) {
    const origin = findNode(originOf(delegation));
    if (!origin) continue;
    let parent = entryFor(origin, null);
    delegation.hops.forEach((hop, index) => {
      const node = findNode(hop.to);
      if (!node) return;
      const entry = entryFor(node, parent);
      if (index === delegation.hops.length - 1 && !entry.status) {
        entry.status = hop.status;
        entry.waitingOn = delegation.waitingOn;
      }
      parent = entry;
    });
  }
  return roots;
}

export interface TracedHop {
  readonly from: TraceNodeFixture;
  readonly to: TraceNodeFixture;
  readonly hop: HopFixture;
}

/** For each hand-off passing through a node, the hops from its origin down to it. */
export function hopsReaching(
  nodeId: string,
  delegations: readonly DelegationFixture[],
): { delegation: DelegationFixture; hops: TracedHop[] }[] {
  return delegations.flatMap((delegation) => {
    const end = delegation.hops.findIndex((hop) => hop.to === nodeId);
    if (end === -1) return [];
    const hops: TracedHop[] = [];
    let from = findNode(originOf(delegation));
    for (const hop of delegation.hops.slice(0, end + 1)) {
      const to = findNode(hop.to);
      if (!from || !to) return [];
      hops.push({ from, to, hop });
      from = to;
    }
    return [{ delegation, hops }];
  });
}
