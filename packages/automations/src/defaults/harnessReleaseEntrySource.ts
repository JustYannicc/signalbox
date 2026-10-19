export const HARNESS_RELEASE_ENTRY_SOURCE = `export default workflow(async (w, _input: unknown, trigger: { at: string }) => {
  const candidates: Candidate[] = [];
  for (const source of NPM_PACKAGES) {
    const packagePath = source.packageName.replace("/", "%2f");
    const metadata = responseJson(await w.http(
      "Read npm release metadata",
      \`https://registry.npmjs.org/\${packagePath}\`,
    ));
    candidates.push(...parseNpm(metadata, source));
  }
  candidates.push(...await discoverCodex(w));
  const ordered = orderReleaseCandidates(candidates);
  const head = responseJson(await w.http(
    "Read the Signalbox source head",
    "https://api.github.com/repos/JustYannicc/signalbox/commits/main",
  ));
  if (!isRecord(head) || typeof head.sha !== "string")
    return { status: "pending", reason: "The current source head could not be read." };

  const current = ordered.filter((release) => release.selection === "current");
  const backfill = ordered.filter((release) => release.selection === "backfill");
  const results = [];
  const verifiedCurrentProviders = [];
  const currentBatch = nextHarnessReleaseBatch(candidates)
    .filter((release) => release.selection === "current");
  for (const candidate of currentBatch) {
    const result = await runRelease(w, candidate, head.sha, trigger.at);
    results.push({ discoveryId: candidate.id, ...result });
    if (result.verified === true) verifiedCurrentProviders.push(candidate.provider);
  }
  const allCurrentGreen =
    current.length === 3 &&
    current.every((release) => verifiedCurrentProviders.includes(release.provider));
  let backfillSummary = {
    total: backfill.length,
    terminal: 0,
    green: 0,
    red: 0,
    pending: backfill.length,
    acceptance: "blocked-on-current" as const,
  };
  if (allCurrentGreen) {
    const backfillReceipts = [];
    for (const candidate of backfill) {
      const receipt = await w.recall(
        "Read a historical release receipt",
        releaseReceiptKey(candidate.provider, candidate.version, head.sha),
      );
      if (isRecord(receipt)) backfillReceipts.push({ discoveryId: candidate.id, ...receipt });
    }
    const terminalBackfillIds = backfillReceipts
      .filter((receipt) =>
        receipt.workflowStatus === "completed" && receipt.proofArtifactVerified === true,
      )
      .map((receipt) => receipt.discoveryId)
      .filter((id): id is string => typeof id === "string");
    const backfillBatch = nextHarnessReleaseBatch(
      candidates,
      verifiedCurrentProviders,
      terminalBackfillIds,
    ).filter((release) => release.selection === "backfill");
    for (const candidate of backfillBatch) {
      const result = await runRelease(w, candidate, head.sha, trigger.at);
      results.push({ discoveryId: candidate.id, ...result });
      const currentReceipts = backfillReceipts.filter(
        (receipt) => receipt.discoveryId !== candidate.id,
      );
      if (result.proofArtifactVerified === true) {
        currentReceipts.push({
          discoveryId: candidate.id,
          runKey: releaseRunKey(candidate.provider, candidate.version),
          headSha: head.sha,
          workflowStatus: result.workflowStatus,
          proofStatus: result.proofStatus,
          proofArtifactVerified: true,
        });
      }
      backfillReceipts.splice(0, backfillReceipts.length, ...currentReceipts);
    }
    backfillSummary = summarizeHarnessBackfill(candidates, backfillReceipts, head.sha);
  }
  return {
    headSha: head.sha,
    current: current.length,
    backfillAvailable: backfill.length,
    backfillAcceptance: backfillSummary,
    attempted: results.length,
    results,
  };
});
`;
