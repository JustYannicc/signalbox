import { expect, it } from "vite-plus/test";
import { prepareHarnessFilesCheckpoint } from "../HarnessFilesStore.ts";
import { snapshotCheckpointInput } from "./checkpointContract.ts";

it("preserves a symlink checkpoint's manifest when freezing process completion input", async () => {
  const control = {
    ownerId: "owner",
    incarnationId: "controller",
    epoch: 1,
    controlKey: "checkpoint-control-key-".repeat(2),
  };
  const publisher = {
    generation: 1,
    facetNonce: "facet",
    publisherKey: "checkpoint-publisher-key-".repeat(2),
  };
  const files = [
    { path: "README.md", mode: 0o644, bytes: new TextEncoder().encode("checkpoint content\n") },
    {
      path: "readme-link",
      mode: 0o755,
      kind: "symlink" as const,
      bytes: new TextEncoder().encode("README.md"),
    },
  ];
  const checkpoint = { checkpointId: "turn-1", parentCheckpointId: "initial", files };
  const expected = await prepareHarnessFilesCheckpoint(checkpoint);
  const frozen = snapshotCheckpointInput({
    runId: "run",
    processId: "process",
    executionOperationId: "creation",
    processOperationId: "creation",
    requestId: "turn-1",
    nativeSessionId: "native",
    control,
    publisher,
    checkpoint,
  });
  files[1]!.bytes.fill(0);
  const committed = await prepareHarnessFilesCheckpoint(frozen.checkpoint);
  expect(committed.manifestSha256).toBe(expected.manifestSha256);
  expect(committed.files.find((file) => file.path === "readme-link")?.kind).toBe("symlink");
});
