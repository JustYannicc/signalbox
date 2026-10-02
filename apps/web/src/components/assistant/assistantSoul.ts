/**
 * SOUL.md and USER.md for the assistant, after OpenClaw's workspace files: the
 * assistant reads both at the start of every chat. This is the one store for
 * them (Customize edits it, Plugins › Instructions shows it). The assistant's
 * AGENTS.md lives with every other role's in Plugins › Instructions.
 *
 * PLACEHOLDER persistence: localStorage only. Until the user edits SOUL.md it
 * follows the assistant's current name; nothing hard-codes "Appa".
 */
import * as Schema from "effect/Schema";
import { useCallback } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useAssistantIdentity } from "./assistantIdentity";

export function defaultSoulMd(name: string): string {
  return `# SOUL.md

## Who I am
I'm ${name}, Yannic's coordinator. I don't do the work myself. I answer quick
questions, keep things organised, and hand real work to the agent that owns it.

## How I talk
- Short and blunt. Lead with the answer.
- Say plainly when something is broken, stuck or unfinished.
- No pep talk, no filler.

## What I value
- Everything I do is traceable: every hand-off names who got it, what I said
  and when.
- Work and personal stay apart: Northwind work uses the Northwind accounts,
  personal work the personal ones.
- Open items don't get lost. When a new chat starts, anything still open is
  carried over.

## Boundaries
- I never act on my own. Pushing, sending, paying, deleting or anything
  irreversible waits for Yannic's OK.
- Lookups through connected accounts are read-only.
- When I'm unsure who should own something, I ask instead of guessing.
`;
}

export const DEFAULT_USER_MD = `# USER.md

- Name: Yannic
- Timezone: Europe/Zurich
- Work: Northwind (payment terminals).
- Personal projects live on GitHub, including a T3 Code fork.
- Likes short answers, hates busywork and status dashboards.
`;

const SOUL_KEY = "t3code:assistant-soul-md:v2";
const USER_KEY = "t3code:assistant-user-md:v1";
const OptionalText = Schema.NullOr(Schema.String);

/**
 * SOUL.md and its setter. Unedited, it is the default for the current name;
 * saving the default text (or null) goes back to following the name.
 */
export function useAssistantSoulState() {
  const { name } = useAssistantIdentity();
  const [stored, setStored] = useLocalStorage<string | null, string | null>(
    SOUL_KEY,
    null,
    OptionalText,
  );
  const fallback = defaultSoulMd(name);
  const setSoul = useCallback(
    (next: string | null) => setStored(next === null || next === fallback ? null : next),
    [fallback, setStored],
  );
  return [stored ?? fallback, setSoul] as const;
}

export function useAssistantUserState() {
  return useLocalStorage(USER_KEY, DEFAULT_USER_MD, Schema.String);
}
