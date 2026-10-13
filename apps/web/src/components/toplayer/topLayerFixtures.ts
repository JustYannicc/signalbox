/**
 * PLACEHOLDER data for the top layer (issue #180): the contexts that need you,
 * the asks inside them, prepared options waiting on "do I want this", scratchpad
 * notes, and the dashboard's responsibilities. Every name here is made up.
 */

export type ContextArea = "work" | "personal";

/** What a context's agent is busy with right now; the avatar acts it out. */
export type AgentActivity = "coding" | "reading" | "writing" | "booking";

/** A responsibility the user owns, usually a project, with its own agent. */
export interface ContextFixture {
  readonly id: string;
  readonly name: string;
  readonly area: ContextArea;
  /** `/agent/$agentId`, the way down into this context's trace. */
  readonly agentId: string;
  readonly agentName: string;
  /** Shared projects get a shared scratchpad next to the private one. */
  readonly shared: boolean;
  /** Dashboard progress, 0-100, and what the agent says about it. */
  readonly progress: number;
  readonly progressNote: string;
  readonly activity: AgentActivity;
  /** Finishes "<agent> is …", e.g. "wiring up the payment form". */
  readonly doing: string;
}

export interface AskOption {
  readonly id: string;
  readonly label: string;
}

/** One thing an agent can't continue without. */
export interface AskFixture {
  readonly id: string;
  readonly contextId: string;
  readonly ask: string;
  readonly whyNow: string;
  readonly recommendation: string;
  readonly consequences: string;
  readonly evidence: readonly string[];
  /** A choice between named options; otherwise approve / change. */
  readonly options?: readonly AskOption[];
  readonly recommendedOptionId?: string;
  /** "Spend money" asks always wait for you (trust setting). */
  readonly kind: "decision" | "spend" | "approval";
  /** Rough minutes it takes to answer, for the queue's time estimate. */
  readonly minutes: number;
  /** A real consequence with a time: passes any intent filter. */
  readonly hardDeadline?: { readonly label: string; readonly hoursLeft: number };
  /** How many other pieces of work wait on this answer. */
  readonly unblocks: number;
}

export interface ReadyFixture {
  readonly id: string;
  readonly title: string;
  readonly area: ContextArea;
  readonly summary: string;
  readonly detail: readonly string[];
  readonly freshness: string;
  readonly stale?: boolean;
}

export interface NoteFixture {
  readonly id: string;
  /** `null` is the global scratchpad. */
  readonly contextId: string | null;
  readonly scope: "private" | "shared";
  readonly author: string;
  readonly text: string;
  /** What the context's agent thinks you meant; `null` while it isn't sure. */
  readonly interpretation: string | null;
  /** A structured condition, e.g. "after #212 merges". */
  readonly trigger?: string;
}

export const CONTEXTS: readonly ContextFixture[] = [
  {
    id: "northwind-checkout",
    name: "Northwind checkout",
    area: "work",
    agentId: "project-northwind-checkout",
    agentName: "Checkout agent",
    shared: true,
    progress: 70,
    progressNote: "Payments done, waiting on you for two calls",
    activity: "coding",
    doing: "wiring up the address form",
  },
  {
    id: "terminal-app",
    name: "terminal-app",
    area: "work",
    agentId: "project-terminal-app",
    agentName: "terminal-app agent",
    shared: false,
    progress: 40,
    progressNote: "Release 0.9 is staged",
    activity: "coding",
    doing: "testing the 0.9 build",
  },
  {
    id: "thesis",
    name: "Thesis",
    area: "personal",
    agentId: "project-thesis",
    agentName: "Thesis agent",
    shared: false,
    progress: 55,
    progressNote: "Chapter 3 drafted, two comments left",
    activity: "reading",
    doing: "reading papers for chapter 4",
  },
  {
    id: "flat-move",
    name: "Flat move",
    area: "personal",
    agentId: "project-flat-move",
    agentName: "Move agent",
    shared: false,
    progress: 30,
    progressNote: "Movers compared, contract notices drafted",
    activity: "booking",
    doing: "comparing moving quotes",
  },
];

