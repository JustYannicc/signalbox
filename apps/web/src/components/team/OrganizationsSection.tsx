import { Building2Icon, PlusIcon } from "lucide-react";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { notifyTeamComingSoon, type ConnectedOrganization } from "./teamModel";
import { SectionHeading } from "./teamPrimitives";

const KEEPS = "Your account, assistant, personal sections and pools stay yours when you leave.";

/**
 * Organizations your own account is connected to. Identity follows the
 * person: switching jobs means leaving one organization and connecting the
 * next, never a new account.
 */
export function OrganizationsSection({
  organizations,
  connectedIds,
  onConnectedChange,
}: {
  readonly organizations: readonly ConnectedOrganization[];
  readonly connectedIds: ReadonlySet<string>;
  readonly onConnectedChange: (orgId: string, connected: boolean) => void;
}) {
  const [leaving, setLeaving] = useState<ConnectedOrganization | null>(null);
  return (
    <section aria-labelledby="team-orgs" className="flex flex-col gap-3">
      <SectionHeading id="team-orgs" title="Organizations" note={KEEPS} />
      <ul className="divide-y divide-border rounded-lg border border-border">
        {organizations.map((org) => {
          const connected = connectedIds.has(org.id);
          return (
            <li key={org.id} className="flex items-center gap-3 px-3 py-2.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <Building2Icon className="size-4" aria-hidden />
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium text-foreground">{org.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {connected
                    ? `${org.domain} · member since ${org.memberSince} · ${org.signIn}`
                    : `You left ${org.name}`}
                </span>
              </div>
              {connected ? (
                <Button size="xs" variant="ghost-muted" onClick={() => setLeaving(org)}>
                  Leave
                </Button>
              ) : (
                <Button size="xs" variant="outline" onClick={() => onConnectedChange(org.id, true)}>
                  Rejoin
                </Button>
              )}
            </li>
          );
        })}
        <li className="px-3 py-2">
          <Button
            size="xs"
            variant="ghost-muted"
            onClick={() => notifyTeamComingSoon("Connecting an organization")}
          >
            <PlusIcon aria-hidden />
            Connect an organization
          </Button>
        </li>
      </ul>

      <AlertDialog open={leaving !== null} onOpenChange={(open) => !open && setLeaving(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave {leaving?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              You lose access to {leaving?.name}'s sections, shared pools and connections. {KEEPS}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (leaving) onConnectedChange(leaving.id, false);
                setLeaving(null);
              }}
            >
              Leave
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}
