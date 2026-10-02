import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useMemo } from "react";

import { useProjects, useThreadShells } from "../../state/entities";
import { useAssistantIdentity } from "../assistant/assistantIdentity";
import {
  CURRENT_PERSON_ID,
  TEAM_PEOPLE,
  TEAMS,
  TEAM_PROJECTS,
  TEAM_THREADS,
} from "../multiplayer/multiplayerFixtures";
import { focusModeInfo, useFocusStore } from "../sidebar/focus/focusStore";
import { HOME_SECTIONS, rootSectionIdOf } from "../sidebar/sections/sectionModel";
import { useProjectInFocus } from "../sidebar/useProjectInFocus";
import {
  assistantToken,
  rankTokens,
  type CaptureToken,
  type CaptureTrigger,
} from "./captureTokens";

const LIMIT = 8;
// With nothing typed yet, show a few of each kind instead of one long list.
const PER_KIND_WHEN_EMPTY = 3;

function firstName(name: string): string {
  return name.split(" ")[0] ?? name;
}

// `+`: keep it private, or share with a teammate or a whole team (fixtures).
const SHARE_CANDIDATES: ReadonlyArray<CaptureToken> = [
  { id: "private", kind: "private", label: "Private" },
  ...TEAM_PEOPLE.filter((person) => person.id !== CURRENT_PERSON_ID).map((person) => ({
    id: `share:${person.id}`,
    kind: "share" as const,
    label: firstName(person.name),
  })),
  ...TEAMS.map((team) => ({
    id: `share:team:${team.id}`,
    kind: "share" as const,
    label: team.name,
  })),
];

function sampleEachKind(candidates: ReadonlyArray<CaptureToken>): CaptureToken[] {
  const seen = new Map<string, number>();
  return candidates.filter((candidate) => {
    const count = seen.get(candidate.kind) ?? 0;
    seen.set(candidate.kind, count + 1);
    return count < PER_KIND_WHEN_EMPTY;
  });
}

/**
 * Autocomplete candidates for the New bar. `#`: real projects, sections, team
 * projects (fixture), and chats (real thread titles plus team chat fixtures). `@`:
 * teammates (fixture) and agents: the assistant, section agents, project agents.
 * `+`: Private, teammates, and teams.
 * Anything Focus keeps out of sight is left out.
 */
export function useCaptureSuggestions(
  trigger: CaptureTrigger | null,
  query: string,
): CaptureToken[] {
  const allProjects = useProjects();
  const threads = useThreadShells();
  const assistant = useAssistantIdentity();
  const isProjectInFocus = useProjectInFocus();
  const focusMode = useFocusStore((state) => state.mode);
  const projects = useMemo(
    () => allProjects.filter(isProjectInFocus),
    [allProjects, isProjectInFocus],
  );
  const sections = useMemo(() => {
    const hidden = focusModeInfo(focusMode).hiddenRootSectionIds;
    return HOME_SECTIONS.filter((section) => !hidden.includes(rootSectionIdOf(section.id)));
  }, [focusMode]);

  const hashCandidates = useMemo<CaptureToken[]>(() => {
    const realProjects = projects.map((project) => ({
      id: `project:${project.environmentId}:${project.id}`,
      kind: "project" as const,
      label: project.title,
      projectRef: scopeProjectRef(project.environmentId, project.id),
    }));
    const sectionIds = new Set(sections.map((section) => section.id));
    const visibleTeamProjects = TEAM_PROJECTS.filter((project) =>
      sectionIds.has(project.sectionId),
    );
    const teamProjects = visibleTeamProjects.map((project) => ({
      id: `team-project:${project.id}`,
      kind: "project" as const,
      label: project.name,
      containerKey: `team-project:${project.id}`,
    }));
    const sectionTokens = sections.map((section) => ({
      id: `section:${section.id}`,
      kind: "section" as const,
      label: section.name,
      containerKey: `section:${section.id}`,
    }));
    const projectKeys = new Set(
      projects.map((project) => `${project.environmentId}:${project.id}`),
    );
    const realChats = threads
      .filter(
        (thread) =>
          thread.archivedAt === null &&
          projectKeys.has(`${thread.environmentId}:${thread.projectId}`),
      )
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((thread) => ({
        id: `thread:${thread.environmentId}:${thread.id}`,
        kind: "chat" as const,
        label: thread.title,
        projectRef: scopeProjectRef(thread.environmentId, thread.projectId),
      }));
    const teamProjectIds = new Set(visibleTeamProjects.map((project) => project.id));
    const fixtureChats = TEAM_THREADS.filter((chat) => teamProjectIds.has(chat.projectId)).map(
      (chat) => ({
        id: `chat:${chat.id}`,
        kind: "chat" as const,
        label: chat.title,
      }),
    );
    return [...realProjects, ...teamProjects, ...sectionTokens, ...realChats, ...fixtureChats];
  }, [projects, sections, threads]);

  const atCandidates = useMemo<CaptureToken[]>(() => {
    const people = TEAM_PEOPLE.filter((person) => person.id !== CURRENT_PERSON_ID).map(
      (person) => ({
        id: `person:${person.id}`,
        kind: "person" as const,
        label: firstName(person.name),
      }),
    );
    const agents = [
      assistantToken(assistant.name),
      ...sections.map((section) => ({
        id: `agent:section:${section.id}`,
        kind: "agent" as const,
        label: section.agentName,
      })),
      ...projects.map((project) => ({
        id: `agent:project:${project.environmentId}:${project.id}`,
        kind: "agent" as const,
        label: `${project.title} agent`,
        projectRef: scopeProjectRef(project.environmentId, project.id),
      })),
    ];
    return [...people, ...agents];
  }, [assistant.name, projects, sections]);

  return useMemo(() => {
    if (trigger === null) return [];
    const candidates =
      trigger === "#" ? hashCandidates : trigger === "@" ? atCandidates : SHARE_CANDIDATES;
    if (query.trim().length === 0) return sampleEachKind(candidates).slice(0, LIMIT);
    return rankTokens(candidates, query, LIMIT);
  }, [atCandidates, hashCandidates, query, trigger]);
}
