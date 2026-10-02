/**
 * PLACEHOLDER rooms. Appa (Yannic's assistant) asks Pip (Flynn's) for a Halden
 * contact: Pip checks Flynn's policy, shares one contact card, and declines Flynn's
 * personal notes; Flynn steps in once. The Otto room is still open.
 */
import type { Room, SharePolicy } from "./roomModel";

const HOUR_MS = 60 * 60 * 1000;
const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR_MS).toISOString();

export const SHARE_POLICIES: Readonly<Record<string, SharePolicy>> = {
  yannic: {
    ownerId: "yannic",
    mayShare: ["Work contacts", "Calendar free/busy", "Project status"],
    neverShares: ["Personal notes", "Private chats"],
  },
  flo: {
    ownerId: "flo",
    mayShare: ["Work contacts", "Team docs"],
    neverShares: ["Personal notes", "Private chats", "Calendar details"],
  },
  sam: {
    ownerId: "sam",
    mayShare: ["Calendar free/busy", "Project status"],
    neverShares: ["Personal notes", "Contacts"],
  },
  lea: {
    ownerId: "lea",
    mayShare: ["Partner contacts", "Calendar free/busy"],
    neverShares: ["Personal notes", "Contract drafts"],
  },
};

const policiesFor = (ids: readonly string[]) => ids.flatMap((id) => SHARE_POLICIES[id] ?? []);

export const ROOMS: readonly Room[] = [
  {
    id: "room-halden-contact",
    title: "Halden contact for the terminal pilot",
    ownerIds: ["yannic", "flo"],
    status: "done",
    containerKey: "section:work-northwind",
    sectionId: "work-northwind",
    lastActiveAt: hoursAgo(3),
    policies: policiesFor(["yannic", "flo"]),
    messages: [
      {
        id: "r1",
        speaker: "assistant",
        personId: "yannic",
        at: "10:02",
        body: {
          kind: "text",
          text: "Hi Pip. Yannic needs a contact at Halden, the grocery chain, for the terminal pilot. Flynn met their procurement team last month. Who was that?",
        },
      },
      {
        id: "r2",
        speaker: "assistant",
        personId: "flo",
        at: "10:02",
        body: {
          kind: "policy-check",
          text: "Checked Flynn's sharing policy: work contacts are OK to share.",
        },
      },
      {
        id: "r3",
        speaker: "assistant",
        personId: "flo",
        at: "10:03",
        body: {
          kind: "contact",
          text: "Here's the person Flynn met:",
          contact: {
            name: "Mara Lindt",
            role: "Procurement lead, Halden Markets",
            email: "mara.lindt@halden.example",
            context: "Met Flynn at Halden's supplier day in May",
          },
        },
      },
      {
        id: "r4",
        speaker: "assistant",
        personId: "yannic",
        at: "10:03",
        body: {
          kind: "text",
          text: "Thanks. Does Flynn have notes from that meeting? Pricing context would help Yannic.",
        },
      },
      {
        id: "r5",
        speaker: "assistant",
        personId: "flo",
        at: "10:04",
        body: {
          kind: "declined",
          text: "I can't share that. I've asked Flynn whether a short summary is OK.",
          withheld: "Flynn's personal notes",
        },
      },
      {
        id: "r6",
        speaker: "person",
        personId: "flo",
        at: "10:21",
        body: {
          kind: "text",
          text: "They're open to pilot discounts, that's all I'll say. Mara prefers email.",
        },
      },
      {
        id: "r7",
        speaker: "assistant",
        personId: "yannic",
        at: "10:22",
        body: {
          kind: "text",
          text: "Thanks. Drafted an intro email to Mara in Yannic's Gmail drafts, mentioning the pilot discount. Not sent; Yannic reviews it first.",
        },
      },
    ],
    outcome: {
      shared: ["1 contact: Mara Lindt, Halden"],
      declined: ["Flynn's personal notes"],
      next: "Yannic reviews the intro email to Mara in Gmail drafts.",
    },
  },
  {
    id: "room-rollout-review",
    title: "Time for the terminal rollout review",
    ownerIds: ["yannic", "sam"],
    status: "open",
    waitingOnId: "sam",
    containerKey: "team-project:terminal-app",
    sectionId: "work-northwind",
    lastActiveAt: hoursAgo(0.5),
    policies: policiesFor(["yannic", "sam"]),
    messages: [
      {
        id: "r1",
        speaker: "assistant",
        personId: "yannic",
        at: "14:10",
        body: {
          kind: "text",
          text: "Hi Otto. Yannic wants 45 minutes with Samir this week to review the terminal rollout. Yannic is free Thu 10:00–12:00 and Fri afternoon.",
        },
      },
      {
        id: "r2",
        speaker: "assistant",
        personId: "sam",
        at: "14:11",
        body: {
          kind: "policy-check",
          text: "Checked Samir's sharing policy: free/busy is OK, calendar details are not.",
        },
      },
      {
        id: "r3",
        speaker: "assistant",
        personId: "sam",
        at: "14:11",
        body: {
          kind: "text",
          text: "Samir is free Thu 11:00–11:45. That slot is on hold as tentative until Samir confirms.",
        },
      },
    ],
  },
  {
    id: "room-dinner-plans",
    title: "Team dinner after the pilot",
    ownerIds: ["yannic", "lea"],
    status: "open",
    waitingOnId: "yannic",
    quickReplies: ["Tuesday works", "Thursday works", "Neither, ask for next week"],
    containerKey: "section:personal",
    sectionId: "personal",
    lastActiveAt: hoursAgo(20),
    policies: policiesFor(["yannic", "lea"]),
    messages: [
      {
        id: "r1",
        speaker: "assistant",
        personId: "yannic",
        at: "Yesterday",
        body: {
          kind: "text",
          text: "Hi Moss. Yannic is planning a team dinner after the Halden pilot. Which evenings does Leona have free next week?",
        },
      },
      {
        id: "r2",
        speaker: "assistant",
        personId: "lea",
        at: "Yesterday",
        body: {
          kind: "policy-check",
          text: "Checked Leona's sharing policy: free/busy is OK to share.",
        },
      },
      {
        id: "r3",
        speaker: "assistant",
        personId: "lea",
        at: "Yesterday",
        body: { kind: "text", text: "Leona is free Tuesday and Thursday evening." },
      },
    ],
  },
];

export { policiesFor };
