import { MACHINE_HOME } from "@signalbox/runner-protocol/RunnerProtocol";

export const SETUP_REVISION = "boat-runner-2";

/** On the VM's disk, mounted into the Runner's container at the same path. */
export const CONFIG_PATH = `${MACHINE_HOME}/machine.json`;

export const RUNNER_SCRIPT = `#!/bin/bash
# Launcher ${SETUP_REVISION}: refresh mutable image tags for native answers.
set -euo pipefail
config=${CONFIG_PATH}
until [ -s "$config" ]; do sleep 1; done
# Boat exposes a lazy FUSE mount at ready, then replaces it after hydration.
# A private Docker bind would retain that mount after its daemon goes away.
while :; do
  case "$(stat -f -c %T "$config" 2>/dev/null || true)" in
    ""|fuse*) sleep 1 ;;
    *) break ;;
  esac
done
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
  "$image" machine --config "$config"`;

/**
 * Installs the Runner as an enabled systemd unit, which boat starts again on
 * every resume. The unit waits for the config, then runs the image it names;
 * the Runner exits when the config names another image, and the unit restarts
 * it on that one.
 */
export const SETUP_SCRIPT = `#!/bin/bash
set -euo pipefail
exec 9>/tmp/signalbox-runner-setup.lock
flock 9
sudo install -d -m 0755 -o user -g user ${MACHINE_HOME}
sudo tee /usr/local/bin/signalbox-runner.next >/dev/null <<'SCRIPT'
${RUNNER_SCRIPT}
SCRIPT
if ! sudo cmp -s /usr/local/bin/signalbox-runner.next /usr/local/bin/signalbox-runner; then
  sudo touch /run/signalbox-runner-restart
  sudo chmod 0755 /usr/local/bin/signalbox-runner.next
  sudo mv /usr/local/bin/signalbox-runner.next /usr/local/bin/signalbox-runner
else
  sudo rm /usr/local/bin/signalbox-runner.next
fi
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
sudo systemctl enable signalbox-runner.service
if [ -e /run/signalbox-runner-restart ]; then
  sudo systemctl restart signalbox-runner.service
  sudo rm /run/signalbox-runner-restart
else
  sudo systemctl start signalbox-runner.service
fi
`;

export const SETUP_COMMAND = `bash -c '${SETUP_SCRIPT.replaceAll("'", "'\\''")}'`;
