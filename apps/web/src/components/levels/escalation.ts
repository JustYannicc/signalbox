/**
 * Escalation rules: what may break through Focus, and to which devices. A rule
 * lives at a level and holds for that level and everything inside it, like
 * "at terminal-app, approvals and failures reach my phone even when Work is
 * hidden". Focus asks `escalates` (its `breaksThroughFocus` seam); delivery
 * adds the rule's devices whatever Focus hides (`delivery.ts`). PLACEHOLDER:
 * prototype state, edited in Settings › Notifications.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { prototypeStorage } from "../../lib/prototypeStorage";
import type { ThreadDisplayStatus } from "../threadStatusDisplay";
import { levelChain, TOP_LEVEL, type LevelKey } from "./levels";

/** The statuses worth breaking through for: the ones that need you, or broke. */
export const ESCALATION_STATUSES = [
  "approval",
  "input",
  "failed",
] as const satisfies readonly ThreadDisplayStatus[];
export type EscalationStatus = (typeof ESCALATION_STATUSES)[number];

export const ESCALATION_STATUS_LABEL: Record<EscalationStatus, string> = {
  approval: "Approvals",
  input: "Questions",
  failed: "Failures",
};

export interface EscalationRule {
  readonly id: string;
  /** Holds here and inside. */
  readonly level: LevelKey;
  readonly statuses: readonly EscalationStatus[];
  /** Client device ids (`devices/devicesFixtures.ts`) it reaches. */
  readonly deviceIds: readonly string[];
}

/** Something that could escalate: the levels it sits at (empty = the top level) and its status. */
export interface EscalationSubject {
  readonly levels: readonly LevelKey[];
  readonly status: ThreadDisplayStatus | null;
}

type Placement = Parameters<typeof levelChain>[1];

export const ESCALATION_RULE_FIXTURES: readonly EscalationRule[] = [
  {
    id: "terminal-app-urgent",
    level: "team-project:terminal-app",
    statuses: ["approval", "failed"],
    deviceIds: ["pixel"],
  },
];

const isEscalationStatus = (status: ThreadDisplayStatus | null): status is EscalationStatus =>
  ESCALATION_STATUSES.some((candidate) => candidate === status);

/** The rules holding for the subject: at one of its levels or above, naming its status. */
export function matchingRules(
  subject: EscalationSubject,
  rules: readonly EscalationRule[],
  placement?: Placement,
): readonly EscalationRule[] {
  const { status } = subject;
  if (!isEscalationStatus(status)) return [];
  const chains = (subject.levels.length > 0 ? subject.levels : [TOP_LEVEL]).map((level) =>
    levelChain(level, placement),
  );
  return rules.filter(
    (rule) => rule.statuses.includes(status) && chains.some((chain) => chain.includes(rule.level)),
  );
}

/** The rules that hold at `level`: set there or on a level above it. */
export function rulesAt(
  level: LevelKey,
  rules: readonly EscalationRule[],
  placement?: Placement,
): readonly EscalationRule[] {
  const chain = levelChain(level, placement);
  return rules.filter((rule) => chain.includes(rule.level));
}

/** "Approvals and failures reach Pixel 8 Pro, even when out of sight." */
export function describeEscalation(
  rule: Pick<EscalationRule, "statuses" | "deviceIds">,
  deviceName: (deviceId: string) => string,
): string {
  const statuses = ESCALATION_STATUSES.filter((status) => rule.statuses.includes(status));
  if (statuses.length === 0) return "Nothing breaks through yet.";
  const what = joinWords(
    statuses.map((status, index) =>
      index === 0 ? ESCALATION_STATUS_LABEL[status] : ESCALATION_STATUS_LABEL[status].toLowerCase(),
    ),
  );
  const where = joinWords(rule.deviceIds.map(deviceName));
  return where ? `${what} reach ${where}, even when out of sight.` : `${what} show through Focus.`;
}

/** "A", "A and B", "A, B and C". */
export function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

interface EscalationState {
  rules: readonly EscalationRule[];
  addRule: (rule: EscalationRule) => void;
  updateRule: (id: string, patch: Partial<Omit<EscalationRule, "id">>) => void;
  removeRule: (id: string) => void;
}

export const useEscalationStore = create<EscalationState>()(
  persist(
    (set) => ({
      rules: ESCALATION_RULE_FIXTURES,
      addRule: (rule) => set((state) => ({ rules: [...state.rules, rule] })),
      updateRule: (id, patch) =>
        set((state) => ({
          rules: state.rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)),
        })),
      removeRule: (id) => set((state) => ({ rules: state.rules.filter((rule) => rule.id !== id) })),
    }),
    { name: "t3code:levels:escalation:v1", version: 1, storage: prototypeStorage() },
  ),
);

/**
 * Whether the subject may break through Focus at `focusedLevel`: a rule holds
 * for it. Under All (the top level) nothing is hidden, so nothing has to.
 * Rules default to the saved ones.
 */
export function escalates(
  subject: EscalationSubject,
  focusedLevel: LevelKey,
  rules: readonly EscalationRule[] = useEscalationStore.getState().rules,
  placement?: Placement,
): boolean {
  if (focusedLevel === TOP_LEVEL) return false;
  return matchingRules(subject, rules, placement).length > 0;
}
