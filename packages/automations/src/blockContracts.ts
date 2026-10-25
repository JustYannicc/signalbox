import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";

import type { WorkflowMeta } from "@t3tools/contracts";

export interface InvalidWorkflowContract {
  readonly _tag: "InvalidWorkflowContract";
  readonly message: string;
}

export type WorkflowContractError = Schema.SchemaError | InvalidWorkflowContract;
export type WorkflowContractSide = "input" | "output";

function invalidContract(error: unknown): InvalidWorkflowContract {
  return {
    _tag: "InvalidWorkflowContract",
    message:
      error instanceof Error ? error.message : "The automation contract could not be loaded.",
  };
}

/** Decodes a value against a compiled Effect Schema contract, if one was declared. */
export function decodeWorkflowContract(
  contract: WorkflowMeta["input"],
  value: unknown,
): Result.Result<unknown, WorkflowContractError> {
  if (contract === undefined) return Result.succeed(value);

  try {
    const document = SchemaRepresentation.fromJson(contract);
    const schema = SchemaRepresentation.fromRepresentation(document, {
      revivers: [SchemaRepresentation.isIntReviver],
    });
    const decoder = Schema.make<Schema.ConstraintDecoder<unknown>>(schema.ast);
    return Schema.decodeUnknownResult(decoder)(value);
  } catch (error) {
    return Result.fail(invalidContract(error));
  }
}

export function decodeWorkflowInput(
  meta: Pick<WorkflowMeta, "input">,
  input: unknown,
): Result.Result<unknown, WorkflowContractError> {
  return decodeWorkflowContract(meta.input, input);
}

export function decodeWorkflowOutput(
  meta: Pick<WorkflowMeta, "output">,
  output: unknown,
): Result.Result<unknown, WorkflowContractError> {
  return decodeWorkflowContract(meta.output, output);
}

export function decodeBlockValue(
  meta: Pick<WorkflowMeta, "input" | "output">,
  side: WorkflowContractSide,
  value: unknown,
): Result.Result<unknown, WorkflowContractError> {
  return decodeWorkflowContract(meta[side], value);
}
