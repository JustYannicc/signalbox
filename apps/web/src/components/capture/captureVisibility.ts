/**
 * Who a capture is for. Private by default; `+person` / `+team` shares it,
 * `+private` forces private. Without either, a tagged container whose default
 * is shared (a team section or team project) shares it with that team.
 */
import { containerInfo } from "../multiplayer/sharing";
import { TEAMS } from "../multiplayer/multiplayerFixtures";
import type { CaptureToken } from "./captureTokens";

export type CaptureVisibility =
  | { readonly scope: "private" }
  | { readonly scope: "shared"; readonly with: string; readonly from?: string };

export function captureVisibility(tokens: ReadonlyArray<CaptureToken>): CaptureVisibility {
  if (tokens.some((token) => token.kind === "private")) return { scope: "private" };
  const shares = tokens.filter((token) => token.kind === "share");
  if (shares.length > 0) {
    return { scope: "shared", with: shares.map((token) => token.label).join(", ") };
  }
  for (const token of tokens) {
    if (!token.containerKey) continue;
    const container = containerInfo(token.containerKey);
    if (container.defaultScope !== "shared") continue;
    const team = TEAMS.find((candidate) => candidate.id === container.teamId);
    return { scope: "shared", with: team?.name ?? "the team", from: container.name };
  }
  return { scope: "private" };
}

/** "shared with Flynn", "shared with Northwind team (from merchant-portal)", "private". */
export function visibilityLabel(visibility: CaptureVisibility): string {
  if (visibility.scope === "private") return "private";
  return visibility.from
    ? `shared with ${visibility.with} (from ${visibility.from})`
    : `shared with ${visibility.with}`;
}
