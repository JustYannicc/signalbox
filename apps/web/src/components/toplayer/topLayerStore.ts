/**
 * PLACEHOLDER local state for the top layer (issue #180): today's intent, your
 * answers, scratchpad notes, resume notes and the dashboard layout. Memory
 * only, like the rest of the prototype: a reload starts from the fixtures.
 */
import { create } from "zustand";

import { NOTES, type NoteFixture } from "./topLayerFixtures";
import type { Intent } from "./topLayerQueue";

/** What you said to one question in a round: in your own words, or "later". */
export type Answer = { readonly kind: "said"; readonly text: string } | { readonly kind: "later" };

export interface NoteState extends NoteFixture {
  /** You said the interpretation is wrong; the note stays a plain note. */
  readonly interpretationDismissed?: boolean;
}

export type WidgetId = "keep-moving" | "responsibilities" | "deliveries" | "calendar" | "ready";

export const WIDGET_LABELS: Record<WidgetId, string> = {
  "keep-moving": "Keep things moving",
  responsibilities: "Responsibilities",
  deliveries: "Deliveries",
  calendar: "Today's calendar",
  ready: "Ready when you are",
};

const DEFAULT_WIDGETS: readonly WidgetId[] = [
  "keep-moving",
  "responsibilities",
  "deliveries",
  "calendar",
];

/** The last change someone else (the assistant) made to the dashboard. */
export interface DashboardChange {
  readonly text: string;
  readonly before: readonly WidgetId[];
}

/** The receipt for the turn you just finished, shown on the next one. */
export interface TurnReceipt {
  readonly contextId: string;
  readonly askIds: readonly string[];
}

interface TopLayerState {
  intent: Intent;
  answers: Record<string, Answer>;
  /** Half-written answers, kept when you leave a turn and come back. */
  drafts: Record<string, string>;
  notes: readonly NoteState[];
  /** Notes you OK'd: they left the scratchpad and became the agent's work. */
  promoted: readonly NoteState[];
  resumeNotes: Record<string, string>;
  widgets: readonly WidgetId[];
  dashboardChange: DashboardChange | null;
  receipt: TurnReceipt | null;
  setIntent: (intent: Intent) => void;
  answer: (askId: string, answer: Answer) => void;
  unanswer: (askId: string) => void;
  setDraft: (askId: string, text: string) => void;
  finishTurn: (receipt: TurnReceipt) => void;
  undoReceipt: () => void;
  addNote: (note: NoteState) => void;
  interpret: (noteId: string, interpretation: string) => void;
  confirmNote: (noteId: string) => void;
  dismissInterpretation: (noteId: string) => void;
  setResumeNote: (contextId: string, text: string) => void;
  clearResumeNote: (contextId: string) => void;
  setWidgets: (widgets: readonly WidgetId[]) => void;
  assistantChangeWidgets: (widgets: readonly WidgetId[], text: string) => void;
  undoDashboardChange: () => void;
  reset: () => void;
}

const initial = {
  intent: "all" as Intent,
  answers: {},
  drafts: {},
  notes: NOTES,
  promoted: [],
  resumeNotes: {},
  widgets: DEFAULT_WIDGETS,
  dashboardChange: null,
  receipt: null,
} satisfies Partial<TopLayerState>;

export const useTopLayerStore = create<TopLayerState>()((set) => ({
  ...initial,
  setIntent: (intent) => set({ intent }),
  answer: (askId, answer) => set((state) => ({ answers: { ...state.answers, [askId]: answer } })),
  setDraft: (askId, text) => set((state) => ({ drafts: { ...state.drafts, [askId]: text } })),
  unanswer: (askId) =>
    set((state) => {
      const { [askId]: _undone, ...answers } = state.answers;
      return { answers };
    }),
  finishTurn: (receipt) =>
    set((state) => {
      const { [receipt.contextId]: _done, ...resumeNotes } = state.resumeNotes;
      return { receipt, resumeNotes };
    }),
  undoReceipt: () =>
    set((state) => {
      if (!state.receipt) return {};
      const answers = { ...state.answers };
      for (const askId of state.receipt.askIds) delete answers[askId];
      return { answers, receipt: null };
    }),
  addNote: (note) => set((state) => ({ notes: [note, ...state.notes] })),
  interpret: (noteId, interpretation) =>
    set((state) => ({
      notes: state.notes.map((note) => (note.id === noteId ? { ...note, interpretation } : note)),
    })),
  confirmNote: (noteId) =>
    set((state) => {
      const note = state.notes.find((candidate) => candidate.id === noteId);
      if (!note) return {};
      return {
        notes: state.notes.filter((candidate) => candidate.id !== noteId),
        promoted: [note, ...state.promoted],
      };
    }),
  dismissInterpretation: (noteId) =>
    set((state) => ({
      notes: state.notes.map((note) =>
        note.id === noteId ? { ...note, interpretationDismissed: true } : note,
      ),
    })),
  setResumeNote: (contextId, text) =>
    set((state) => ({ resumeNotes: { ...state.resumeNotes, [contextId]: text } })),
  clearResumeNote: (contextId) =>
    set((state) => {
      const { [contextId]: _cleared, ...resumeNotes } = state.resumeNotes;
      return { resumeNotes };
    }),
  setWidgets: (widgets) => set({ widgets, dashboardChange: null }),
  assistantChangeWidgets: (widgets, text) =>
    set((state) => ({ widgets, dashboardChange: { text, before: state.widgets } })),
  undoDashboardChange: () =>
    set((state) =>
      state.dashboardChange ? { widgets: state.dashboardChange.before, dashboardChange: null } : {},
    ),
  reset: () => set(initial),
}));

/** Notes whose interpretation is waiting for your OK. */
export function awaitingOk(note: NoteState): boolean {
  return note.interpretation !== null && !note.interpretationDismissed;
}
