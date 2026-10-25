import {
  control1,
  control2,
  control3,
  durableFor,
  failed,
  initialize,
  publisher1,
  publisher2,
  publisher3,
  stopAndPrepare,
} from "./harnessStateWorkerd.base.ts";
import type { WorkerdEnv } from "./harnessStateWorkerd.base.ts";

export async function publicationReceiptSelection(env: WorkerdEnv) {
  const runId = "workerd-publication-receipt-selection-proof";
  const durable = durableFor(env, runId);
  const initialized = await initialize(durable, runId);
  const checkpoint = initialized.files.checkpoint;
  await stopAndPrepare(durable, runId, control1, publisher1, control2, "publication-a", publisher2);
  const first = await durable.publishFreshFacet({
    control: control2,
    operationId: "publication-a",
    verifiedNativeSessionId: "workerd-native-session",
    checkpoint,
  });
  await durable.recordActivation({ control: control2, operationId: "publication-a" });
  await stopAndPrepare(durable, runId, control2, publisher2, control3, "publication-b", publisher3);
  await env.HARNESS_FILES_STORE.getByName(runId).execute({
    type: "publishFacet",
    runId,
    control: control3,
    publisher: publisher2,
    expectedGeneration: 2,
    preparedPublisher: publisher3,
    operationId: "publication-b",
    checkpoint,
  });

  const confirmedA = await durable.readPublication({
    control: control3,
    operationId: "publication-a",
  });
  const pendingB = await durable.readPublication({
    control: control3,
    operationId: "publication-b",
  });
  const missing = await failed(() =>
    durable.readPublication({ control: control3, operationId: "missing-publication" }),
  );
  const staleClaim = await failed(() =>
    durable.readPublication({ control: control2, operationId: "publication-a" }),
  );

  return {
    firstStatus: first.status,
    confirmedA: confirmedA.publication,
    pendingB: pendingB.publication,
    missingCode: missing.code,
    staleClaimCode: staleClaim.code,
  };
}
