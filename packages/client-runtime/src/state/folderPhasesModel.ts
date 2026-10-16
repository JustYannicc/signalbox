import {
  findFolderPhase,
  FOLDER_PHASE_TEMPLATES,
  type FolderPhase,
  folderPhasesProblem,
} from "@t3tools/contracts/signalboxFolders";
import type { SignalboxContext } from "@t3tools/contracts/signalboxContexts";

/**
 * A folder's phase (#677) as clients edit it: its phases typed one per line,
 * and which stays current. Web's dialog and mobile's sheet both edit with it.
 */

/** Phases as the editor shows them, one per line. */
const folderPhasesText = (phases: ReadonlyArray<string>) => phases.join("\n");

/** The template for a folder in a tree of `kind`, as editor text. */
export const folderPhaseTemplateText = (kind: SignalboxContext["kind"]) =>
  folderPhasesText(FOLDER_PHASE_TEMPLATES[kind]);

/** The templates the editor offers to start from. */
export const FOLDER_PHASE_TEMPLATE_CHOICES = [
  { kind: "organization", label: "Work project" },
  { kind: "personal", label: "Personal" },
] as const satisfies ReadonlyArray<{ kind: SignalboxContext["kind"]; label: string }>;

/** What the editor opens with: the folder's phases, else its tree's template. */
export const folderPhasesEditorText = (
  phase: FolderPhase | undefined,
  kind: SignalboxContext["kind"],
) => (phase === undefined ? folderPhaseTemplateText(kind) : folderPhasesText(phase.phases));

/**
 * What the editor's `text` saves: the phases, trimmed with blank lines
 * dropped, and the one that stays current. That's the current phase when
 * it's still there, else the line where it was (a rename), else the first.
 * `problem` says why it can't be saved yet, and `unchanged` that there's
 * nothing to save.
 */
export function folderPhaseEdit(
  before: FolderPhase | undefined,
  text: string,
): {
  readonly phases: ReadonlyArray<string>;
  readonly current: string | undefined;
  readonly problem: string | null;
  /** The line under the editor: the problem, else where the folder will be. */
  readonly status: string;
  readonly unchanged: boolean;
} {
  const phases = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const kept = before === undefined ? undefined : findFolderPhase(phases, before.current);
  // Same number of lines: the current one was renamed. Otherwise it was removed.
  const renamed =
    before === undefined || before.phases.length !== phases.length
      ? undefined
      : phases[before.phases.indexOf(before.current)];
  const current = kept ?? renamed ?? phases[0];
  const problem = folderPhasesProblem(phases);
  return {
    phases,
    current,
    problem,
    status: problem ?? (current === undefined ? "" : `Now in ${current}.`),
    unchanged:
      before !== undefined &&
      before.current === current &&
      folderPhasesText(before.phases) === folderPhasesText(phases),
  };
}
