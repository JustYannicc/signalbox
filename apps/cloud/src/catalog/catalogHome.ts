import { TrimmedNonEmptyString } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID, SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { FolderId } from "@t3tools/contracts/signalboxFolders";
import * as Schema from "effect/Schema";

const PersonId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));

export const CatalogOwner = Schema.Union([
  Schema.TaggedStruct("person", { id: PersonId }),
  Schema.TaggedStruct("organization", {
    id: SignalboxContextId.check(Schema.makeFilter((id) => id !== PERSONAL_CONTEXT_ID)),
  }),
]);

export const CatalogHome = Schema.Struct({
  owner: CatalogOwner,
  level: Schema.Union([
    Schema.TaggedStruct("top", {}),
    Schema.TaggedStruct("folder", { id: FolderId }),
  ]),
  // Legacy org folders are independent private copies, even when their folder IDs match.
  legacySource: Schema.optionalKey(PersonId),
}).check(
  Schema.makeFilter(
    (home) =>
      home.owner._tag !== "person" ||
      home.legacySource === undefined ||
      home.legacySource === home.owner.id,
  ),
);
export type CatalogHome = typeof CatalogHome.Type;

const HomeKey = Schema.fromJsonString(
  Schema.Tuple([
    Schema.Literal("catalog"),
    Schema.Literal(1),
    Schema.Literals(["person", "organization"]),
    TrimmedNonEmptyString,
    Schema.NullOr(PersonId),
    Schema.NullOr(FolderId),
  ]),
);
const encodeKey = Schema.encodeSync(HomeKey);
const decodeKey = Schema.decodeUnknownSync(HomeKey);
const decodeHome = Schema.decodeSync(CatalogHome);

/** A home identity, never an authorization grant or an index generation. */
export const catalogHomeKey = (input: CatalogHome) => {
  const home = decodeHome(input);
  return encodeKey([
    "catalog",
    1,
    home.owner._tag,
    home.owner.id,
    home.legacySource ?? null,
    home.level._tag === "top" ? null : home.level.id,
  ]);
};

export const catalogHomeFromKey = (key: string): CatalogHome => {
  const [, , ownerKind, ownerId, legacySource, folderId] = decodeKey(key);
  return decodeHome({
    owner:
      ownerKind === "person"
        ? { _tag: "person", id: ownerId }
        : { _tag: "organization", id: ownerId },
    level: folderId === null ? { _tag: "top" } : { _tag: "folder", id: folderId },
    ...(legacySource === null ? {} : { legacySource }),
  });
};

/** Resolves a user-local home without merging its data into another person's copy. */
export const legacyCatalogHome = (input: {
  readonly personId: string;
  readonly contextId: SignalboxContextId;
  readonly folderId: FolderId | null;
}): CatalogHome =>
  decodeHome({
    owner:
      input.contextId === PERSONAL_CONTEXT_ID
        ? { _tag: "person", id: input.personId }
        : { _tag: "organization", id: input.contextId },
    level: input.folderId === null ? { _tag: "top" } : { _tag: "folder", id: input.folderId },
    legacySource: input.personId,
  });
