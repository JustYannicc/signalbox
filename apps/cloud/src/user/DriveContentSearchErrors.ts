import * as Schema from "effect/Schema";

export const messages = {
  ContentSearchDenied: "You don't have access to this folder's files.",
  ContentSearchExpired: "This search expired or changed. Start a new search.",
  ContentSearchUnavailable: "Files are unavailable in this cloud.",
  ContentSearchReferencesChanged: "Folder references changed. Start a new search.",
  ContentSearchFailed: "The folder could not be searched. Try again.",
};

export class ContentSearchDenied extends Schema.TaggedError<ContentSearchDenied>()(
  "ContentSearchDenied",
  {
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return messages.ContentSearchDenied;
  }
}
export class ContentSearchExpired extends Schema.TaggedError<ContentSearchExpired>()(
  "ContentSearchExpired",
  {},
) {
  override get message() {
    return messages.ContentSearchExpired;
  }
}
export class ContentSearchUnavailable extends Schema.TaggedError<ContentSearchUnavailable>()(
  "ContentSearchUnavailable",
  {},
) {
  override get message() {
    return messages.ContentSearchUnavailable;
  }
}
export class ContentSearchReferencesChanged extends Schema.TaggedError<ContentSearchReferencesChanged>()(
  "ContentSearchReferencesChanged",
  {},
) {
  override get message() {
    return messages.ContentSearchReferencesChanged;
  }
}
export class ContentSearchFailed extends Schema.TaggedError<ContentSearchFailed>()(
  "ContentSearchFailed",
  {
    stage: Schema.Literals([
      "identity",
      "source_access",
      "source_references",
      "snapshot",
      "scan",
      "cursor_read",
      "cursor_bind",
      "cursor_save",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return messages.ContentSearchFailed;
  }
}
export type Failure =
  | ContentSearchDenied
  | ContentSearchExpired
  | ContentSearchUnavailable
  | ContentSearchReferencesChanged
  | ContentSearchFailed;
export const isFailure = Schema.is(
  Schema.Union([
    ContentSearchDenied,
    ContentSearchExpired,
    ContentSearchUnavailable,
    ContentSearchReferencesChanged,
    ContentSearchFailed,
  ]),
);
