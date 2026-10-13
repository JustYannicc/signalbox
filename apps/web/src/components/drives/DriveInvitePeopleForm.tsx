import type { SignalboxDriveRole } from "@t3tools/contracts/signalboxDrives";
import { UserPlusIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { DriveRoleSelect } from "./DriveRoleSelect";

export function DriveInvitePeopleForm(props: {
  roles: ReadonlyArray<SignalboxDriveRole>;
  disabled: boolean;
  submitting: boolean;
  onInvite: (email: string, role: SignalboxDriveRole) => Promise<boolean>;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<SignalboxDriveRole>("viewer");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail || props.disabled) return;
    if (await props.onInvite(trimmedEmail, role)) setEmail("");
  };

  return (
    <form className="mt-4 space-y-2" onSubmit={(event) => void submit(event)}>
      <h3 className="text-sm font-medium">Add people</h3>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          type="email"
          autoComplete="off"
          aria-label="Email address"
          placeholder="name@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={props.disabled}
          required
        />
        <DriveRoleSelect
          value={role}
          roles={props.roles}
          label="Access role"
          disabled={props.disabled}
          className="w-full sm:w-40"
          onChange={setRole}
        />
        <Button type="submit" size="sm" disabled={props.disabled || email.trim().length === 0}>
          <UserPlusIcon />
          {props.submitting ? "Sharing…" : "Share"}
        </Button>
      </div>
    </form>
  );
}