export const ASKS: readonly AskFixture[] = [
  {
    id: "thesis-send",
    contextId: "thesis",
    ask: "Send chapter 3 to your supervisor as it is?",
    whyNow: "Her review slot for this month closes Friday.",
    recommendation: "Send it. The two open comments are wording, not substance.",
    consequences: "Miss Friday and the next review slot is in three weeks.",
    evidence: ["Chapter 3 draft, 14 pages", "Open comments: 2 (wording)", "Review calendar"],
    kind: "approval",
    minutes: 2,
    hardDeadline: { label: "due Fri", hoursLeft: 52 },
    unblocks: 1,
  },
  {
    id: "thesis-style",
    contextId: "thesis",
    ask: "Which citation style?",
    whyNow: "The agent is formatting the bibliography now.",
    recommendation: "APA 7. The department template already uses it.",
    consequences: "Switching later means re-checking 61 references.",
    evidence: ["Department template", "61 references"],
    options: [
      { id: "apa", label: "APA 7" },
      { id: "ieee", label: "IEEE" },
    ],
    recommendedOptionId: "apa",
    kind: "decision",
    minutes: 1,
    unblocks: 0,
  },
  {
    id: "checkout-stripe",
    contextId: "northwind-checkout",
    ask: "Keep Stripe Checkout, or move to the Payment Element?",
    whyNow: "Two agents are blocked on which payment form to build against.",
    recommendation:
      "Keep Checkout for launch. The Payment Element costs about 3 days and buys nothing the launch needs.",
    consequences: "Moving later is a contained change; moving now delays launch by a week.",
    evidence: ["Spike PR #207", "Launch checklist", "Conversion notes from the pilot"],
    options: [
      { id: "checkout", label: "Keep Checkout" },
      { id: "element", label: "Payment Element" },
    ],
    recommendedOptionId: "checkout",
    kind: "decision",
    minutes: 3,
    unblocks: 2,
  },
  {
    id: "checkout-sentry",
    contextId: "northwind-checkout",
    ask: "Approve CHF 49 a month for the bigger error-tracking plan?",
    whyNow: "The current plan dropped 1,200 events this week.",
    recommendation: "Approve. Dropped events hid the address-form crash for two days.",
    consequences: "Without it, roughly a third of production errors go unseen.",
    evidence: ["Quota report", "Address-form crash timeline"],
    kind: "spend",
    minutes: 1,
    unblocks: 0,
  },
  {
    id: "checkout-flag",
    contextId: "northwind-checkout",
    ask: "Ship address autocomplete behind a flag for 10% of shoppers?",
    whyNow: "It's merged and tested; the agent needs a rollout plan.",
    recommendation: "Yes, 10% for a week, then widen if errors stay flat.",
    consequences: "Holding it keeps the old form, which has the most drop-offs.",
    evidence: ["PR #211", "Funnel by step"],
    kind: "approval",
    minutes: 2,
    unblocks: 1,
  },
  {
    id: "terminal-release",
    contextId: "terminal-app",
    ask: "Release 0.9 tonight, or wait for the receipt-printer fix?",
    whyNow: "The store review slot closes at 22:00.",
    recommendation: "Release tonight without the printer fix; it only affects one older model.",
    consequences: "Waiting pushes the release to next week's slot.",
    evidence: ["Release notes draft", "Affected devices: 1 model", "Store review calendar"],
    options: [
      { id: "tonight", label: "Release tonight" },
      { id: "wait", label: "Wait for the fix" },
    ],
    recommendedOptionId: "tonight",
    kind: "decision",
    minutes: 2,
    hardDeadline: { label: "closes 22:00", hoursLeft: 9 },
    unblocks: 1,
  },
  {
    id: "move-movers",
    contextId: "flat-move",
    ask: "Book movers for Saturday 25 October, CHF 640?",
    whyNow: "That date is the last free Saturday before the handover.",
    recommendation: "Book it. Cheapest of the three quotes that include insurance.",
    consequences: "The next free Saturday is after the handover date.",
    evidence: ["3 quotes compared", "Insurance terms", "Handover date"],
    kind: "spend",
    minutes: 2,
    unblocks: 1,
  },
  {
    id: "move-internet",
    contextId: "flat-move",
    ask: "Cancel the current internet contract now?",
    whyNow: "It has a three-month notice period.",
    recommendation: "Cancel now so it ends the week you move.",
    consequences: "Cancelling next month means paying for a month in the old flat.",
    evidence: ["Contract terms", "Drafted cancellation letter"],
    kind: "approval",
    minutes: 1,
    unblocks: 0,
  },
];

