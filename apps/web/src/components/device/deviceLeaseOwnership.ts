export interface DeviceLeaseOwnerIdentity {
  readonly environmentId: string;
  readonly threadId: string;
  readonly hostId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly leaseId: string;
}

const pendingReleases = new Map<string, object>();

const keyOf = (owner: DeviceLeaseOwnerIdentity) =>
  JSON.stringify([
    owner.environmentId,
    owner.threadId,
    owner.hostId,
    owner.deviceId,
    owner.sessionId,
    owner.leaseId,
  ]);

export function retainDeviceLeaseOwner(owner: DeviceLeaseOwnerIdentity) {
  pendingReleases.delete(keyOf(owner));
}

export function deferDeviceLeaseRelease(owner: DeviceLeaseOwnerIdentity, release: () => unknown) {
  const key = keyOf(owner);
  const token = {};
  pendingReleases.set(key, token);
  queueMicrotask(() => {
    if (pendingReleases.get(key) !== token) return;
    pendingReleases.delete(key);
    void release();
  });
}
