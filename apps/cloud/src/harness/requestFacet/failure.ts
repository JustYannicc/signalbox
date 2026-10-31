import * as Exit from "effect/Exit";
import { serializeHarnessFailure } from "../Harness.ts";
import { HarnessRequestFacetError } from "./contracts.ts";

// Encode before RPC replaces native Error stacks or a rejected Promise squashes Cause reasons.
export function unwrapRequestExit<A, E>(exit: Exit.Exit<A, E>, message: string): A {
  if (Exit.isFailure(exit))
    throw new HarnessRequestFacetError(message, { cause: serializeHarnessFailure(exit.cause) });
  return exit.value;
}
