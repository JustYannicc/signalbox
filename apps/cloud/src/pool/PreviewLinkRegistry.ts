export const PREVIEW_LINK_REGISTRY_NAME = "preview-links";

export interface PreviewLinkCleanupTarget {
  readonly removePreviewLinks: (origin: string) => Promise<number>;
}

export interface PreviewLinkRegistryApi {
  /** Records a pool holding a preview link; false means this preview was closed. */
  readonly registerPool: (origin: string, poolId: string) => Promise<boolean>;
  /** Closes an origin and revokes every link registered for it. Safe to retry. */
  readonly cleanupOrigin: (
    origin: string,
    additionalPoolIds?: ReadonlyArray<string>,
  ) => Promise<number>;
  /** Allows a reopened pull request to create fresh preview links. */
  readonly activateOrigin: (origin: string) => Promise<void>;
  /** Origins with links, including ones whose previous cleanup needs retrying. */
  readonly listOrigins: () => Promise<ReadonlyArray<string>>;
}

export interface PreviewLinkRegistryNamespace {
  readonly idFromName: (name: string) => DurableObjectId;
  readonly get: (id: DurableObjectId) => PreviewLinkRegistryApi;
}

export const previewLinkRegistry = (namespace: PreviewLinkRegistryNamespace) =>
  namespace.get(namespace.idFromName(PREVIEW_LINK_REGISTRY_NAME));

export interface PreviewLinkRegistryStore {
  readonly registerPool: (origin: string, poolId: string) => boolean;
  readonly includePool: (origin: string, poolId: string) => void;
  readonly closeOrigin: (origin: string) => ReadonlyArray<string>;
  readonly removePool: (origin: string, poolId: string) => void;
  readonly activateOrigin: (origin: string) => void;
  readonly listOrigins: () => ReadonlyArray<string>;
}

export const makePreviewLinkRegistryApi = (
  store: PreviewLinkRegistryStore,
  removeLinks: (poolId: string, origin: string) => Promise<number>,
): PreviewLinkRegistryApi => ({
  registerPool: async (origin, poolId) => store.registerPool(origin, poolId),
  cleanupOrigin: async (origin, additionalPoolIds = []) => {
    for (const poolId of additionalPoolIds) store.includePool(origin, poolId);
    let removed = 0;
    for (const poolId of store.closeOrigin(origin)) {
      removed += await removeLinks(poolId, origin);
      store.removePool(origin, poolId);
    }
    return removed;
  },
  activateOrigin: async (origin) => store.activateOrigin(origin),
  listOrigins: async () => store.listOrigins(),
});