export const READY: readonly ReadyFixture[] = [
  {
    id: "skydiving",
    title: "Tandem skydive over Interlaken",
    area: "personal",
    summary: "Sat 18 Oct, CHF 430, video included",
    detail: [
      "Three operators compared on price, reviews and video.",
      "Holding the best one doesn't cost anything; booking does.",
      "A weather watch is running and will move the date if needed.",
    ],
    freshness: "Prices checked 2 hours ago",
  },
  {
    id: "lisbon",
    title: "Long weekend in Lisbon",
    area: "personal",
    summary: "7 to 9 Nov, flights and two nights for CHF 380",
    detail: [
      "Direct flights both ways, a flat in Alfama with good reviews.",
      "Fares are being watched; it'll say if they jump.",
    ],
    freshness: "Fares checked this morning",
  },
  {
    id: "ramen",
    title: "Ramen class",
    area: "personal",
    summary: "Two classes compared, next one Thursday evening",
    detail: ["Class list is from last week; the agent is re-checking dates."],
    freshness: "Class list is a week old",
    stale: true,
  },
];

export const NOTES: readonly NoteFixture[] = [
  {
    id: "note-refunds",
    contextId: "northwind-checkout",
    scope: "private",
    author: "you",
    text: "after #212 merges also do the refund thing like kevin did",
    interpretation: "Port Kevin M.'s partial-refund flow (PR #188) to checkout.",
    trigger: "after #212 merges",
  },
  {
    id: "note-receipts",
    contextId: "northwind-checkout",
    scope: "private",
    author: "you",
    text: "dark receipts??",
    interpretation: "Add a dark-mode variant of the receipt email.",
  },
  {
    id: "note-test-cards",
    contextId: "northwind-checkout",
    scope: "shared",
    author: "Mara",
    text: "QA wants the test cards written down somewhere",
    interpretation: "Add a test-card table to the checkout README.",
  },
  {
    id: "note-dataset",
    contextId: "thesis",
    scope: "private",
    author: "you",
    text: "ask lena re dataset license",
    interpretation: "Draft an email to Lena asking whether the transit dataset may be published.",
  },
  {
    id: "note-printer",
    contextId: "terminal-app",
    scope: "private",
    author: "you",
    text: "printer thing again??",
    interpretation: null,
  },
  {
    id: "note-gift",
    contextId: null,
    scope: "private",
    author: "you",
    text: "gift for mom, bday mid nov",
    interpretation: "Shortlist three gift ideas before 10 November.",
  },
];

export const DELIVERIES = [
  { id: "lamp", label: "Desk lamp", status: "Arrives Thursday" },
  { id: "shoes", label: "Running shoes", status: "Out for delivery" },
] as const;

export const CALENDAR = [
  { id: "standup", time: "10:00", label: "Northwind standup" },
  { id: "dentist", time: "14:30", label: "Dentist" },
  { id: "climb", time: "19:00", label: "Climbing with Jonas" },
] as const;

export function contextById(id: string | null): ContextFixture | undefined {
  return id === null ? undefined : CONTEXTS.find((context) => context.id === id);
}
