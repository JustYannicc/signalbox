import type { VcsStatusResult } from "@t3tools/contracts";

/** What the thread details' Changes row shows. */
export type ChangesTotals =
  | { readonly kind: "counted"; readonly insertions: number; readonly deletions: number }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * The branch's changes against its base when the server counted them, and why
 * not when it tried and couldn't, so the row never shows a zero nobody
 * counted (#864). A server that doesn't count them falls back to the working
 * tree, as a self-hosted one always has.
 */
export function resolveChangesTotals(
  status: Pick<VcsStatusResult, "branchChanges" | "branchChangesError" | "workingTree"> | null,
): ChangesTotals {
  if (status?.branchChanges) {
    const { insertions, deletions } = status.branchChanges;
    return { kind: "counted", insertions, deletions };
  }
  if (status?.branchChangesError) {
    return { kind: "unavailable", reason: status.branchChangesError };
  }
  return {
    kind: "counted",
    insertions: status?.workingTree.insertions ?? 0,
    deletions: status?.workingTree.deletions ?? 0,
  };
}
