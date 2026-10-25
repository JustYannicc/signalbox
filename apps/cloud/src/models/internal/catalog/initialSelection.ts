import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import { poolInstanceId } from "@t3tools/contracts/accountHub";
import { ProviderInstanceId } from "@t3tools/contracts";
import { resolveInitialModelSelection } from "@t3tools/shared/defaultModelSelection";

import { poolIdOfInstance, poolKindOfInstance } from "./routing.ts";
import { readyProviders } from "./poolProviders.ts";

export const initialSelection = (
  catalog: ReadonlyArray<ServerProvider>,
  pool: string | null,
  personDefault: ModelSelection | null,
): ModelSelection | null => {
  const providers = readyProviders(catalog);
  const destinationProviders =
    pool === null
      ? providers
      : providers.filter((provider) => poolIdOfInstance(provider.instanceId) === pool);
  const kind = personDefault === null ? undefined : poolKindOfInstance(personDefault.instanceId);
  const preference =
    personDefault && pool && kind !== undefined
      ? { ...personDefault, instanceId: ProviderInstanceId.make(poolInstanceId(kind, pool)) }
      : personDefault;
  const supportedPreference =
    preference &&
    (pool === null ||
      preference.instanceId === personDefault?.instanceId ||
      destinationProviders.some(
        (provider) =>
          provider.instanceId === preference.instanceId &&
          provider.models.some(
            (model) =>
              !model.isLegacy &&
              (model.slug === preference.model || model.aliases?.includes(preference.model)),
          ),
      ))
      ? preference
      : null;
  return resolveInitialModelSelection({
    personDefault: supportedPreference,
    providers: destinationProviders,
  });
};
