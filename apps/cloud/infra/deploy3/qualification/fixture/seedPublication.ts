import type { Configuration } from "./configuration.ts";
import type { CapabilityEnvironment } from "./capabilities.ts";
import { verifySeedConfiguration } from "./seedConfiguration.ts";
import { assert, control } from "./common.ts";

const seedPublisher = {
  generation: 1,
  facetNonce: "seed-only",
  publisherKey: "qualifier-seed-publisher-key-".repeat(2),
};

export async function publishSeedCheckpoint(config: Configuration, env: CapabilityEnvironment) {
  const runId = `${config.runId}/seed`;
  const { checkpoint: seed } = await verifySeedConfiguration(config.seed);
  const files = seed.files;
  const store = env.HARNESS_FILES_STORE.getByName(runId);
  const initialized = await store.execute({
    type: "initialize",
    runId,
    control: control(1),
    publisher: seedPublisher,
    checkpoint: { checkpointId: config.seed.checkpointId, parentCheckpointId: null, files },
  });
  const checkpoint = await store.execute({
    type: "readCheckpoint",
    runId,
    publisher: seedPublisher,
    checkpointId: config.seed.checkpointId,
  });
  assert(
    checkpoint.checkpoint.manifestSha256 === initialized.checkpoint.manifestSha256 &&
      checkpoint.checkpoint.manifestSha256 === config.seed.manifestSha256 &&
      checkpoint.files.length === files.length &&
      checkpoint.files.length > 0,
    "Public seed checkpoint read must return all frozen files",
  );
  return checkpoint;
}
