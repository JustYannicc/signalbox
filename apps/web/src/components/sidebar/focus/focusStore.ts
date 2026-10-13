/**
 * Focus: which level of the Home tree is in sight. Focusing a level (Work,
 * Personal, any section) keeps that subtree and the levels above it; the top
 * level means All. It's only a view: hidden work keeps running and agents'
 * access never changes (see `focusLevels.ts` for the rules). The tree shows a
 * "Work hidden" chip that can peek. Client signals (time, Wi-Fi, NFC) can
 * switch Focus through the "Work out of sight" automation; the switcher marks
 * a level a rule set with "(auto)".
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { prototypeStorage } from "../../../lib/prototypeStorage";
import { TOP_LEVEL, type LevelKey } from "../../levels/levels";
import { liveFocusedLevel } from "./focusLevels";

/** The automation that owns the rules below (`/home/automations/$automationId`). */
export const FOCUS_AUTOMATION_ID = "work-out-of-sight";

export interface FocusRule {
  readonly id: string;
  /** Signal and direction, e.g. "17:00 → Personal". */
  readonly label: string;
  readonly level: LevelKey;
}

/** PLACEHOLDER: mirrors the triggers in the "Work out of sight" automation fixture. */
export const FOCUS_RULES: readonly FocusRule[] = [
  { id: "time", label: "17:00 → Personal", level: "section:personal" },
  { id: "wifi", label: "Leave northwind-office Wi-Fi → Personal", level: "section:personal" },
  { id: "nfc", label: "NFC desk → Work", level: "section:work" },
];

interface FocusState {
  /** The level in sight; `TOP_LEVEL` shows everything. */
  focusedLevel: LevelKey;
  /** The rule that set the current level, or `null` when you picked it. */
  setByRuleId: string | null;
  /** Transient: hidden sections shown for a look without switching Focus. */
  peeking: boolean;
  focusLevel: (level: LevelKey) => void;
  /** For automations: a rule switches Focus and is credited with it. */
  applyRule: (ruleId: string) => void;
  togglePeek: () => void;
}

/** v1 stored a mode; each mode was a root section. */
const LEVEL_FOR_V1_MODE: Readonly<Record<string, LevelKey>> = {
  work: "section:work",
  personal: "section:personal",
};

type PersistedFocus = Pick<FocusState, "focusedLevel" | "setByRuleId">;

export function migrateFocus(persisted: unknown, version: number): PersistedFocus {
  const state = (persisted ?? {}) as Partial<PersistedFocus> & { mode?: string };
  const setByRuleId = state.setByRuleId ?? null;
  if (version >= 2) return { focusedLevel: state.focusedLevel ?? TOP_LEVEL, setByRuleId };
  return { focusedLevel: LEVEL_FOR_V1_MODE[state.mode ?? ""] ?? TOP_LEVEL, setByRuleId };
}

export const useFocusStore = create<FocusState>()(
  persist(
    (set) => ({
      focusedLevel: TOP_LEVEL,
      setByRuleId: null,
      peeking: false,
      focusLevel: (focusedLevel) => set({ focusedLevel, setByRuleId: null, peeking: false }),
      applyRule: (ruleId) => {
        const rule = FOCUS_RULES.find((candidate) => candidate.id === ruleId);
        if (rule) set({ focusedLevel: rule.level, setByRuleId: rule.id, peeking: false });
      },
      togglePeek: () => set((state) => ({ peeking: !state.peeking })),
    }),
    {
      name: "t3code:sidebar:focus:v1",
      version: 2,
      storage: prototypeStorage(),
      partialize: (state) => ({ focusedLevel: state.focusedLevel, setByRuleId: state.setByRuleId }),
      migrate: migrateFocus,
    },
  ),
);

/** The focused level, falling back to the top level when its section is gone. */
export function useFocusedLevel(): LevelKey {
  return liveFocusedLevel(useFocusStore((state) => state.focusedLevel));
}
