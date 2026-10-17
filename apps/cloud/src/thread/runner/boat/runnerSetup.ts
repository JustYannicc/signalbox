import { MACHINE_HOME } from "@signalbox/runner-protocol/RunnerProtocol";

export const CONFIG_PATH = `${MACHINE_HOME}/machine.json`;

/**
 * Installs the Runner as an enabled systemd unit, which boat starts again on
 * every resume. The unit waits for the config, then runs the image it names;
 * the Runner exits when the config names another image, and the unit restarts
 * it on that one.
 */
export const BOAT_RUNNER_SETUP = `#!/bin/bash
set -euo pipefail
sudo install -d -m 0755 -o user -g user ${MACHINE_HOME}
sudo tee /usr/local/bin/signalbox-runner >/dev/null <<'SCRIPT'
#!/bin/bash
set -euo pipefail
config=${CONFIG_PATH}
until [ -s "$config" ]; do sleep 1; done
image=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["image"])' "$config")
docker pull --quiet "$image" || true
digest=$(docker image inspect --format '{{index .RepoDigests 0}}' "$image" 2>/dev/null || true)
docker rm --force signalbox-runner >/dev/null 2>&1 || true
# FUSE, for the read-only /drives mount; without it the Runner runs, unmounted.
fuse=()
if [ -e /dev/fuse ]; then fuse=(--device /dev/fuse --cap-add SYS_ADMIN --security-opt apparmor=unconfined); fi
exec docker run --name signalbox-runner --network host --init "\${fuse[@]}" \\
  --volume ${MACHINE_HOME}:${MACHINE_HOME} \\
  --env SIGNALBOX_RUNNER_IMAGE="$image" \\
  --env SIGNALBOX_RUNNER_IMAGE_DIGEST="$digest" \\
  "$image" machine --config "$config"
SCRIPT
sudo chmod 0755 /usr/local/bin/signalbox-runner
sudo tee /etc/systemd/system/signalbox-runner.service >/dev/null <<'UNIT'
[Unit]
Description=Signalbox Runner
StartLimitIntervalSec=0
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/signalbox-runner
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now signalbox-runner.service
`;
