/**
 * Focus: which slice of the Home tree is in sight. Work hides Personal
 * sections, Personal hides Work, All shows everything. Hidden work keeps
 * running; the tree shows a "Work hidden" chip that can peek at it. Client
 * signals (time, Wi-Fi, NFC) can switch Focus through the "Work out of sight"
 * automation; the switcher marks a mode a rule set with "(auto)".
 */
import { BriefcaseIcon, CoffeeIcon, LayersIcon, type LucideIcon } from "lucide-react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../../lib/storage";
import { rootSectionIdOf } from "../sections/sectionModel";

export type FocusMode = "work" | "personal" | "all";

export interface FocusModeInfo {
  readonly mode: FocusMode;
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
  /** Root section ids kept out of sight in this mode. */
  readonly hiddenRootSectionIds: readonly string[];
}

const FOCUS_MODE_INFO: Record<FocusMode, FocusModeInfo> = {
  work: {
    mode: "work",
    label: "Work",
    description: "Hides Personal",
    icon: BriefcaseIcon,
    hiddenRootSectionIds: ["personal"],
  },
  personal: {
    mode: "personal",
    label: "Personal",
    description: "Hides Work",
    icon: CoffeeIcon,
    hiddenRootSectionIds: ["work"],
  },
  all: {
    mode: "all",
    label: "All",
    description: "Everything in sight",
    icon: LayersIcon,
    hiddenRootSectionIds: [],
  },
};

export const FOCUS_MODES: readonly FocusModeInfo[] = [
  FOCUS_MODE_INFO.work,
  FOCUS_MODE_INFO.personal,
  FOCUS_MODE_INFO.all,
];

/** The automation that owns the rules below (`/automations/$automationId`). */
export const FOCUS_AUTOMATION_ID = "work-out-of-sight";

export interface FocusRule {
  readonly id: string;
  /** Signal and direction, e.g. "17:00 → Personal". */
  readonly label: string;
  readonly mode: FocusMode;
}

/** PLACEHOLDER: mirrors the triggers in the "Work out of sight" automation fixture. */
export const FOCUS_RULES: readonly FocusRule[] = [
  { id: "time", label: "17:00 → Personal", mode: "personal" },
  { id: "wifi", label: "Leave northwind-office Wi-Fi → Personal", mode: "personal" },
  { id: "nfc", label: "NFC desk → Work", mode: "work" },
];

export function focusModeInfo(mode: FocusMode): FocusModeInfo {
  // Guards a stale or hand-edited persisted value.
  return FOCUS_MODE_INFO[mode] ?? FOCUS_MODE_INFO.all;
}

interface FocusState {
  mode: FocusMode;
  /** The rule that set the current mode, or `null` when you picked it. */
  setByRuleId: string | null;
  /** Transient: hidden sections shown for a look without switching Focus. */
  peeking: boolean;
  setMode: (mode: FocusMode) => void;
  /** For automations: a rule switches Focus and is credited with it. */
  applyRule: (ruleId: string) => void;
  togglePeek: () => void;
}

export const useFocusStore = create<FocusState>()(
  persist(
    (set) => ({
      mode: "all",
      setByRuleId: null,
      peeking: false,
      setMode: (mode) => set({ mode, setByRuleId: null, peeking: false }),
      applyRule: (ruleId) => {
        const rule = FOCUS_RULES.find((candidate) => candidate.id === ruleId);
        if (rule) set({ mode: rule.mode, setByRuleId: rule.id, peeking: false });
      },
      togglePeek: () => set((state) => ({ peeking: !state.peeking })),
    }),
    {
      name: "t3code:sidebar:focus:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ mode: state.mode, setByRuleId: state.setByRuleId }),
    },
  ),
);

export function useFocusMode(): FocusMode {
  return useFocusStore((state) => state.mode);
}

/**
 * Whether an item is in sight under Focus. Items outside any section (the top
 * level) always are; peeking does not count, so badges stay calm.
 */
export function isInFocus(
  item: { readonly sectionId: string | null },
  mode: FocusMode = useFocusStore.getState().mode,
): boolean {
  if (item.sectionId === null) return true;
  return !focusModeInfo(mode).hiddenRootSectionIds.includes(rootSectionIdOf(item.sectionId));
}
