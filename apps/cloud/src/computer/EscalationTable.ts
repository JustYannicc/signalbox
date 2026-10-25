import type { KernelCommand } from "../kernel/KernelCommandForwarder.ts";
import type { GnuCommandQualification } from "./GnuCommandCompatibility.ts";

export interface ComputerEscalationRule {
  readonly id: string;
  readonly executable: string;
  readonly argvPrefix?: readonly string[];
  readonly minimumWorkspaceBytes?: number;
}

export interface ComputerEscalationEvidence {
  readonly workspaceBytes?: number;
}

export interface ComputerEscalationPolicy {
  readonly isolateExecutables: readonly string[];
  readonly default: "machine";
}

export type ComputerEscalationDecision =
  | { readonly kind: "isolate" }
  | { readonly kind: "machine"; readonly ruleId: string }
  | { readonly kind: "machine"; readonly reason: "unsupported-executable" }
  | Extract<GnuCommandQualification, { readonly kind: "machine" }>;

export class ComputerEscalationEvidenceNotReadyError extends Error {
  readonly code = "EVIDENCE_NOT_READY";
  readonly ruleId: string;

  constructor(ruleId: string) {
    super(`Workspace byte evidence is required by escalation rule "${ruleId}"`);
    this.name = "ComputerEscalationEvidenceNotReadyError";
    this.ruleId = ruleId;
  }
}

/** Selects machine execution for individual commands from explicit, ordered rules. */
export class ComputerEscalationTable {
  readonly rules: readonly ComputerEscalationRule[];
  readonly #policy: ComputerEscalationPolicy | undefined;
  readonly #qualify: ((command: KernelCommand) => GnuCommandQualification) | undefined;

  constructor(
    rules: readonly ComputerEscalationRule[] = [],
    policy?: ComputerEscalationPolicy,
    qualify?: (command: KernelCommand) => GnuCommandQualification,
  ) {
    this.#qualify = qualify;
    if (!Array.isArray(rules)) {
      throw new TypeError("Computer escalation rules must be an array");
    }

    const ids = new Set<string>();
    this.rules = Object.freeze(
      rules.map((rule) => {
        if (typeof rule !== "object" || rule === null) {
          throw new TypeError("Computer escalation rules must be objects");
        }
        if (typeof rule.id !== "string" || rule.id.trim().length === 0) {
          throw new TypeError("Computer escalation rule IDs must not be empty");
        }
        if (ids.has(rule.id)) {
          throw new RangeError(`Duplicate computer escalation rule ID: ${rule.id}`);
        }
        ids.add(rule.id);

        if (typeof rule.executable !== "string" || rule.executable.length === 0) {
          throw new TypeError("Computer escalation executables must not be empty");
        }

        let argvPrefix: readonly string[] | undefined;
        if (rule.argvPrefix !== undefined) {
          if (!Array.isArray(rule.argvPrefix)) {
            throw new TypeError(`Rule ${rule.id} argvPrefix must be an array of strings`);
          }
          for (const argument of rule.argvPrefix) {
            if (typeof argument !== "string") {
              throw new TypeError(`Rule ${rule.id} argvPrefix must contain only strings`);
            }
          }
          argvPrefix = Object.freeze([...rule.argvPrefix]);
        }

        if (
          rule.minimumWorkspaceBytes !== undefined &&
          !isNonNegativeInteger(rule.minimumWorkspaceBytes)
        ) {
          throw new RangeError(
            `Rule ${rule.id} minimumWorkspaceBytes must be a non-negative integer`,
          );
        }

        return Object.freeze({
          id: rule.id,
          executable: rule.executable,
          ...(argvPrefix === undefined ? {} : { argvPrefix }),
          ...(rule.minimumWorkspaceBytes === undefined
            ? {}
            : { minimumWorkspaceBytes: rule.minimumWorkspaceBytes }),
        });
      }),
    );
    if (policy === undefined) {
      this.#policy = undefined;
    } else {
      if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
        throw new TypeError("Computer escalation policy must be an object");
      }
      if (policy.default !== "machine") {
        throw new TypeError('Computer escalation policy default must be exactly "machine"');
      }
      if (!Array.isArray(policy.isolateExecutables)) {
        throw new TypeError("Computer isolate executables must be an array of strings");
      }

      const isolateExecutables = new Set<string>();
      for (const executable of policy.isolateExecutables) {
        if (typeof executable !== "string" || executable.trim().length === 0) {
          throw new TypeError("Computer isolate executables must not be empty");
        }
        if (executable.includes("\0")) {
          throw new TypeError("Computer isolate executables must not contain NUL");
        }
        if (isolateExecutables.has(executable)) {
          throw new RangeError(`Duplicate computer isolate executable: ${executable}`);
        }
        isolateExecutables.add(executable);
      }

      const snapshot = Object.freeze({
        isolateExecutables: Object.freeze([...isolateExecutables]),
        default: "machine" as const,
      });
      this.#policy = snapshot;
    }
    Object.freeze(this);
  }

  decide(
    command: KernelCommand,
    evidence?: ComputerEscalationEvidence,
    catalogCommand: KernelCommand = command,
  ): ComputerEscalationDecision {
    const workspaceBytes = readWorkspaceBytes(evidence);
    const args = command.argv.slice(1);

    for (const rule of this.rules) {
      if (command.executable !== rule.executable || !matchesPrefix(args, rule.argvPrefix)) {
        continue;
      }

      if (rule.minimumWorkspaceBytes !== undefined) {
        if (workspaceBytes === undefined) {
          throw new ComputerEscalationEvidenceNotReadyError(rule.id);
        }
        if (workspaceBytes < rule.minimumWorkspaceBytes) continue;
      }

      return { kind: "machine", ruleId: rule.id };
    }

    if (this.#policy === undefined) return { kind: "isolate" };
    if (!this.#policy.isolateExecutables.includes(catalogCommand.executable)) {
      return { kind: "machine", reason: "unsupported-executable" };
    }
    const qualification = this.#qualify?.(catalogCommand);
    return qualification?.kind === "machine" ? qualification : { kind: "isolate" };
  }
}

function matchesPrefix(args: readonly string[], prefix: readonly string[] | undefined): boolean {
  if (prefix === undefined || prefix.length === 0) return true;
  if (args.length < prefix.length) return false;
  return prefix.every((argument, index) => args[index] === argument);
}

function readWorkspaceBytes(evidence: ComputerEscalationEvidence | undefined): number | undefined {
  if (evidence === undefined) return undefined;
  if (typeof evidence !== "object" || evidence === null) {
    throw new TypeError("Computer escalation evidence must be an object");
  }

  const { workspaceBytes } = evidence;
  if (workspaceBytes === undefined) return undefined;
  if (!isNonNegativeInteger(workspaceBytes)) {
    throw new RangeError("workspaceBytes must be a non-negative integer");
  }
  return workspaceBytes;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}
