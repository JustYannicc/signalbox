const install = String.raw`
import os, shutil, sys, tempfile

def install(source, target, mode, owner=None, timestamps=None):
    fd, temporary = tempfile.mkstemp(prefix=".signalbox-install-", dir=os.path.dirname(target))
    try:
        with os.fdopen(fd, "wb") as output:
            with open(source, "rb") as upload:
                shutil.copyfileobj(upload, output)
            if owner is not None:
                current = os.fstat(output.fileno())
                if current.st_uid != owner[0] or current.st_gid != owner[1]:
                    os.fchown(output.fileno(), owner[0], owner[1])
            os.fchmod(output.fileno(), mode)
        if timestamps is not None:
            os.utime(temporary, ns=timestamps)
        os.replace(temporary, target)
        os.unlink(source)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
`;

export const BOXD_PROOF_WORKSPACE_INSTALL =
  install +
  String.raw`
import json, stat

def install_workspace_file(staging, target, metadata):
    staged = os.lstat(staging)
    if not stat.S_ISREG(staged.st_mode) or staged.st_nlink != 1:
        raise RuntimeError("hydration staging path must be one regular file")
    if staged.st_size != int(metadata["size"]):
        raise RuntimeError("staged proof file size does not match its manifest")

    uid = metadata.get("uid")
    gid = metadata.get("gid")
    if uid is None and gid is None:
        uid, gid = staged.st_uid, staged.st_gid
    elif uid is None or gid is None:
        raise RuntimeError("proof file ownership must include uid and gid")

    mode = int(metadata["mode"]) & 0o777
    atime_ns = int(metadata["atimeNs"])
    mtime_ns = int(metadata["mtimeNs"])
    try:
        os.chmod(staging, 0o600)
        install(staging, target, mode, (uid, gid), (atime_ns, mtime_ns))
        installed = os.stat(target, follow_symlinks=False)
        if (
            not stat.S_ISREG(installed.st_mode)
            or installed.st_nlink != 1
            or installed.st_size != int(metadata["size"])
            or stat.S_IMODE(installed.st_mode) != mode
            or installed.st_uid != uid
            or installed.st_gid != gid
            or installed.st_atime_ns != atime_ns
            or installed.st_mtime_ns != mtime_ns
        ):
            raise RuntimeError("installed proof file metadata does not match its manifest")
    finally:
        if os.path.lexists(staging):
            os.unlink(staging)
`;

export const BOXD_PROOF_WORKSPACE_FINALIZE =
  String.raw`# BOXD_PROOF:finalize
import json, os, stat, sys
root = "/workspace"
if os.path.realpath(root) != root or not stat.S_ISDIR(os.lstat(root).st_mode):
    raise RuntimeError("proof workspace is not canonical")
metadata = json.loads(sys.argv[1])
staging = metadata.get("stagingPath")
if (
    not isinstance(staging, str)
    or os.path.dirname(staging) != "/tmp"
    or not os.path.basename(staging).startswith(".signalbox-boxd-proof-")
    or os.path.realpath(staging) != staging
):
    raise RuntimeError("hydration staging path is outside the owned /tmp namespace")
staged = os.lstat(staging)
if not stat.S_ISREG(staged.st_mode) or staged.st_nlink != 1:
    raise RuntimeError("hydration staging path must be one regular file")
with os.scandir(root) as entries:
    if next(entries, None) is not None:
        raise RuntimeError("proof workspace must remain empty before hydration")
` +
  BOXD_PROOF_WORKSPACE_INSTALL +
  String.raw`
install_workspace_file(staging, root + "/out.bin", metadata)
`;

// Uploads in /tmp can be on a different filesystem from /opt and /run.
export const BOXD_PROOF_SOURCE_INSTALL =
  install +
  String.raw`
staging, artifact, owner = sys.argv[1:]
install(staging, artifact, 0o644)
with open(os.path.join(os.path.dirname(artifact), "base-marker"), "w") as marker:
    marker.write(owner)
`;

export const BOXD_PROOF_BOOTSTRAP_INSTALL =
  install +
  String.raw`
staged_config, config, staged_receipt, receipt = sys.argv[1:]
os.makedirs(os.path.dirname(config), mode=0o755, exist_ok=True)
os.chmod(staged_config, 0o600)
install(staged_config, config, 0o600)
install(staged_receipt, receipt, 0o644)
`;
