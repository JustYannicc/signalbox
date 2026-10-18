import { useEnvironments } from "./environments";

/** Keep every cloud's Trash visible, including an offline cloud's reconnect state. */
export function useTrashEnvironments() {
  return useEnvironments().environments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.folders === true,
  );
}
