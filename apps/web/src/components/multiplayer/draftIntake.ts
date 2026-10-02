/**
 * `?share=` for a new draft: comma-separated person ids or first names
 * (`flynn`), team ids (`northwind`), or `private`. Applied once as the draft's
 * starting access, then dropped from the URL.
 */
import { TEAMS, TEAM_PEOPLE } from "./multiplayerFixtures";
import { firstName } from "./multiplayerModel";
import { useItemGrantsStore } from "./itemAccess";
import { useThreadVisibilityStore } from "./teamThreads";

export function applyDraftShare(threadId: string, share: string): void {
  const tokens = share
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
  const visibility = useThreadVisibilityStore.getState();
  const personIds: string[] = [];
  for (const token of tokens) {
    if (token === "private") {
      visibility.setVisibility(threadId, "private");
      continue;
    }
    if (TEAMS.some((team) => team.id === token || team.name.toLowerCase() === token)) {
      visibility.setVisibility(threadId, "shared");
      continue;
    }
    const person = TEAM_PEOPLE.find(
      (candidate) => candidate.id === token || firstName(candidate.name).toLowerCase() === token,
    );
    if (person) personIds.push(person.id);
  }
  if (personIds.length > 0) useItemGrantsStore.getState().grant(threadId, personIds);
}
