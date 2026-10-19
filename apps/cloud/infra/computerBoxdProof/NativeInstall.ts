const install = String.raw`
import os, shutil, sys, tempfile

def install(source, target, mode):
    fd, temporary = tempfile.mkstemp(prefix=".signalbox-install-", dir=os.path.dirname(target))
    try:
        with os.fdopen(fd, "wb") as output:
            with open(source, "rb") as upload:
                shutil.copyfileobj(upload, output)
            os.fchmod(output.fileno(), mode)
        os.replace(temporary, target)
        os.unlink(source)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
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
