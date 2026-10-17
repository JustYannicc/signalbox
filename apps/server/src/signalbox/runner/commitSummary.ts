/**
 * The commit message the Runner writes for a change it commits itself (#518):
 * what changed, never what the user asked for, since a thread's prompts would
 * otherwise land in the repository's history when the branch is pushed. Titled
 * the way GitHub's web editor titles a commit (`Update foo.ts`), with the
 * files listed below as `git diff --name-status` lists them. Mask secrets in
 * the paths before summarising: a title cut short could cut one in half.
 */
import { ellipsize } from "@t3tools/shared/String";

/** One staged file, as `git diff --cached --name-status -M -z` reports it. */
export interface StagedChange {
  /** git's status letter: A, M, D, R, T, … */
  readonly status: string;
  readonly path: string;
  /** Where a renamed or copied file came from. */
  readonly from?: string;
}

const TITLE_MAX = 72;
const BODY_MAX = 50;

/** Parses `git diff --name-status -M -z`: renames and copies carry two paths and a score. */
export const parseNameStatus = (raw: string): ReadonlyArray<StagedChange> => {
  const fields = raw.split("\0");
  const changes: Array<StagedChange> = [];
  for (let i = 0; i < fields.length - 1;) {
    const status = fields[i]!.charAt(0);
    if (status === "R" || status === "C") {
      changes.push({ status, from: fields[i + 1]!, path: fields[i + 2]! });
      i += 3;
    } else {
      changes.push({ status, path: fields[i + 1]! });
      i += 2;
    }
  }
  return changes;
};

/** A path written so it stays on its line: control characters spelled out. */
const printable = (path: string) =>
  // eslint-disable-next-line no-control-regex -- finding control characters is the point.
  path.replace(/[\u0000-\u001f\u007f]/g, (char) =>
    char === "\n"
      ? "\\n"
      : char === "\t"
        ? "\\t"
        : `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

const VERBS: Record<string, string> = { A: "Add", C: "Add", D: "Delete", R: "Rename" };
const verbOf = (status: string) => VERBS[status] ?? "Update";

const singleTitle = (change: StagedChange) => {
  if (change.status !== "R" || change.from === undefined) {
    return `${verbOf(change.status)} ${basename(change.path)}`;
  }
  const [from, to] = [basename(change.from), basename(change.path)];
  // A file moved to another folder keeps its name: its paths say where.
  return from === to ? `Rename ${change.from} to ${change.path}` : `Rename ${from} to ${to}`;
};

/** `verb` and as many `names` as fit, the rest counted. */
const listTitle = (verb: string, names: ReadonlyArray<string>) => {
  for (let shown = names.length; shown > 0; shown--) {
    const rest = names.length - shown;
    const listed = names.slice(0, shown);
    const title =
      rest === 0
        ? `${verb} ${listed.slice(0, -1).join(", ")} and ${listed.at(-1)}`
        : `${verb} ${listed.join(", ")} and ${rest} more ${rest === 1 ? "file" : "files"}`;
    if (title.length <= TITLE_MAX) return title;
  }
  return `${verb} ${names.length} files`;
};

const title = (changes: ReadonlyArray<StagedChange>) => {
  if (changes.length === 1) return ellipsize(printable(singleTitle(changes[0]!)), TITLE_MAX);
  const verbs = new Set(changes.map((change) => verbOf(change.status)));
  const verb = verbs.size === 1 ? [...verbs][0]! : "Change";
  const names = changes.map((change) =>
    printable(basename(verb === "Rename" ? (change.from ?? change.path) : change.path)),
  );
  return listTitle(verb, names);
};

/** The commit message for `changes`: a title of at most 72 characters, then one line per file. */
export const commitSummary = (changes: ReadonlyArray<StagedChange>) => {
  if (changes.length === 0) return "Save changes";
  const lines = changes
    .slice(0, BODY_MAX)
    .map((change) =>
      [change.status, ...(change.from === undefined ? [] : [change.from]), change.path]
        .map(printable)
        .join("\t"),
    );
  if (changes.length > BODY_MAX) lines.push(`…and ${changes.length - BODY_MAX} more`);
  return `${title(changes)}\n\n${lines.join("\n")}`;
};
