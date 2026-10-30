import type * as Schema from "effect/Schema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";

/**
 * A block's `input` or `output` as the library shows it: the Effect Schema
 * that declared it, written back out as code. Contracts arrive as Effect's
 * schema representation JSON, not JSON Schema.
 */
export type BlockContract =
  | { readonly _tag: "Undeclared" }
  | { readonly _tag: "Declared"; readonly code: string }
  | { readonly _tag: "Unreadable" };

/** What a side without a contract says: "Any input — no contract declared". */
export const undeclaredContractLabel = (side: "input" | "output") =>
  `Any ${side} — no contract declared`;

export const UNREADABLE_CONTRACT = "This contract can't be shown here.";

export function blockContract(contract: Schema.Json | undefined): BlockContract {
  if (contract === undefined) return { _tag: "Undeclared" };
  try {
    // JSON drops the `toCode` that checks like `Int` carry; reviving them as
    // the engine does when it decodes puts it back. Checks this can't revive
    // throw, and show as unreadable rather than as a guess.
    const schema = SchemaRepresentation.fromRepresentation(
      SchemaRepresentation.fromJson(contract),
      {
        revivers: [SchemaRepresentation.isIntReviver],
      },
    );
    const document = SchemaRepresentation.toCodeDocument(
      SchemaRepresentation.toMultiDocument(SchemaRepresentation.toRepresentation(schema.ast)),
    );
    const root = document.codes[0];
    if (root === undefined) return { _tag: "Unreadable" };
    const lines: Array<string> = [];
    for (const artifact of document.artifacts) {
      lines.push(
        artifact._tag === "Import"
          ? artifact.importDeclaration
          : `const ${artifact.identifier} = ${artifact.code.runtime}`,
      );
    }
    for (const reference of document.references.nonRecursives) {
      lines.push(`const ${reference.$ref} = ${reference.code.runtime}`);
    }
    for (const [name, code] of Object.entries(document.references.recursives)) {
      lines.push(`const ${name} = ${code.runtime}`);
    }
    lines.push(root.runtime);
    return { _tag: "Declared", code: lines.join("\n\n") };
  } catch {
    return { _tag: "Unreadable" };
  }
}
