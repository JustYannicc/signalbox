/**
 * The New bar's inline context: `#` tokens file a capture (project, section,
 * chat), `@` tokens hand it to someone (person, agent), and `+` tokens share
 * it (person, team) or keep it private. Captures are private by default.
 * Pasted links and dropped files ride along as chips. Pure helpers; the form
 * owns the state.
 */
import type { ScopedProjectRef } from "@t3tools/contracts";

export type CaptureTokenKind =
  | "project"
  | "section"
  | "chat"
  | "person"
  | "agent"
  | "share"
  | "private";
export type CaptureTrigger = "#" | "@" | "+";

export interface CaptureToken {
  readonly id: string;
  readonly kind: CaptureTokenKind;
  readonly label: string;
  /** Real projects and threads carry their project, so ⌘↵ opens the draft there. */
  readonly projectRef?: ScopedProjectRef;
  /** `#` sections and team projects: the container key (`section:<id>`, `team-project:<id>`). */
  readonly containerKey?: string;
}

export interface CaptureLink {
  readonly id: string;
  readonly url: string;
  /** "youtube.com · video" */
  readonly label: string;
  readonly isVideo: boolean;
}

export interface CaptureFile {
  readonly id: string;
  readonly file: File;
}

export const TOKEN_KIND_LABELS: Record<CaptureTokenKind, string> = {
  project: "Project",
  section: "Section",
  chat: "Chat",
  person: "Person",
  agent: "Agent",
  share: "Share with",
  private: "Visibility",
};

export function tokenTrigger(kind: CaptureTokenKind): CaptureTrigger {
  if (kind === "person" || kind === "agent") return "@";
  if (kind === "share" || kind === "private") return "+";
  return "#";
}

/** Tokens a picked token replaces: `+private` and `+someone` exclude each other. */
export function withToken(
  tokens: ReadonlyArray<CaptureToken>,
  token: CaptureToken,
): ReadonlyArray<CaptureToken> {
  if (tokens.some((existing) => existing.id === token.id)) return tokens;
  const kept = tokens.filter((existing) =>
    token.kind === "private"
      ? existing.kind !== "share"
      : token.kind === "share"
        ? existing.kind !== "private"
        : true,
  );
  return [...kept, token];
}

export interface ActiveTrigger {
  readonly trigger: CaptureTrigger;
  readonly query: string;
  /** Index of the `#`/`@` character. */
  readonly start: number;
  readonly end: number;
}

const TRIGGER_PATTERN = /(^|\s)([#@+])([^\s#@+]*)$/;

/** The `#query` or `@query` the caret is sitting in, if any. */
export function findActiveTrigger(text: string, caret: number): ActiveTrigger | null {
  const match = TRIGGER_PATTERN.exec(text.slice(0, caret));
  if (!match) return null;
  const query = match[3] ?? "";
  return {
    trigger: match[2] === "@" ? "@" : match[2] === "+" ? "+" : "#",
    query,
    start: caret - query.length - 1,
    end: caret,
  };
}

/** Drops the typed `#query` once it became a chip. Returns the caret position too. */
export function removeTriggerText(
  text: string,
  trigger: ActiveTrigger,
): { text: string; caret: number } {
  const before = text.slice(0, trigger.start);
  const rest = text.slice(trigger.end);
  const after = before === "" || before.endsWith(" ") ? rest.replace(/^ /, "") : rest;
  return { text: before + after, caret: before.length };
}

const VIDEO_HOSTS = ["youtube.com", "youtu.be", "vimeo.com", "loom.com"];

/** A pasted string that is exactly one URL, normalized; otherwise null. */
export function parsePastedUrl(pasted: string): string | null {
  const trimmed = pasted.trim();
  if (/\s/.test(trimmed)) return null;
  const candidate = /^www\.\S+\.\S+$/i.test(trimmed) ? `https://${trimmed}` : trimmed;
  if (!/^https?:\/\/\S+$/i.test(candidate)) return null;
  try {
    return new URL(candidate).href;
  } catch {
    return null;
  }
}

export function describeLink(url: string): Omit<CaptureLink, "id"> {
  const host = new URL(url).hostname.replace(/^(www|m)\./, "");
  const isVideo = VIDEO_HOSTS.some((video) => host === video || host.endsWith(`.${video}`));
  const domain = host === "youtu.be" ? "youtube.com" : host;
  return { url, label: `${domain} · ${isVideo ? "video" : "link"}`, isVideo };
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The `@assistant` chip: Enter hands the capture to the assistant instead of starting a chat. */
export const ASSISTANT_TOKEN_ID = "agent:assistant";

export function assistantToken(assistantName: string): CaptureToken {
  return { id: ASSISTANT_TOKEN_ID, kind: "agent", label: assistantName };
}

export function isAssistantToken(token: CaptureToken): boolean {
  return token.id === ASSISTANT_TOKEN_ID;
}

/**
 * "→ Appa · merchant-portal · @Flynn" with the assistant chip (tags are
 * hints its workflow follows), "→ new chat · merchant-portal" without it.
 */
export function routingHint(tokens: ReadonlyArray<CaptureToken>, assistantName: string): string {
  const head = tokens.some(isAssistantToken) ? `→ ${assistantName}` : "→ new chat";
  const tags = tokens.flatMap((token) => {
    if (token.kind === "share" || token.kind === "private" || isAssistantToken(token)) return [];
    return [token.kind === "person" || token.kind === "agent" ? `@${token.label}` : token.label];
  });
  return [head, ...tags].join(" · ");
}

/** Prefix matches first, then substring matches; empty query keeps source order. */
export function rankTokens(
  candidates: ReadonlyArray<CaptureToken>,
  query: string,
  limit: number,
): CaptureToken[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return candidates.slice(0, limit);
  const prefix: CaptureToken[] = [];
  const contains: CaptureToken[] = [];
  for (const candidate of candidates) {
    const label = candidate.label.toLowerCase();
    if (label.startsWith(needle)) prefix.push(candidate);
    else if (label.includes(needle)) contains.push(candidate);
  }
  return [...prefix, ...contains].slice(0, limit);
}
