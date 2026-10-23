# Machine program inventory

Computer resolves executables using the isolate catalog and the inventory supplied
by its machine transport. That inventory must describe the exact image the transport
will run. `RUNNER_MACHINE_PROGRAM_INVENTORY` pins the captured Runner image digest;
it is not a fallback for Boxd images, local hosts, or another Runner image.

Regenerate after building or selecting an immutable image. Run the capture as the
image's normal command user, with its normal PATH, after all installation steps:

```sh
docker run --rm --network none --entrypoint node \
  --mount type=bind,src="$PWD/scripts/machine-programs",dst=/capture,readonly \
  IMAGE@sha256:DIGEST /capture/capture.mjs IMAGE@sha256:DIGEST \
  > /tmp/machine-programs.json
```

Use `--platform linux/amd64` when capturing the checked-in amd64 Runner image on
an arm64 host. Verify the image digest and capture before replacing
`apps/cloud/src/computer/machinePrograms/runner.json`. Supply the same inventory
with the forwarder in `ProductComputerOptions.machine`. A different image needs
its own capture. Lookup never acquires a machine lease or starts a VM.

The factory also supplies `image` from its selected machine configuration.
Computer rejects a mismatch between that identity and `inventory.image`.
Resolve a mutable tag to its digest before selecting both the transport and the
inventory. The bundled Runner data describes only its recorded Linux amd64 image.

The capture enumerates every executable file reachable through the image PATH,
including symlinks and their resolved targets. It records permissions and owners.
Absolute resolved link targets preserve executable lookup when the image's merged
`/usr` layout is combined with existing isolate directories. `link` records the
original spelling for provenance. Programs installed later in a machine-only
directory require a refreshed inventory; files in the Computer filesystem are
resolved directly.

Machine files are seeded with readable, explicitly identified stubs. Exec sends
the original argv through normal Computer admission. Existing isolate bytes win;
machine aliases for catalog names dispatch to those same isolate implementations.
An ownership index reconciles unchanged generated entries on the next open.
Inventory refresh removes obsolete entries and updates changed links or modes;
preexisting files and user edits survive. The index is replaced atomically before
seeding, so a later open can finish an interrupted refresh.
