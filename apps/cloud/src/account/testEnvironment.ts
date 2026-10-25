/** Returns the cloud environment where test sign-in is trusted, if any. */
export const trustedEnvironment = (
  stage: string | undefined,
  environmentId: string,
  localWorkerd: string | undefined,
): string | undefined => {
  if (stage === "dev" && environmentId === "cloud-dev" && localWorkerd === "1") {
    return environmentId;
  }
  const preview = stage?.match(/^pr-([1-9]\d*)$/);
  if (
    preview !== undefined &&
    preview !== null &&
    environmentId === `cloud-preview-${preview[1]}`
  ) {
    return environmentId;
  }
  return undefined;
};
