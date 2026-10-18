import { RuntimeRequestId } from "@t3tools/contracts";

const prefix = "runtime-request:secret-send:";

export const secretSendRequestId = (runId: string, ordinal: number) =>
  RuntimeRequestId.make(`${prefix}${runId}:${ordinal}`);

/** Only the cloud can allocate these requests and their transcript cards. */
export const isSecretSendId = (id: string) =>
  id.startsWith(prefix) || id.startsWith(`turn-item:${prefix}`);
