import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerSettings } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { useEnvironmentCanWriteModelSettings } from "~/state/environmentCapabilities";
import { serverEnvironment } from "~/state/server";

const noSettings = Atom.make<ServerSettings | null>(null);

export function useWritableModelSettings(environmentId: EnvironmentId | null) {
  const settings = useAtomValue(
    environmentId ? serverEnvironment.settingsValueAtom(environmentId) : noSettings,
  );
  const canWrite = useEnvironmentCanWriteModelSettings(environmentId);
  return canWrite ? settings : null;
}
