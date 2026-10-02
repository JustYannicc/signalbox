/**
 * PLACEHOLDER DATA for the Marketplace: skills listed on skills.sh and
 * shareable workflow templates. Install counts and authors are invented.
 */
export type MarketplaceTab = "discover" | "team" | "yours";

interface ListingBase {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly author: string;
  readonly tabs: readonly MarketplaceTab[];
}

export interface SkillListing extends ListingBase {
  readonly kind: "skill";
  /** skills.sh slug, installed with `npx skills add`. */
  readonly registry: string;
  readonly installs: number;
  /** Set when it is already installed, so the row links to the skill instead. */
  readonly installedSkillId?: string;
}

export interface WorkflowListing extends ListingBase {
  readonly kind: "workflow";
  /** The hand-offs the template sets up, in order. */
  readonly steps: readonly string[];
  readonly uses: number;
}

export type MarketplaceListing = SkillListing | WorkflowListing;

export const MARKETPLACE: readonly MarketplaceListing[] = [
  {
    kind: "workflow",
    id: "sentry-fix-pr",
    name: "Sentry feedback → fix PR",
    description: "New Sentry issue with user feedback becomes a triaged task and a draft fix PR.",
    author: "t3tools",
    steps: ["Sentry issue", "Triage agent", "Thread agent", "Draft PR"],
    uses: 1840,
    tabs: ["discover"],
  },
  {
    kind: "workflow",
    id: "monthly-expenses",
    name: "Monthly expenses",
    description:
      "Collect receipts, match card transactions, and file them with the company Expense agent.",
    author: "Flynn · Northwind",
    steps: ["Gmail · Work account", "northwind-expenses skill", "Expense agent", "Your approval"],
    uses: 23,
    tabs: ["team"],
  },
  {
    kind: "workflow",
    id: "customer-email-approval",
    name: "Customer email → approval",
    description: "Sort incoming customer email, draft replies, and queue them for a human to send.",
    author: "You",
    steps: ["Gmail · Work account", "customer-email-triage", "Draft reply", "Approval queue"],
    uses: 11,
    tabs: ["team", "yours"],
  },
  {
    kind: "workflow",
    id: "release-notes",
    name: "Merged PRs → release notes",
    description: "Every Friday, summarize merged PRs into release notes and post them for review.",
    author: "vercel-labs",
    steps: ["GitHub", "Summary agent", "Slack draft"],
    uses: 960,
    tabs: ["discover"],
  },
  {
    kind: "skill",
    id: "find-skills",
    name: "find-skills",
    description: "Find and install the right skill for the task in front of you.",
    author: "vercel-labs",
    registry: "vercel-labs/skills",
    installs: 48200,
    installedSkillId: "find-skills",
    tabs: ["discover"],
  },
  {
    kind: "skill",
    id: "frontend-design",
    name: "frontend-design",
    description: "Distinctive, production-grade UI instead of generic layouts.",
    author: "anthropics",
    registry: "anthropics/skills",
    installs: 31700,
    tabs: ["discover"],
  },
  {
    kind: "skill",
    id: "terraform-plan-review",
    name: "terraform-plan-review",
    description: "Read a plan, flag destructive changes, and explain the blast radius.",
    author: "hashicorp",
    registry: "hashicorp/agent-skills",
    installs: 6400,
    tabs: ["discover"],
  },
  {
    kind: "skill",
    id: "northwind-expenses",
    name: "northwind-expenses",
    description: "File monthly expenses with the company Expense agent.",
    author: "Flynn",
    registry: "northwind/skills",
    installs: 5,
    installedSkillId: "northwind-expenses",
    tabs: ["team"],
  },
  {
    kind: "skill",
    id: "northwind-terminal",
    name: "northwind-terminal",
    description: "Neptune APIs and PAX terminal rules for Northwind payment work.",
    author: "Northwind admins",
    registry: "northwind/agent-skills",
    installs: 3,
    installedSkillId: "northwind-terminal",
    tabs: ["team"],
  },
  {
    kind: "skill",
    id: "customer-email-triage",
    name: "customer-email-triage",
    description: "Sort customer email and draft replies for approval.",
    author: "You",
    registry: "northwind/skills",
    installs: 5,
    installedSkillId: "customer-email-triage",
    tabs: ["team", "yours"],
  },
];
