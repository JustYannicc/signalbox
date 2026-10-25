import type {
  HarnessProcessResumeInput,
  HarnessProcessResumePreparedRelease,
} from "./contracts.ts";

const sameReleaseModules = (
  left: HarnessProcessResumePreparedRelease["plan"]["release"]["modules"],
  right: HarnessProcessResumePreparedRelease["plan"]["release"]["modules"],
) => {
  const names = Object.keys(left);
  return (
    names.length === Object.keys(right).length &&
    names.every((name) => {
      if (!Object.hasOwn(right, name)) return false;
      const leftModule = left[name];
      const rightModule = right[name];
      return (
        leftModule !== undefined &&
        rightModule !== undefined &&
        leftModule.bytes === rightModule.bytes &&
        leftModule.sha256 === rightModule.sha256
      );
    })
  );
};

const samePreparedModules = (
  left: HarnessProcessResumePreparedRelease["plan"]["preparedModules"],
  right: HarnessProcessResumePreparedRelease["plan"]["preparedModules"],
) => {
  const names = Object.keys(left);
  return (
    names.length === Object.keys(right).length &&
    names.every((name) => {
      if (!Object.hasOwn(right, name)) return false;
      const leftModule = left[name];
      const rightModule = right[name];
      return (
        leftModule !== undefined &&
        rightModule !== undefined &&
        leftModule.component === rightModule.component &&
        leftModule.name === rightModule.name &&
        leftModule.path === rightModule.path &&
        leftModule.bytes === rightModule.bytes &&
        leftModule.sha256 === rightModule.sha256 &&
        leftModule.type === rightModule.type
      );
    })
  );
};

export const samePreparedRelease = (
  left: HarnessProcessResumePreparedRelease | undefined,
  right: HarnessProcessResumePreparedRelease,
) => {
  if (left === undefined) return false;
  try {
    return (
      left.artifact.provider === right.artifact.provider &&
      left.artifact.releaseId === right.artifact.releaseId &&
      left.artifact.artifactHash === right.artifact.artifactHash &&
      left.artifact.artifactRef === right.artifact.artifactRef &&
      left.artifact.sourceIdentity === right.artifact.sourceIdentity &&
      left.artifact.fixtureIdentity === right.artifact.fixtureIdentity &&
      left.artifact.createdAt === right.artifact.createdAt &&
      left.plan.release.harness === right.plan.release.harness &&
      left.plan.release.version === right.plan.release.version &&
      left.plan.release.manifestSha256 === right.plan.release.manifestSha256 &&
      sameReleaseModules(left.plan.release.modules, right.plan.release.modules) &&
      left.plan.sourceIdentity === right.plan.sourceIdentity &&
      left.plan.computer.sourceIdentity === right.plan.computer.sourceIdentity &&
      left.plan.computer.manifestSha256 === right.plan.computer.manifestSha256 &&
      samePreparedModules(left.plan.preparedModules, right.plan.preparedModules)
    );
  } catch {
    return false;
  }
};

const snapshotPreparedRelease = (
  value: HarnessProcessResumePreparedRelease,
): HarnessProcessResumePreparedRelease | undefined => {
  try {
    const artifact = value.artifact;
    const plan = value.plan;
    if (
      !artifact.provider ||
      !artifact.releaseId ||
      !artifact.artifactHash ||
      artifact.artifactRef !== `sha256:${artifact.artifactHash}` ||
      !artifact.sourceIdentity ||
      !artifact.fixtureIdentity ||
      !artifact.createdAt ||
      !plan.release.harness ||
      !plan.release.version ||
      !plan.release.manifestSha256 ||
      plan.sourceIdentity !== artifact.sourceIdentity ||
      plan.release.manifestSha256 !== artifact.artifactHash ||
      !plan.computer.sourceIdentity ||
      !plan.computer.manifestSha256
    )
      return undefined;

    const releaseModules: Record<string, { bytes: number; sha256: string }> = {};
    for (const [name, module] of Object.entries(plan.release.modules)) {
      if (
        !name ||
        !Number.isSafeInteger(module.bytes) ||
        module.bytes < 0 ||
        typeof module.sha256 !== "string" ||
        !module.sha256
      )
        return undefined;
      releaseModules[name] = Object.freeze({ bytes: module.bytes, sha256: module.sha256 });
    }

    const preparedModules: Record<
      string,
      HarnessProcessResumePreparedRelease["plan"]["preparedModules"][string]
    > = {};
    for (const [key, module] of Object.entries(plan.preparedModules)) {
      if (
        !key ||
        !module.component ||
        !module.name ||
        !module.path ||
        !Number.isSafeInteger(module.bytes) ||
        module.bytes < 0 ||
        typeof module.sha256 !== "string" ||
        !module.sha256 ||
        !module.type
      )
        return undefined;
      preparedModules[key] = Object.freeze({
        component: module.component,
        name: module.name,
        path: module.path,
        bytes: module.bytes,
        sha256: module.sha256,
        type: module.type,
      });
    }

    return Object.freeze({
      artifact: Object.freeze({
        provider: artifact.provider,
        releaseId: artifact.releaseId,
        artifactHash: artifact.artifactHash,
        artifactRef: artifact.artifactRef,
        sourceIdentity: artifact.sourceIdentity,
        fixtureIdentity: artifact.fixtureIdentity,
        createdAt: artifact.createdAt,
      }),
      plan: Object.freeze({
        release: Object.freeze({
          harness: plan.release.harness,
          version: plan.release.version,
          manifestSha256: plan.release.manifestSha256,
          modules: Object.freeze(releaseModules),
        }),
        sourceIdentity: plan.sourceIdentity,
        computer: Object.freeze({
          sourceIdentity: plan.computer.sourceIdentity,
          manifestSha256: plan.computer.manifestSha256,
        }),
        preparedModules: Object.freeze(preparedModules),
      }),
    });
  } catch {
    return undefined;
  }
};

export const snapshotInput = (
  value: HarnessProcessResumeInput,
): HarnessProcessResumeInput | undefined => {
  try {
    const targetPreparedRelease = snapshotPreparedRelease(value.targetPreparedRelease);
    if (
      targetPreparedRelease === undefined ||
      !value.operationId ||
      !value.control.ownerId ||
      !value.control.incarnationId ||
      !Number.isSafeInteger(value.control.epoch) ||
      value.control.epoch <= 0 ||
      !value.control.controlKey ||
      !Number.isSafeInteger(value.publisher.generation) ||
      value.publisher.generation <= 0 ||
      !value.publisher.facetNonce ||
      !value.publisher.publisherKey ||
      !value.nextControl.ownerId ||
      !value.nextControl.incarnationId ||
      !Number.isSafeInteger(value.nextControl.epoch) ||
      !value.nextControl.controlKey ||
      !Number.isSafeInteger(value.expectedFacetGeneration) ||
      value.expectedFacetGeneration < 0 ||
      value.publisher.generation !== value.expectedFacetGeneration
    )
      return undefined;
    return Object.freeze({
      operationId: value.operationId,
      control: Object.freeze({ ...value.control }),
      publisher: Object.freeze({ ...value.publisher }),
      nextControl: Object.freeze({ ...value.nextControl }),
      expectedFacetGeneration: value.expectedFacetGeneration,
      targetPreparedRelease,
    });
  } catch {
    return undefined;
  }
};
