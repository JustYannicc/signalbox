import * as Schema from "effect/Schema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";
import { describe, expect, it } from "vite-plus/test";

import { blockContract } from "./blockContract.ts";

/** What the compiler stores for `meta.input`/`meta.output`. */
const stored = (schema: Schema.Top) =>
  SchemaRepresentation.toJson(SchemaRepresentation.toRepresentation(schema.ast));

describe("blockContract", () => {
  it("writes a declared struct back out as Effect Schema code", () => {
    const contract = blockContract(
      stored(
        Schema.Struct({
          issueId: Schema.String.annotate({ description: "Remote issue identifier" }),
          note: Schema.optionalKey(Schema.NullOr(Schema.String)),
          tags: Schema.Array(Schema.Literals(["bug", "feat"])),
        }),
      ),
    );
    expect(contract).toEqual({
      _tag: "Declared",
      code: 'Schema.Struct({ "issueId": Schema.String.annotate({ "description": "Remote issue identifier" }), "note": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "tags": Schema.Array(Schema.Literals(["bug", "feat"])) })',
    });
  });

  // Stored JSON has no code for checks; without reviving, Int can't be written out.
  it("keeps Int as an integer check", () => {
    const contract = blockContract(stored(Schema.Struct({ count: Schema.Int })));
    expect(contract._tag).toBe("Declared");
    expect(contract._tag === "Declared" && contract.code).toContain("Schema.isInt()");
  });

  it("writes named references before the root that uses them", () => {
    const Id = Schema.String.annotate({ identifier: "IssueId" });
    const contract = blockContract(stored(Schema.Struct({ from: Id, to: Id })));
    expect(contract._tag === "Declared" && contract.code.split("\n\n")).toEqual([
      'const IssueId = Schema.String.annotate({ "identifier": "IssueId" })',
      'Schema.Struct({ "from": IssueId, "to": IssueId })',
    ]);
  });

  it("says nothing was declared rather than inventing a shape", () => {
    expect(blockContract(undefined)).toEqual({ _tag: "Undeclared" });
  });

  it("calls malformed or unsupported contracts unreadable", () => {
    expect(blockContract({ nope: 1 })).toEqual({ _tag: "Unreadable" });
    expect(blockContract({ representation: { _tag: "Nope" }, references: {} })).toEqual({
      _tag: "Unreadable",
    });
    // A check no reviver here knows: shown as unreadable, not as plain Number.
    expect(blockContract(stored(Schema.Number.check(Schema.isGreaterThan(0))))).toEqual({
      _tag: "Unreadable",
    });
  });
});
