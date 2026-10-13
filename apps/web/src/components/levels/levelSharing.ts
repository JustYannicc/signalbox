/**
 * Whom a level's agent is shared with. Agents of team levels (a team section
 * and everything inside it: Work › Northwind team, merchant-portal,
 * terminal-app) are shared with that team's people; agents of personal levels
 * (the top level, Work, Personal and their projects) are just yours. Sharing
 * the agent never shares private chats or tasks: those stay with their owner.
 */
import type { Team, TeamPerson } from "../multiplayer/multiplayerModel";
import { containerInfo } from "../multiplayer/sharing";
import { findTeam, peopleByIds } from "../multiplayer/teamThreads";
import { parentLevel, type LevelKey } from "./levels";

/** The team a level belongs to, or null for personal levels. */
export function levelTeam(level: LevelKey): Team | null {
  // Real projects aren't containers of their own; their section decides.
  const container = level.startsWith("project:") ? parentLevel(level) : level;
  const teamId = container ? containerInfo(container).teamId : null;
  return teamId ? (findTeam(teamId) ?? null) : null;
}

/** Everyone who shares the level's agent; empty when it's just yours. */
export function levelAgentPeople(level: LevelKey): readonly TeamPerson[] {
  const team = levelTeam(level);
  return team ? peopleByIds(team.memberIds) : [];
}
