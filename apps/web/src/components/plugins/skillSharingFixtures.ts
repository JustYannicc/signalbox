/**
 * PLACEHOLDER DATA for team-shared skills. Nothing is read from a repo or
 * skills.sh; delete with the other plugin fixtures.
 */
import type { SkillPublication } from "./skillSharingModel";

export const SKILL_PUBLICATIONS: readonly SkillPublication[] = [
  {
    skillId: "northwind-expenses",
    owner: "Flynn",
    groupId: "northwind",
    autoUpdate: true,
    yourVersion: 3,
    versions: [
      { version: 3, author: "Flynn", note: "Handle missing VAT number", when: "2h ago" },
      { version: 2, author: "Flynn", note: "Split receipts by cost center", when: "3 days ago" },
      { version: 1, author: "Flynn", note: "First version", when: "2 weeks ago" },
    ],
    subscribers: [
      { name: "You", version: 3, autoUpdate: true },
      { name: "Anna", version: 3, autoUpdate: true },
      { name: "Marco", version: 3, autoUpdate: true },
      { name: "Sven", version: 3, autoUpdate: true },
      { name: "Leona", version: 2, autoUpdate: false },
    ],
    repo: "northwind/skills",
    repoPath: "expenses/SKILL.md",
    registry: "skills.sh/northwind/skills/expenses",
    body: "---\nname: northwind-expenses\ndescription: File monthly expenses with the company Expense agent.\n---\n\n1. Collect receipts from Gmail · Work account.\n2. Match each to a card transaction.\n3. If a receipt has no VAT number, ask the supplier before filing.",
  },
  {
    skillId: "customer-email-triage",
    owner: "you",
    groupId: "northwind",
    autoUpdate: true,
    yourVersion: 3,
    versions: [
      { version: 3, author: "You", note: "Route refund requests to finance", when: "yesterday" },
      { version: 2, author: "You", note: "Draft replies instead of sending", when: "5 days ago" },
      { version: 1, author: "You", note: "First version", when: "3 weeks ago" },
    ],
    subscribers: [
      { name: "Flynn", version: 3, autoUpdate: true },
      { name: "Anna", version: 3, autoUpdate: true },
      { name: "Marco", version: 3, autoUpdate: true },
      { name: "Nora", version: 3, autoUpdate: true },
      { name: "Leona", version: 2, autoUpdate: false },
    ],
    repo: "northwind/skills",
    repoPath: "customer-email-triage/SKILL.md",
    registry: "skills.sh/northwind/skills/customer-email-triage",
    body: "---\nname: customer-email-triage\ndescription: Sort customer email and draft replies for approval.\n---\n\n1. Label each email: support, refund, sales, or spam.\n2. Draft a reply. Never send it; queue it for approval.\n3. Refund requests go to finance@northwind.example with the order id.",
  },
  {
    skillId: "northwind-terminal",
    owner: "Northwind admins",
    groupId: "northwind",
    autoUpdate: false,
    yourVersion: 4,
    versions: [
      { version: 5, author: "Jonas", note: "Cover A920 Pro printer APIs", when: "1 day ago" },
      { version: 4, author: "Jonas", note: "Neptune 3.2 card reader changes", when: "2 weeks ago" },
      { version: 3, author: "Priya", note: "Forbid generic Android APIs", when: "1 month ago" },
    ],
    subscribers: [
      { name: "You", version: 4, autoUpdate: false },
      { name: "Jonas", version: 5, autoUpdate: true },
      { name: "Priya", version: 5, autoUpdate: true },
    ],
    repo: "northwind/agent-skills",
    repoPath: "northwind-terminal/SKILL.md",
    registry: "skills.sh/northwind/agent-skills/northwind-terminal",
    body: "---\nname: northwind-terminal\ndescription: Neptune APIs and PAX terminal rules.\n---\n\nRead docs/README.md first. Use only documented Neptune APIs.",
  },
];

export function publicationFor(skillId: string) {
  return SKILL_PUBLICATIONS.find((publication) => publication.skillId === skillId);
}
