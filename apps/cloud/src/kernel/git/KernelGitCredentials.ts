export interface KernelGitCredentials {
  readonly uid: number;
  readonly gid: number;
  readonly euid: number;
  readonly egid: number;
}

export function validateGitCredentials(credentials: KernelGitCredentials): KernelGitCredentials {
  for (const value of [credentials.uid, credentials.gid, credentials.euid, credentials.egid]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_fffe) {
      throw new RangeError("Git credentials must contain valid POSIX identifiers");
    }
  }
  if (credentials.uid !== credentials.euid || credentials.gid !== credentials.egid) {
    throw new RangeError("Git requires matching real and effective POSIX identities");
  }
  return Object.freeze({ ...credentials });
}
