# Machine file inventory

Run these commands from the repository root. Use the same immutable image reference that the deployment will use.

```sh
signalbox_runner_image='ghcr.io/justyannicc/signalbox-runner@sha256:<digest>'
signalbox_runner_image_id='sha256:<image-id>'
signalbox_runner_revision='<40-character-source-revision>'
signalbox_runner_platform='linux/amd64'
signalbox_runner_snapshot='/tmp/signalbox-machine-files-snapshot.json'
signalbox_runner_repository='ghcr.io/justyannicc/signalbox-runner'

docker pull --quiet --platform "$signalbox_runner_platform" "$signalbox_runner_image"
test "$(docker image inspect "$signalbox_runner_image" --format '{{.Id}}')" = "$signalbox_runner_image_id"
test "$(docker image inspect "$signalbox_runner_image" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')" = "$signalbox_runner_revision"

docker run --rm --read-only --platform "$signalbox_runner_platform" --network none --user 0:0 \
  --entrypoint node \
  --mount "type=bind,src=$PWD/apps/cloud/infra/kernelPrograms/machine-files/capture.mjs,dst=/tmp/capture.mjs,readonly" \
  --env SIGNALBOX_RUNNER_IMAGE_ID="$signalbox_runner_image_id" \
  --env SIGNALBOX_RUNNER_PLATFORM="$signalbox_runner_platform" \
  --env SIGNALBOX_RUNNER_REVISION="$signalbox_runner_revision" \
  "$signalbox_runner_image_id" /tmp/capture.mjs \
  > "$signalbox_runner_snapshot"

node apps/cloud/infra/kernelPrograms/machine-files/prepare.mjs \
  --snapshot "$signalbox_runner_snapshot" \
  --image-repository "$signalbox_runner_repository" \
  --image-ref "$signalbox_runner_image" \
  --source-image-id "$signalbox_runner_image_id" \
  --source-revision "$signalbox_runner_revision" \
  --platform "$signalbox_runner_platform" \
  --dockerfile apps/server/src/signalbox/runner/image/Dockerfile \
  --output apps/cloud/infra/kernelPrograms/machine-files/build/runner.json
```

The commands stop if the published digest, captured image ID, source revision, or capture script hash do not match. Keep `build/runner.json` with the image build artifact. Do not commit it.
