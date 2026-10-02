/**
 * PLACEHOLDER DATA for multiplayer threads. Nothing here comes from a server.
 * Threads start with their project's default visibility (Northwind team projects:
 * shared); the private ones were made private by their owner. Conversations
 * live in `teamMessageFixtures.ts`.
 */
import type { Team, TeamPerson, TeamProject, TeamThread } from "./multiplayerModel";

export const CURRENT_PERSON_ID = "yannic";

export const TEAM_PEOPLE: readonly TeamPerson[] = [
  {
    id: "yannic",
    name: "Yannic",
    gradient: "sky",
    email: "yannic@northwind.example",
    role: "Owner",
    title: "Terminal platform",
    assistantName: "Appa",
  },
  {
    id: "flo",
    name: "Flynn Moretti",
    gradient: "mint",
    email: "f.moretti@northwind.example",
    role: "Admin",
    title: "Payments engineering",
    assistantName: "Pip",
  },
  {
    id: "sam",
    name: "Samir Haddad",
    gradient: "amber",
    email: "s.haddad@northwind.example",
    role: "Member",
    title: "Merchant experience",
    assistantName: "Otto",
  },
  {
    id: "lea",
    name: "Leona Voss",
    gradient: "rose",
    email: "l.voss@northwind.example",
    role: "Guest",
    title: "Partnerships",
    assistantName: "Moss",
  },
];

export const TEAMS: readonly Team[] = [
  { id: "northwind", name: "Northwind team", memberIds: ["yannic", "flo", "sam", "lea"] },
];

export const TEAM_PROJECTS: readonly TeamProject[] = [
  {
    id: "merchant-portal",
    name: "merchant-portal",
    teamId: "northwind",
    sectionId: "work-northwind",
    activeIds: ["flo", "sam"],
    setup: {
      skills: 6,
      connections: ["Executor · Northwind Google", "Jira", "Sentry"],
      instructions: "AGENTS.md (team)",
      personalAccounts: ["Google (personal)"],
    },
  },
  {
    id: "terminal-app",
    name: "terminal-app",
    teamId: "northwind",
    sectionId: "work-northwind",
    activeIds: ["flo"],
    setup: {
      skills: 4,
      connections: ["Executor · Northwind Google", "GitLab", "Neptune docs"],
      instructions: "AGENTS.md (team)",
      personalAccounts: ["Google (personal)", "PAX developer portal"],
    },
  },
];

const HOUR_MS = 60 * 60 * 1000;
const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR_MS).toISOString();

export const TEAM_THREADS: readonly TeamThread[] = [
  {
    id: "mp-refund-webhooks",
    projectId: "merchant-portal",
    title: "Fix refund webhook retries",
    kind: "task",
    visibility: "shared",
    participantIds: ["yannic", "flo", "sam"],
    lastActiveAt: hoursAgo(0.2),
    typingId: "flo",
    presentIds: ["flo", "sam"],
  },
  {
    id: "mp-payout-copy",
    projectId: "merchant-portal",
    title: "Review payout dashboard copy",
    kind: "task",
    visibility: "shared",
    participantIds: ["sam", "yannic"],
    lastActiveAt: hoursAgo(1),
    waitingForIds: ["sam"],
    presentIds: ["sam"],
    switchedToTaskAt: hoursAgo(2),
  },
  {
    id: "mp-settlement-pagination",
    projectId: "merchant-portal",
    title: "How should settlements paginate?",
    kind: "chat",
    visibility: "private",
    participantIds: ["yannic"],
    lastActiveAt: hoursAgo(50),
  },
  {
    id: "ta-printer-fix",
    projectId: "terminal-app",
    title: "Ship A920 receipt printer fix",
    kind: "task",
    visibility: "shared",
    participantIds: ["flo", "yannic"],
    lastActiveAt: hoursAgo(6),
  },
  {
    id: "ta-neptune-questions",
    projectId: "terminal-app",
    title: "Which Neptune calls need a signed build?",
    kind: "chat",
    visibility: "shared",
    participantIds: ["yannic"],
    lastActiveAt: hoursAgo(75),
    waitingForIds: ["flo"],
  },
  {
    id: "ta-offline-mode",
    projectId: "terminal-app",
    title: "Offline mode ideas",
    kind: "chat",
    visibility: "shared",
    participantIds: ["sam", "yannic", "lea"],
    lastActiveAt: hoursAgo(100),
    presentIds: ["lea"],
  },
];

export { TEAM_MESSAGES } from "./teamMessageFixtures";
