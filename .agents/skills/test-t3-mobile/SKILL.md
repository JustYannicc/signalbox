---
name: test-t3-mobile
description: Test T3 Code's native iOS and Android app through its Device panel and returned AgentDevice command. Use for mobile verification, native-client builds, Metro launch, mobile pairing against isolated development state, and walk teardown.
---

# Test T3 Mobile

## Open the device

Call `device_list` and record the selected host, device ID and initial boot state.
Then call `device_open` with those IDs. Retain `device.id` from its result for
later commands and teardown. On Android this is an emulator serial such as
`emulator-5554`, replacing the AVD name shown before boot.
T3 boots the device and shows its live stream in the Device panel. Follow its
returned `quickStart`, using the exact `agentDevice.command` and all `targetArgs`
on every operation. Use `device_screenshot` to inspect the screen.

If T3 device tools or the selected device are unavailable, report the blocker
and stop verification. Do not install or switch to another automation system.

## Use an isolated backend

Reuse this task's healthy backend. Otherwise run `vp run dev` from the
repository root, capture its terminal session and process IDs at launch, and
read the actual backend port from the dev-runner output. Track child processes
as well as the launcher so teardown cannot leave a listener running.
Use the worktree's ignored `.t3` state. Never run
against `~/.t3/userdata`. The Browser panel is not required for this workflow.

Test with meaningful project and thread data. Read the shared
[SQLite fixture reference](../test-t3-app/references/sqlite-fixtures.md) only
when inspecting or seeding SQLite. Stop the test server before fixture writes.

## Launch T3 Code Dev

From the checkout being tested on the selected device host, run:

```bash
node scripts/mobile-native-client.ts ensure <ios|android> <device-id>
```

This reuses a matching native client or builds and installs one. Authorized
mobile verification includes that build step unless the user prohibits it.

Start `vp run dev:client` from `apps/mobile`, or reuse a healthy Metro belonging
to this checkout. Record the PIDs of backend and Metro processes you start.
Track Metro's children as well as its launcher. Open its printed development-client URL with AgentDevice
`open com.t3tools.t3code.dev <url>` and all returned target arguments.
The device must be able to reach both Metro and the isolated backend.
Append `&disableAutoLaunch=1&disableFab=1` to the development-client URL query
when developer chrome would obscure screenshots or taps; the SDK 58 dev client
applies these preferences before the app loads.

## Pair and verify

Use the helper from the repository root, with the returned executable and target
arguments stored in `agent_device_command` and the Bash array
`agent_device_target_args`:

```bash
.agents/skills/test-t3-mobile/scripts/pair-client.sh \
  <server-port> <base-dir> <device-reachable-backend-origin> \
  "$agent_device_command" "${agent_device_target_args[@]}"
```

It issues a fresh credential and opens T3 Code Dev's existing pairing route
through AgentDevice. For a backend on the device host, use
`http://127.0.0.1:<server-port>` on iOS or `http://10.0.2.2:<server-port>`
on Android. For a remote backend, use its reachable origin.

Confirm the intended projects appear, exercise the affected flow, and capture
evidence. Retain the app and environment while iterating.

## Clean up

On completion or failure, remove the disposable connection and close the
AgentDevice session with its returned target arguments. Call `device_close`
with the tracked host and `device.id` returned by `device_open`, not the
pre-boot AVD name. A wrong ID can silently leave the device open. Set
`shutdown=true` if this walk booted the device; preserve any device that was
already booted when the walk started.

If a named receiver accepts ownership, hand over the host and current device
ID and responsibility for shutdown, then close your panel without shutdown.
Record that handoff. Without an accepted handoff, shut down what you booted.
If `device_open` failed before returning an ID, call `device_list` and report
any device the walk left booted; establish its identity before shutting it down.

Stop backend and Metro through their captured terminal sessions or tracked
PIDs, including their owned child processes. Preserve processes you reused.
Never kill processes or shut down devices by pattern, and leave T3's shared
agent-device daemon and device hub alone.

For a shutdown, call `device_list` and confirm the original device identity
(the AVD name on Android) is no longer booted and your panel entry is gone.
Confirm your spawned processes exited and your ports have no remaining
listeners. Teardown is complete only after these checks or a recorded handoff.
