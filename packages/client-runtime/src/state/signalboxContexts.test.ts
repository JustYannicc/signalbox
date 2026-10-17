import { ProjectId } from "@t3tools/contracts";
import {
  PERSONAL_CONTEXT_ID,
  SignalboxContextId,
  type SignalboxContextsSnapshot,
} from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "vite-plus/test";

import { contextIdOfProject } from "./signalboxContexts.ts";

const scratch = { id: ProjectId.make("scratch") };
const acme = { id: ProjectId.make("context:org_acme") };

const contexts: SignalboxContextsSnapshot = {
  contexts: [
    { id: PERSONAL_CONTEXT_ID, kind: "personal", name: "Personal", projectIds: [scratch.id] },
    {
      id: SignalboxContextId.make("org_acme"),
      kind: "organization",
      name: "Acme",
      projectIds: [acme.id],
    },
  ],
};

describe("contextIdOfProject", () => {
  it("finds a project's context", () => {
    expect(contextIdOfProject(contexts, acme.id)).toBe("org_acme");
    expect(contextIdOfProject(contexts, ProjectId.make("elsewhere"))).toBeUndefined();
    expect(contextIdOfProject(null, scratch.id)).toBeUndefined();
  });
});
