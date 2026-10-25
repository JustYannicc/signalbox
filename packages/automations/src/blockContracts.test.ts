import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";

import { decodeWorkflowInput, decodeWorkflowOutput } from "@signalbox/automations/blockContracts";

const contract = (schema: Schema.Top) =>
  SchemaRepresentation.toJson(SchemaRepresentation.toRepresentation(schema.ast));

describe("compiled automation block contracts", () => {
  it("decodes input and output using the Effect Schema representation", () => {
    const input = contract(
      Schema.Struct({ id: Schema.String, label: Schema.optionalKey(Schema.String) }),
    );
    const output = contract(Schema.Array(Schema.Number));

    const decodedInput = decodeWorkflowInput({ input }, { id: "issue-1" });
    const decodedOutput = decodeWorkflowOutput({ output }, [1, 2]);

    expect(Result.isSuccess(decodedInput) && decodedInput.success).toEqual({ id: "issue-1" });
    expect(Result.isSuccess(decodedOutput) && decodedOutput.success).toEqual([1, 2]);
  });

  it("returns schema errors for values outside the declared contract", () => {
    const input = contract(Schema.Struct({ id: Schema.String }));
    const result = decodeWorkflowInput({ input }, { id: 1 });

    expect(Result.isFailure(result)).toBe(true);
  });

  it("restores Effect built in check revivers for integer contracts", () => {
    const input = contract(Schema.Struct({ count: Schema.Int }));
    const valid = decodeWorkflowInput({ input }, { count: 3 });
    const invalid = decodeWorkflowInput({ input }, { count: 3.5 });

    expect(Result.isSuccess(valid)).toBe(true);
    expect(Result.isFailure(invalid)).toBe(true);
  });

  it("passes through values when no contract was declared", () => {
    const value = { arbitrary: [1, true, null] };
    const result = decodeWorkflowOutput({}, value);

    expect(Result.isSuccess(result) && result.success).toBe(value);
  });

  it("rejects malformed serialized contracts", () => {
    const result = decodeWorkflowInput({ input: null }, "value");

    expect(Result.isFailure(result) && result.failure._tag).toBe("InvalidWorkflowContract");
  });
});
