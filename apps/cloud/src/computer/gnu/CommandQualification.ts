export type GnuCommandMachineReason =
  | "incompatible-option"
  | "unqualified-option"
  | "unqualified-script";

export interface GnuCommandMachineDecision {
  readonly kind: "machine";
  readonly reason: GnuCommandMachineReason;
  readonly detail: string;
}

export type GnuCommandQualification =
  | { readonly kind: "qualified-isolate" }
  | GnuCommandMachineDecision;

export const QUALIFIED = Object.freeze({ kind: "qualified-isolate" as const });

export function machine(
  reason: GnuCommandMachineReason,
  detail: string,
): GnuCommandMachineDecision {
  return { kind: "machine", reason, detail };
}
