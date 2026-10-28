import { setup, complete, resumeInput, type ProofEnv } from "./publicResumeSetup.fixture.ts";
import { fixtureControl } from "./publicResumeStores.fixture.ts";

export async function publicWarmDrain(env: ProofEnv) {
  const fixture = await setup(env, "warm-drain", { holdWork: true });
  const running = fixture.shard.runShard(fixture.shardInput, "warm-drain-first");
  await fixture.files.wait("fetch-entered:turn-one");
  const operation = await resumeInput(fixture);
  const replacing = fixture.shard.resumeProcess(operation);
  await Promise.race([
    fixture.a.waitDrain(operation.transition.operationId),
    replacing.then(() => {
      throw new Error("The replacement returned before the current request joined.");
    }),
  ]);
  const whileDraining = {
    evidence: await fixture.shard.evidence(),
    placement: await fixture.placement.ownership(fixture.owner),
    releases: await fixture.placement.releases(),
  };
  await fixture.files.release("fetch:turn-one");
  await fixture.files.wait("callback-entered:turn-one");
  await fixture.files.release("callback:turn-one");
  await fixture.store.waitForFinish("turn-one");
  const checkpoint = await complete(fixture, "turn-one", "process-one", fixtureControl(3));
  const first = await running;
  const resumed = await replacing;
  const duplicateDenied = await fixture.shard.resumeProcess(operation).then(
    () => false,
    () => true,
  );
  return {
    whileDraining,
    checkpoint: checkpoint.result.status,
    first,
    resumed,
    duplicateDenied,
    evidence: await fixture.shard.evidence(),
    releases: await fixture.placement.releases(),
    observations: await fixture.files.observations(),
  };
}
