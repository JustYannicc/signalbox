import type { SignalboxDriveRole } from "@t3tools/contracts/signalboxDrives";
import { roleLabel } from "@t3tools/client-runtime/state/signalboxDrives";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

/** A role among `roles`, by its readable name. */
export function DriveRoleSelect(props: {
  value: SignalboxDriveRole;
  roles: ReadonlyArray<SignalboxDriveRole>;
  label: string;
  disabled: boolean;
  className?: string;
  onChange: (role: SignalboxDriveRole) => void;
}) {
  return (
    <Select
      value={props.value}
      onValueChange={(value) => {
        const role = props.roles.find((candidate) => candidate === value);
        if (role !== undefined) props.onChange(role);
      }}
      disabled={props.disabled}
    >
      <SelectTrigger size="sm" aria-label={props.label} className={props.className}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {props.roles.map((role) => (
          <SelectItem key={role} value={role}>
            {roleLabel(role)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
