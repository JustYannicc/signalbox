/**
 * PLACEHOLDER agent turn for messages sent from this device. It lands live
 * (reasoning plus a running search) and settles into a finished turn after one
 * short timer, the way a real turn runs and ends. The finished answer already
 * sits in the live message's body; settling only drops the live flags, so a
 * reload (which loses the timer) shows the finished turn instead of a stuck one.
 */
import { localMessageId, nowLabel, settleTurn, useLocalMessagesStore } from "./localMessages";
import type { HarnessRef, TeamMessage, TeamPerson, WorkStep } from "./multiplayerModel";
import { joinNames } from "./sharing";

const SETTLE_MS = 3_500;

const STOPWORDS = new Set(
  "about after again also because before being could does doing from have into just like make more only other should some than that their them then there these they this those very want what when where which while with would your".split(
    " ",
  ),
);

/** The word the agent would grep for: the longest non-filler word in the prompt. */
function keywordOf(prompt: string): string {
  const words = prompt
    .replace(/@\[[^\]]*\]|@\S+/g, " ")
    .toLowerCase()
    .match(/[a-z][a-z0-9_-]{3,}/g);
  const candidates = (words ?? []).filter((word) => !STOPWORDS.has(word));
  return candidates.reduce((best, word) => (word.length > best.length ? word : best), "") || "todo";
}

/** Small stable number from the prompt, so the same send reads the same way. */
function spread(text: string, range: number): number {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % range;
}

function camel(word: string): string {
  return word.replace(/[-_]+(\w)/g, (_, next: string) => next.toUpperCase());
}

/** The work and final answer for a prompt: a lookup for questions, an edit for requests. */
function cannedTurn(prompt: string): {
  reasoning: string;
  search: WorkStep;
  work: WorkStep[];
  answer: string;
} {
  const keyword = keywordOf(prompt);
  const name = camel(keyword);
  const matches = 3 + spread(prompt, 6);
  const file = `src/${name}/${name}.ts`;
  const other = `src/${name}/${name}Store.ts`;
  const search: WorkStep = {
    label: "Search",
    itemType: "command_execution",
    command: `rg -n "${keyword}" src`,
    detail: `${matches} matches in 2 files`,
  };
  if (prompt.includes("?")) {
    return {
      search,
      reasoning: `Question about ${keyword}. Finding where it's defined before answering.`,
      work: [
        search,
        { label: "Read", itemType: "command_execution", command: `sed -n 1,120p ${file}` },
      ],
      answer: `\`${keyword}\` lives in two places: \`${file}\` computes it and \`${other}\` caches the result. Which one do you mean? The answer differs: the first is pure, the second survives reloads.`,
    };
  }
  const added = 4 + spread(prompt, 20);
  const removed = 1 + spread(`${prompt}-`, 6);
  return {
    search,
    reasoning: `Change request touching ${keyword}. Finding the call sites first, then a focused edit and its test.`,
    work: [
      search,
      { label: "Edited files", itemType: "file_change", changedFiles: [file] },
      {
        label: "Run tests",
        itemType: "command_execution",
        command: `vp test run ${file.replace(/\.ts$/, ".test.ts")}`,
        detail: `${matches + 2} passed`,
      },
    ],
    answer: `Done. \`${file}\` changed (+${added} −${removed}); the ${matches} call sites keep working unchanged, and the focused tests pass. Nothing is pushed.`,
  };
}

/** "Notified Flynn" as a timeline event, or nothing when nobody was. */
export function notifiedLine(notified: readonly TeamPerson[], at: number): TeamMessage[] {
  if (notified.length === 0) return [];
  return [
    {
      id: localMessageId(),
      author: { kind: "system", event: "notify" },
      body: `Notified ${joinNames(notified, "them")}`,
      at: nowLabel(),
      createdAt: new Date(at).toISOString(),
    },
  ];
}

/**
 * Appends the agent's turn answering `prompt` (from `startedById`), live, then
 * settles it after a beat. `notified` people get a meta line first, not agent chatter.
 */
export function startAgentTurn(
  threadId: string,
  input: {
    harness: HarnessRef;
    startedById: string;
    prompt: string;
    notified?: readonly TeamPerson[];
    /** Earlier messages to append in the same write, e.g. the prompt itself. */
    before?: readonly TeamMessage[];
  },
): void {
  const startedAt = Date.now();
  const turn = cannedTurn(input.prompt);
  const author = {
    kind: "agent" as const,
    name: input.harness.provider === "codex" ? "Codex" : "Claude",
    startedById: input.startedById,
    harness: input.harness,
  };
  // Only the search has started when the turn appears; the rest lands on settle.
  const live: TeamMessage = {
    id: localMessageId(),
    author,
    live: "working",
    reasoning: turn.reasoning,
    work: [{ ...turn.search, running: true }],
    body: turn.answer,
    at: nowLabel(),
    createdAt: new Date(startedAt + 1_000).toISOString(),
  };
  useLocalMessagesStore
    .getState()
    .addTeam(threadId, [
      ...(input.before ?? []),
      ...notifiedLine(input.notified ?? [], startedAt + 500),
      live,
    ]);
  window.setTimeout(() => {
    useLocalMessagesStore.getState().replaceTeam(
      threadId,
      settleTurn({
        ...live,
        work: turn.work,
        at: nowLabel(),
        createdAt: new Date().toISOString(),
      }),
    );
  }, SETTLE_MS);
}
