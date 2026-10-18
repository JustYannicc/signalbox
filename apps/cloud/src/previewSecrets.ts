import * as Context from "effect/Context";

export const SyntheticSecretsEnabled = Context.Reference<boolean>(
  "@signalbox/cloud/previewSecrets/SyntheticSecretsEnabled",
  { defaultValue: () => false },
);

export const previewSyntheticSecretsEnabled = (env: {
  readonly SIGNALBOX_STAGE?: string;
  readonly ENVIRONMENT_ID?: string;
  readonly PREVIEW_SYNTHETIC_SECRETS?: string;
}) => {
  if (env.PREVIEW_SYNTHETIC_SECRETS !== "1") return false;
  const stage = /^pr-([1-9][0-9]*)$/.exec(env.SIGNALBOX_STAGE ?? "");
  return stage !== null && env.ENVIRONMENT_ID === `cloud-preview-${stage[1]}`;
};
