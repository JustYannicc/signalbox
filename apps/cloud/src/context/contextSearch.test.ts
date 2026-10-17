import type { SignalboxContext } from "@t3tools/contracts/signalboxContexts";
import { PERSONAL_CONTEXT_ID, SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import type { SignalboxDrive } from "@t3tools/contracts/signalboxDrives";
import { SignalboxDriveId } from "@t3tools/contracts/signalboxDrives";
import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { projectIdForContext, projectIdForDrive } from "../user/contextProjects.ts";
import { limitReaderSearchScope, readerSearchScope } from "./ContextTool.ts";

const ACME = SignalboxContextId.make("org_acme");
const OTHER = SignalboxContextId.make("org_other");
const PERSONAL = projectIdForContext(PERSONAL_CONTEXT_ID);
const ACME_HOME = projectIdForContext(ACME);
const BILLING = projectIdForDrive("shared/org_acme/billing");
const OTHER_HOME = projectIdForContext(OTHER);

const contexts: ReadonlyArray<SignalboxContext> = [
  { id: PERSONAL_CONTEXT_ID, kind: "personal", name: "Personal", projectIds: [PERSONAL] },
  { id: ACME, kind: "organization", name: "Acme", projectIds: [ACME_HOME, BILLING] },
  { id: OTHER, kind: "organization", name: "Other", projectIds: [OTHER_HOME] },
];

const drives: ReadonlyArray<SignalboxDrive> = [
  {
    id: SignalboxDriveId.make("my/personal/alice"),
    projectId: PERSONAL,
    contextId: PERSONAL_CONTEXT_ID,
    kind: "my",
    name: "My Drive",
    role: "owner",
    sharedBy: null,
  },
  {
    id: SignalboxDriveId.make("my/org_acme/alice"),
    projectId: ACME_HOME,
    contextId: ACME,
    kind: "my",
    name: "My Drive",
    role: "owner",
    sharedBy: null,
  },
  {
    id: SignalboxDriveId.make("shared/org_acme/billing"),
    projectId: BILLING,
    contextId: ACME,
    kind: "shared",
    name: "Billing",
    role: "manager",
    sharedBy: null,
  },
  {
    id: SignalboxDriveId.make("my/org_other/alice"),
    projectId: OTHER_HOME,
    contextId: OTHER,
    kind: "my",
    name: "My Drive",
    role: "owner",
    sharedBy: null,
  },
];

describe("context search scope", () => {
  it("keeps queries and exact-item reads within the reader drive's owner and filters", () => {
    const scope = readerSearchScope("alice", "shared/org_acme/billing", contexts, drives);
    expect(scope?.actor.contextIds).toEqual([ACME]);
    expect(scope?.projectIds).toEqual([ACME_HOME, BILLING]);

    const query = limitReaderSearchScope(scope!, null, [PERSONAL, BILLING]);
    expect(query).toEqual({ drives: [drives[2]], projectIds: [BILLING] });

    const exactItem = limitReaderSearchScope(scope!, null, [PERSONAL]);
    expect(exactItem).toEqual({ drives: [], projectIds: [] });
  });

  it("refuses searches when the token's source drive is no longer readable", () => {
    expect(readerSearchScope("alice", "shared/org_acme/missing", contexts, drives)).toBeNull();
  });

  it("does not widen a selected drive when the request carries project filters", () => {
    const scope = readerSearchScope("alice", "shared/org_acme/billing", contexts, drives)!;
    expect(limitReaderSearchScope(scope, "shared/org_acme/billing", [ACME_HOME, BILLING])).toEqual({
      drives: [drives[2]],
      projectIds: [BILLING],
    });
    expect(limitReaderSearchScope(scope, "shared/org_other/anything")).toBeNull();
  });
});
