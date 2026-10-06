import { collectLimitProblems } from "@t3tools/shared/limitProblems";
import { Atom } from "effect/reactivity";

import { environmentPresentations } from "./presentation";

/** Accounts across every connected environment that need the user to fix them. */
export const limitProblemsAtom = Atom.make((get) =>
  collectLimitProblems(get(environmentPresentations.presentationsAtom)),
).pipe(Atom.withLabel("web-limit-problems"));

/** A boolean, so the always-mounted Usage icon re-renders only when it flips. */
export const hasLimitProblemsAtom = Atom.make((get) => get(limitProblemsAtom).length > 0).pipe(
  Atom.withLabel("web-has-limit-problems"),
);
