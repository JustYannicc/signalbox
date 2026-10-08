import type { SignalboxDriveMember, SignalboxDriveRole } from "@t3tools/contracts/signalboxDrives";

import { roleLabel } from "@t3tools/client-runtime/state/signalboxDrives";
import { XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { DriveRoleSelect } from "./DriveRoleSelect";

export function DriveMemberRow(props: {
  member: SignalboxDriveMember;
  roles: ReadonlyArray<SignalboxDriveRole>;
  canChangeRole: boolean;
  canRemove: boolean;
  pending: boolean;
  onChangeRole: (member: SignalboxDriveMember, role: SignalboxDriveRole) => void;
  onRemove: (member: SignalboxDriveMember) => void;
}) {
  const displayName = props.member.name?.trim() || props.member.email || "Unknown person";
  const hasEmail = props.member.email.trim().length > 0 && displayName !== props.member.email;
  const canChange = props.canChangeRole && props.member.role !== "owner" && props.roles.length > 0;
  return (
    <li className="flex min-w-0 items-center gap-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{displayName}</div>
        {hasEmail ? (
          <div className="truncate text-xs text-muted-foreground">{props.member.email}</div>
        ) : null}
      </div>
      {canChange ? (
        <DriveRoleSelect
          value={props.member.role}
          roles={props.roles}
          label={`Role for ${displayName}`}
          disabled={props.pending}
          className="w-36"
          onChange={(role) => props.onChangeRole(props.member, role)}
        />
      ) : (
        <span className="shrink-0 text-sm text-muted-foreground">
          {roleLabel(props.member.role)}
        </span>
      )}
      {props.canRemove && props.member.role !== "owner" ? (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`Remove ${displayName}`}
          disabled={props.pending}
          onClick={() => props.onRemove(props.member)}
        >
          <XIcon />
        </Button>
      ) : null}
    </li>
  );
}
