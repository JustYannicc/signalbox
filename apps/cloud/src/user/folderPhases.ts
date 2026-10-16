import type { SignalboxContext } from "@t3tools/contracts/signalboxContexts";
import {
  findFolderPhase,
  FOLDER_PHASE_TEMPLATES,
  folderPhasesProblem,
  type FolderPhase,
  type FolderSetPhaseInput,
} from "@t3tools/contracts/signalboxFolders";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * A folder's phase (#677), decided without storage. `UserFolders` stores it
 * as two columns: the list as JSON (`phases`) and the current one (`phase`).
 */

const decodeList = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)));

/** The stored columns as a phase; null when there's none or they don't make one. */
export const phaseOfColumns = (
  phases: string | null | undefined,
  current: string | null | undefined,
): FolderPhase | null => {
  if (phases == null || current == null) return null;
  const list = decodeList(phases);
  if (Option.isNone(list) || !list.value.includes(current)) return null;
  return { phases: list.value, current };
};

export const columnsOfPhase = (phase: FolderPhase | null) => ({
  phases: phase === null ? null : JSON.stringify(phase.phases),
  phase: phase?.current ?? null,
});

/** A folder's phase after a change, or why it was refused, for the user. */
type Decided = { readonly phase: FolderPhase | null } | { readonly refused: string };

/** `phases` trimmed, starting at `current` or the first; refused when they can't be a folder's. */
const phaseOf = (phases: ReadonlyArray<string>, current?: string): Decided => {
  const list = phases.map((name) => name.trim());
  const problem = folderPhasesProblem(list);
  if (problem !== null) return { refused: problem };
  const found = current === undefined ? undefined : findFolderPhase(list, current);
  return { phase: { phases: list, current: found ?? list[0]! } };
};

/** A new folder's phase: the one asked for, else its tree's template, at the first phase. */
export const initialPhase = (
  kind: SignalboxContext["kind"],
  asked: ReadonlyArray<string> | null | undefined,
): Decided => (asked === null ? { phase: null } : phaseOf(asked ?? FOLDER_PHASE_TEMPLATES[kind]));

/**
 * `input` applied to `now`: the folder's next phase, or why it was refused,
 * for the user.
 */
export const nextPhase = (
  now: FolderPhase | null,
  input: Pick<FolderSetPhaseInput, "phases" | "current">,
): Decided => {
  if (input.phases === null) {
    return input.current === undefined
      ? { phase: null }
      : { refused: "A folder without a phase has no phase to move to." };
  }
  const phases = input.phases ?? now?.phases;
  if (phases === undefined) return { refused: "This folder has no phases yet. Add some first." };
  if (input.current !== undefined && findFolderPhase(phases, input.current) === undefined) {
    return { refused: `"${input.current.trim()}" isn't one of this folder's phases.` };
  }
  return phaseOf(phases, input.current ?? now?.current);
};

export const samePhase = (left: FolderPhase | null, right: FolderPhase | null) =>
  left === null || right === null
    ? left === right
    : left.current === right.current &&
      left.phases.length === right.phases.length &&
      left.phases.every((phase, index) => phase === right.phases[index]);
