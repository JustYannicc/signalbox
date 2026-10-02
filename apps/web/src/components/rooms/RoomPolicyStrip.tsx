/**
 * "What each side may share": each assistant's allowances and hard limits,
 * as set by its owner. Shown from the room header's shield.
 */
import { CheckIcon, XIcon } from "lucide-react";

import { firstName, type TeamPerson } from "../multiplayer/multiplayerModel";
import type { PersonAssistant } from "../multiplayer/personAssistant";
import { findPerson } from "../multiplayer/teamThreads";
import type { SharePolicy } from "./roomModel";

function PolicyColumn(props: { policy: SharePolicy; assistant: PersonAssistant; owner: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <span className="text-xs font-medium text-foreground">
        {props.assistant.name}{" "}
        <span className="font-normal text-muted-foreground">
          · {props.assistant.isYours ? "your policy" : `${props.owner}'s policy`}
        </span>
      </span>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {props.policy.mayShare.map((item) => (
          <li key={item} className="flex items-center gap-1">
            <CheckIcon aria-label="May share" className="size-3 text-success-foreground" />
            {item}
          </li>
        ))}
        {props.policy.neverShares.map((item) => (
          <li key={item} className="flex items-center gap-1">
            <XIcon aria-label="Never shares" className="size-3" />
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RoomPolicyStrip(props: {
  policies: readonly SharePolicy[];
  resolveAssistant: (person: TeamPerson) => PersonAssistant;
}) {
  return (
    <section aria-label="What each side may share" className="flex flex-col gap-3">
      <div className="flex flex-col gap-3">
        {props.policies.map((policy) => {
          const person = findPerson(policy.ownerId);
          if (!person) return null;
          return (
            <PolicyColumn
              key={policy.ownerId}
              policy={policy}
              assistant={props.resolveAssistant(person)}
              owner={firstName(person.name)}
            />
          );
        })}
      </div>
    </section>
  );
}
