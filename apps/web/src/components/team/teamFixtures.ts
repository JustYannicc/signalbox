/**
 * PLACEHOLDER DATA for the Team page. Members come from the multiplayer
 * fixtures; organizations, invites, sign-in, and company agents live here. Nothing comes
 * from WorkOS or a server. Delete once teams are real.
 */
import type { CompanyAgent, ConnectedOrganization, PendingInvite } from "./teamModel";

export const CONNECTED_ORGANIZATIONS: readonly ConnectedOrganization[] = [
  {
    id: "northwind",
    name: "Northwind",
    domain: "northwind.example",
    memberSince: "Aug 2026",
    signIn: "WorkOS SSO",
    teamId: "northwind",
  },
];

export const TEAM_SIGN_IN = "northwind.example · verified domain";

export const TEAM_INVITES: readonly PendingInvite[] = [
  { email: "n.feld@northwind.example", role: "Member", sent: "2 days ago" },
];

export const COMPANY_AGENTS: readonly CompanyAgent[] = [
  {
    id: "company-expense",
    name: "Expense agent",
    ownerId: "flo",
    mayAsk: "Receipts and card charges",
  },
  {
    id: "company-onboarding",
    name: "Onboarding agent",
    ownerId: "yannic",
    mayAsk: "Calendar availability and setup status",
  },
];
