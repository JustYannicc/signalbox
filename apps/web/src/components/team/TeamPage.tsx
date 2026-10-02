/**
 * Organization › Team: the organizations your own account is connected to,
 * then the connected organization's team (Home › Work › Northwind team), how
 * people sign up, and the company agents that act for it. What's shared lives
 * on the section's share editor; routing lives in Plugins groups.
 * UI prototype on placeholder data (see teamFixtures.ts and multiplayer).
 */
import { useState } from "react";

import { isElectron } from "../../env";
import { TEAM_PEOPLE, TEAMS } from "../multiplayer/multiplayerFixtures";
import { currentPerson } from "../multiplayer/teamThreads";
import { findHomeSection } from "../sidebar/sections/sectionModel";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { AgentRepresentation } from "./AgentRepresentation";
import { MembersSection } from "./MembersSection";
import { SignUpFlowCard } from "./SignUpFlowCard";
import { OrganizationsSection } from "./OrganizationsSection";
import {
  COMPANY_AGENTS,
  CONNECTED_ORGANIZATIONS,
  TEAM_INVITES,
  TEAM_SIGN_IN,
} from "./teamFixtures";
import { isMemberRole, MEMBER_ROLES, type MemberRole } from "./teamModel";

const ORG = CONNECTED_ORGANIZATIONS[0];
const TEAM = TEAMS.find((team) => team.id === ORG?.teamId);
const TEAM_SECTION = findHomeSection("work-northwind");
const MEMBERS = TEAM_PEOPLE.filter((person) => TEAM?.memberIds.includes(person.id));

export function TeamPage() {
  // Dev-only: demo the page from a teammate's seat without a second account.
  const [previewRole, setPreviewRole] = useState<MemberRole>(currentPerson.role);
  const [connectedOrgs, setConnectedOrgs] = useState<ReadonlySet<string>>(
    () => new Set(CONNECTED_ORGANIZATIONS.map((org) => org.id)),
  );
  const teamName = TEAM?.name ?? TEAM_SECTION?.name ?? "Team";
  const inTeam = ORG !== undefined && connectedOrgs.has(ORG.id);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          <div className="flex w-full min-w-0 items-center gap-3 py-2">
            <WorkspaceBreadcrumb ariaLabel="Team breadcrumb" className="min-w-0 flex-1">
              <WorkspaceBreadcrumbItem current={!inTeam}>
                <span>Organization</span>
              </WorkspaceBreadcrumbItem>
              {inTeam ? (
                <>
                  <WorkspaceBreadcrumbSeparator />
                  <WorkspaceBreadcrumbItem current>
                    <h1 className="truncate">{teamName}</h1>
                  </WorkspaceBreadcrumbItem>
                </>
              ) : null}
            </WorkspaceBreadcrumb>
            {import.meta.env.DEV && inTeam ? (
              <Select
                value={previewRole}
                onValueChange={(next) => {
                  if (isMemberRole(next)) setPreviewRole(next);
                }}
              >
                <SelectTrigger
                  aria-label="Preview as role (dev only)"
                  size="compact"
                  variant="ghost"
                  className="w-auto min-w-0"
                >
                  <SelectValue>Dev · as {previewRole}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {MEMBER_ROLES.map((role) => (
                    <SelectItem key={role} value={role}>
                      {role}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
          </div>
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="expanded" className="gap-10">
            <OrganizationsSection
              organizations={CONNECTED_ORGANIZATIONS}
              connectedIds={connectedOrgs}
              onConnectedChange={(orgId, connected) =>
                setConnectedOrgs((current) => {
                  const next = new Set(current);
                  if (connected) next.add(orgId);
                  else next.delete(orgId);
                  return next;
                })
              }
            />
            {inTeam ? (
              <>
                <div className="grid gap-10 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:gap-8">
                  <MembersSection
                    members={MEMBERS}
                    initialInvites={TEAM_INVITES}
                    signIn={TEAM_SIGN_IN}
                    viewerId={currentPerson.id}
                    viewerRole={import.meta.env.DEV ? previewRole : currentPerson.role}
                  />
                  <SignUpFlowCard />
                </div>
                <AgentRepresentation members={MEMBERS} companyAgents={COMPANY_AGENTS} />
              </>
            ) : null}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
