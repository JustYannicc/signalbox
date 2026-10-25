export const THINKING_ONLY_RETRY_PROFILE = Object.freeze({
  profile: "claude-2.1.303-thinking-only-retry",
  releaseVersion: "2.1.303",
  contentSha256: "1b8233d9ec5f3b55b8cb2e5370012a0b9118f26b3b4d9cb2cde7e4ae28a23b20",
});

export type ReplayInputOutcome = "terminal" | "nonterminal" | "response-less";

export interface ReplayInputBoundary {
  readonly responseMessageCount: number;
  readonly outcome: ReplayInputOutcome;
}

export interface ThinkingOnlyCompanion {
  readonly profile: string;
  readonly contentSha256: string;
  readonly isMeta: true;
  readonly turnCompanion: true;
}

export interface ReplayInputInterval {
  startIndex: number;
  endIndex: number;
  responseMessageCount: number;
  outcome: ReplayInputOutcome;
  generated: Array<ThinkingOnlyCompanion & { readonly index: number }>;
}

interface RecordedCompanion {
  readonly type?: unknown;
  readonly isMeta?: unknown;
  readonly turnCompanion?: unknown;
  readonly message?: {
    readonly role?: unknown;
    readonly content?: unknown;
  };
}

interface CompanionClassification {
  readonly profile: string;
  readonly contentSha256: string;
}

const OUTCOMES = new Set<ReplayInputOutcome>(["terminal", "nonterminal", "response-less"]);
const INTERVALS_ERROR = "ERR_REPLAY_INPUT_INTERVALS_COMPANIONS";

export async function classifyThinkingOnlyCompanion(
  record: unknown,
  { releaseVersion }: { readonly releaseVersion?: string } = {},
): Promise<CompanionClassification | null> {
  if (!record || typeof record !== "object") return null;
  const candidate = record as RecordedCompanion;
  if (
    releaseVersion !== THINKING_ONLY_RETRY_PROFILE.releaseVersion ||
    candidate.type !== "user" ||
    candidate.isMeta !== true ||
    candidate.turnCompanion !== true ||
    candidate.message?.role !== "user" ||
    typeof candidate.message.content !== "string"
  ) {
    return null;
  }

  const bytes = new TextEncoder().encode(candidate.message.content);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const contentSha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (contentSha256 !== THINKING_ONLY_RETRY_PROFILE.contentSha256) return null;

  return {
    profile: THINKING_ONLY_RETRY_PROFILE.profile,
    contentSha256,
  };
}

export function createReplayInputIntervals(
  boundaries: readonly ReplayInputBoundary[],
  companions: readonly (ThinkingOnlyCompanion & { readonly index: number })[] = [],
): ReplayInputInterval[] {
  if (!Array.isArray(boundaries) || !Array.isArray(companions)) {
    throw new Error(INTERVALS_ERROR);
  }

  for (const boundary of boundaries as readonly unknown[]) {
    if (
      !boundary ||
      typeof boundary !== "object" ||
      !Number.isSafeInteger((boundary as ReplayInputBoundary).responseMessageCount) ||
      (boundary as ReplayInputBoundary).responseMessageCount < 0 ||
      !OUTCOMES.has((boundary as ReplayInputBoundary).outcome)
    ) {
      throw new Error(INTERVALS_ERROR);
    }
  }

  const byIndex = new Map<number, ThinkingOnlyCompanion & { readonly index: number }>();
  let previousIndex = -1;
  for (const companion of companions as readonly unknown[]) {
    if (
      !companion ||
      typeof companion !== "object" ||
      !Number.isSafeInteger((companion as { readonly index?: unknown }).index) ||
      (companion as { readonly index: number }).index <= 0 ||
      (companion as { readonly index: number }).index >= boundaries.length ||
      (companion as { readonly index: number }).index <= previousIndex ||
      (companion as ThinkingOnlyCompanion).profile !== THINKING_ONLY_RETRY_PROFILE.profile ||
      (companion as ThinkingOnlyCompanion).contentSha256 !==
        THINKING_ONLY_RETRY_PROFILE.contentSha256 ||
      (companion as ThinkingOnlyCompanion).isMeta !== true ||
      (companion as ThinkingOnlyCompanion).turnCompanion !== true
    ) {
      throw new Error(INTERVALS_ERROR);
    }
    const indexed = companion as ThinkingOnlyCompanion & { readonly index: number };
    previousIndex = indexed.index;
    byIndex.set(indexed.index, indexed);
  }

  const intervals: ReplayInputInterval[] = [];
  for (let index = 0; index < boundaries.length; index += 1) {
    const boundary = boundaries[index]!;
    const companion = byIndex.get(index);
    if (companion) {
      const previous = intervals.at(-1);
      if (!previous) throw new Error(INTERVALS_ERROR);
      const responseMessageCount = previous.responseMessageCount + boundary.responseMessageCount;
      if (!Number.isSafeInteger(responseMessageCount)) throw new Error(INTERVALS_ERROR);
      previous.endIndex = index;
      previous.responseMessageCount = responseMessageCount;
      previous.outcome = boundary.outcome;
      previous.generated.push({
        index,
        profile: companion.profile,
        contentSha256: companion.contentSha256,
        isMeta: companion.isMeta,
        turnCompanion: companion.turnCompanion,
      });
      continue;
    }

    intervals.push({
      startIndex: index,
      endIndex: index,
      responseMessageCount: boundary.responseMessageCount,
      outcome: boundary.outcome,
      generated: [],
    });
  }

  return intervals;
}
