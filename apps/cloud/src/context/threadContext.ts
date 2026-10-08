import type { SearchHit, ThreadTurn } from "@signalbox/runner-protocol/ContextProtocol";
import type { OrchestrationV2ThreadProjection, ProjectId } from "@t3tools/contracts";

import { parseCheckpointRange } from "../thread/runner/driveItems.ts";
import { excerpt, matchTerms } from "./contextMatch.ts";

/**
 * What the context tool reads of one thread, computed from its projection in
 * the thread's own object so only the answer crosses the wire: its turns,
 * each with its messages, changed files and the commits its checkpoint names,
 * and which of a query's words its title, files and conversation hold.
 */

type Projection = OrchestrationV2ThreadProjection;

/** Characters of a message `threadTurns` keeps: a little per turn in the outline, a lot for one turn. */
const OUTLINE_MESSAGE_CHARS = 600;
const TURN_MESSAGE_CHARS = 20_000;
/** Messages a search hit points at, and files it lists. */
const MAX_HIT_MESSAGES = 5;
const MAX_HIT_FILES = 40;

const cut = (text: string, limit: number) =>
  text.length <= limit
    ? { text, truncated: false }
    : { text: `${text.slice(0, limit)}…`, truncated: true };

/** Each message's turn: its run's ordinal, through the run or as the run's own prompt. */
const turnOfMessage = (projection: Projection) => {
  const byRun = new Map(projection.runs.map((run) => [run.id as string, run.ordinal]));
  const byPrompt = new Map(
    projection.runs.map((run) => [run.userMessageId as string, run.ordinal]),
  );
  return (message: Projection["messages"][number]) =>
    (message.runId === null ? undefined : byRun.get(message.runId)) ??
    byPrompt.get(message.id) ??
    null;
};

const conversation = (projection: Projection) =>
  projection.messages.filter(
    (message) => (message.role === "user" || message.role === "assistant") && message.text !== "",
  );

/** Each turn's checkpoint: the files it saved and the commits they are between. */
const checkpointsByTurn = (projection: Projection) => {
  const ordinals = new Map(projection.runs.map((run) => [run.id as string, run.ordinal]));
  const out = new Map<number, Projection["checkpoints"][number]>();
  for (const checkpoint of projection.checkpoints) {
    const turn = checkpoint.runId === null ? undefined : ordinals.get(checkpoint.runId);
    if (turn !== undefined && checkpoint.status === "ready") out.set(turn, checkpoint);
  }
  return out;
};

const commitsOf = (turn: number, checkpoint: Projection["checkpoints"][number] | undefined) => {
  const range = checkpoint === undefined ? null : parseCheckpointRange(checkpoint.ref);
  return range === null ? null : { turn, start: range.start, commit: range.commit };
};

/** The thread's turns in order. `only`: that turn in full; otherwise every turn, messages cut short. */
export const threadTurns = (
  projection: Projection,
  only: number | null,
): ReadonlyArray<ThreadTurn> => {
  const turnOf = turnOfMessage(projection);
  const checkpoints = checkpointsByTurn(projection);
  const limit = only === null ? OUTLINE_MESSAGE_CHARS : TURN_MESSAGE_CHARS;
  const messages = conversation(projection);
  return [...projection.runs]
    .sort((left, right) => left.ordinal - right.ordinal)
    .filter((run) => only === null || run.ordinal === only)
    .map((run) => {
      const checkpoint = checkpoints.get(run.ordinal);
      return {
        turn: run.ordinal,
        messages: messages
          .filter((message) => turnOf(message) === run.ordinal)
          .map((message) => ({
            messageId: message.id,
            role: message.role,
            ...cut(message.text, limit),
          })),
        files: (checkpoint?.files ?? []).map((file) => ({
          path: file.path,
          kind: file.kind,
          additions: file.additions,
          deletions: file.deletions,
        })),
        commits: commitsOf(run.ordinal, checkpoint),
      };
    });
};

/** What a thread object answers for `contextTurns`. */
export interface ThreadContextTurns {
  readonly title: string;
  readonly projectId: ProjectId;
  readonly turns: ReadonlyArray<ThreadTurn>;
}

export type ThreadMatch = Omit<
  Extract<SearchHit, { readonly kind: "thread" }>,
  "kind" | "threadId" | "driveId"
>;

/** Which of `terms` the thread holds, where; null when it holds none. */
export const matchThread = (
  projection: Projection,
  terms: ReadonlyArray<string>,
): ThreadMatch | null => {
  const turnOf = turnOfMessage(projection);
  const checkpoints = checkpointsByTurn(projection);
  const files = [
    ...new Set(
      [...checkpoints.values()].flatMap((checkpoint) => checkpoint.files.map((file) => file.path)),
    ),
  ];
  const messages = conversation(projection);
  const matched = matchTerms(terms, [
    projection.thread.title,
    ...files,
    ...messages.map((message) => message.text),
  ]);
  if (matched.length === 0) return null;
  const pointed = messages.flatMap((message) => {
    const found = excerpt(message.text, matched);
    return found === null
      ? []
      : [{ messageId: message.id, turn: turnOf(message), role: message.role, excerpt: found }];
  });
  // Files that hold a word first: they are what the work touched.
  const lowered = (path: string) => path.toLowerCase();
  const ranked = [
    ...files.filter((path) => matched.some((term) => lowered(path).includes(term))),
    ...files.filter((path) => !matched.some((term) => lowered(path).includes(term))),
  ];
  return {
    title: projection.thread.title,
    matched,
    files: ranked.slice(0, MAX_HIT_FILES),
    messages: pointed.slice(0, MAX_HIT_MESSAGES),
    turns: [...checkpoints.entries()]
      .sort(([left], [right]) => left - right)
      .flatMap(([turn, checkpoint]) => {
        const commits = commitsOf(turn, checkpoint);
        return commits === null ? [] : [commits];
      }),
  };
};
