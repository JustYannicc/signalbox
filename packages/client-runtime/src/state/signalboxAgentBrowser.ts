import {
  SIGNALBOX_AGENT_BROWSER_WS_METHODS,
  type AgentBrowserControl,
  type AgentBrowserHandoff,
  type AgentBrowserStep,
  type AgentBrowserTab,
  type AgentBrowserUpdate,
} from "@t3tools/contracts/signalboxPreviews";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * The agent's browser in a Signalbox Cloud thread: a live DOM mirror of its
 * tabs, take-over input, and the trail of finished steps. Same capability as
 * previews (`capabilities.signalboxPreviews`).
 *
 * Watching costs nothing on the machine's browser, but it does hold a stream
 * open, so read `watch` only while someone is looking (see
 * `createAgentBrowserLease`). It drops its subscription as soon as nobody reads it.
 */
export function createSignalboxAgentBrowserAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** Input `{ threadId, tabId }`; a null tab follows the agent. Emits `AgentBrowserView`. */
    watch: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:signalbox-agent-browser:watch",
      tag: SIGNALBOX_AGENT_BROWSER_WS_METHODS.watch,
      idleTtlMs: 0,
      transform: (stream) =>
        stream.pipe(
          Stream.scan(newAgentBrowserView, reduceAgentBrowserUpdate),
          // The empty starting view says nothing; a reader keeps its last frame until `state`.
          Stream.drop(1),
        ),
    }),
    /** Input `{ threadId, viewerId, input }`. Serial per viewer: a click is down then up. */
    input: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:signalbox-agent-browser:input",
      tag: SIGNALBOX_AGENT_BROWSER_WS_METHODS.input,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.viewerId}`,
      },
    }),
    /** Input `{ threadId }`. Steps oldest first; kept after the machine stops. */
    trail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:signalbox-agent-browser:trail",
      tag: SIGNALBOX_AGENT_BROWSER_WS_METHODS.trail,
      idleTtlMs: 60_000,
    }),
    /** Input `{ threadId, stepId }`. A recording never changes, so it's read once. */
    step: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:signalbox-agent-browser:step",
      tag: SIGNALBOX_AGENT_BROWSER_WS_METHODS.step,
      staleTimeMs: Number.POSITIVE_INFINITY,
      idleTtlMs: 60_000,
    }),
  };
}

/** rrweb events since the page's last full snapshot, ready to replay from the start. */
export interface AgentBrowserSegment {
  /** Changes whenever the page has to be rebuilt from a new full snapshot. */
  readonly id: string;
  readonly tabId: string;
  /**
   * JSON arrays of rrweb events, oldest first; the first starts with a full
   * snapshot. Append-only and shared with later views of the same segment, so
   * read only the first `count` and never write to it.
   */
  readonly batches: Array<string>;
  /** How many of `batches` this view has; grows by one per batch. */
  readonly count: number;
}

/** What one watch stream says so far. */
export interface AgentBrowserView {
  /** Names this stream in `input`; null until the first `state`. */
  readonly viewerId: string | null;
  readonly tabs: ReadonlyArray<AgentBrowserTab>;
  readonly tabId: string | null;
  readonly control: AgentBrowserControl;
  readonly resting: boolean;
  readonly problem: string | null;
  /** The last notice, kept until control changes hands again. */
  readonly notice: string | null;
  /** No machine runs the thread; the trail is all there is. */
  readonly offline: boolean;
  /** The mirrored tab waits on the person, e.g. to finish a payment. */
  readonly handoff: AgentBrowserHandoff | null;
  readonly segment: AgentBrowserSegment | null;
  /** Steps that finished while watching, oldest first. */
  readonly steps: ReadonlyArray<AgentBrowserStep>;
  readonly nonce: string;
  readonly segmentCount: number;
}

let viewCount = 0;

/** A fresh view for one subscription; its nonce keeps segment ids unique across subscriptions. */
export function newAgentBrowserView(): AgentBrowserView {
  viewCount += 1;
  return {
    viewerId: null,
    tabs: [],
    tabId: null,
    control: "agent",
    resting: false,
    problem: null,
    notice: null,
    offline: false,
    handoff: null,
    segment: null,
    steps: [],
    nonce: String(viewCount),
    segmentCount: 0,
  };
}

const RRWEB_META = 4;
const RRWEB_FULL_SNAPSHOT = 2;
const LEADING_EVENT_TYPE = /^\s*\[\s*\{\s*"type"\s*:\s*(\d+)/;

/**
 * Whether a batch starts over from a full snapshot (rrweb's Meta, then
 * FullSnapshot). The recorder writes `type` first, so this rarely parses.
 */
export function isAgentBrowserFreshStart(events: string): boolean {
  const leading = LEADING_EVENT_TYPE.exec(events);
  const type = leading
    ? Number(leading[1])
    : (() => {
        try {
          const parsed: unknown = JSON.parse(events);
          const first: unknown = Array.isArray(parsed) ? parsed[0] : undefined;
          return typeof first === "object" && first !== null && "type" in first
            ? first.type
            : undefined;
        } catch {
          return undefined;
        }
      })();
  return type === RRWEB_META || type === RRWEB_FULL_SNAPSHOT;
}

export function reduceAgentBrowserUpdate(
  view: AgentBrowserView,
  update: AgentBrowserUpdate,
): AgentBrowserView {
  switch (update._tag) {
    case "state":
      return {
        ...view,
        viewerId: update.viewerId,
        tabs: update.tabs,
        tabId: update.tabId,
        control: update.control,
        resting: update.resting,
        problem: update.problem,
        notice: update.notice ?? (update.control === view.control ? view.notice : null),
        offline: false,
        handoff: update.handoff ?? null,
        // No tab open means no page; a new tab's page arrives as its own fresh batch.
        segment: update.tabId === null ? null : view.segment,
      };
    case "events": {
      if (isAgentBrowserFreshStart(update.events)) {
        const segmentCount = view.segmentCount + 1;
        return {
          ...view,
          segmentCount,
          segment: {
            id: `${view.nonce}:${segmentCount}`,
            tabId: update.tabId,
            batches: [update.events],
            count: 1,
          },
        };
      }
      // Changes without the page they apply to can't be replayed.
      const { segment } = view;
      if (segment === null || segment.tabId !== update.tabId) return view;
      // Append in place, O(1) per batch. An older view that something already
      // appended past (a fork, never the stream itself) gets its own copy.
      const batches =
        segment.batches.length === segment.count
          ? segment.batches
          : segment.batches.slice(0, segment.count);
      batches.push(update.events);
      return { ...view, segment: { ...segment, batches, count: segment.count + 1 } };
    }
    case "step":
      return view.steps.some((step) => step.stepId === update.step.stepId)
        ? view
        : { ...view, steps: [...view.steps, update.step] };
    case "offline":
      return {
        ...view,
        tabs: [],
        tabId: null,
        control: "agent",
        resting: false,
        problem: null,
        notice: null,
        offline: true,
        handoff: null,
        segment: null,
      };
  }
}

const NO_STEPS: ReadonlyArray<AgentBrowserStep> = [];

/** The stored trail followed by steps that finished since it was read, oldest first. */
export function mergeAgentBrowserSteps(
  trail: ReadonlyArray<AgentBrowserStep> | null,
  live: ReadonlyArray<AgentBrowserStep>,
): ReadonlyArray<AgentBrowserStep> {
  const stored = trail ?? NO_STEPS;
  if (live.length === 0) return stored;
  const known = new Set(stored.map((step) => step.stepId));
  const fresh = live.filter((step) => !known.has(step.stepId));
  return fresh.length === 0 ? stored : [...stored, ...fresh];
}
