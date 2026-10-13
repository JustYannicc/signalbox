# Product usage data

The Signalbox server sends product usage events to two PostHog projects: the one run by
[T3 Code](https://github.com/pingdotgg/t3code), which Signalbox is built on, and Signalbox's own. Both receive the
same events, associated with a hashed account or installation identifier. Events include the
provider, model, reasoning effort, permission mode, turn result, duration, and main-agent token
totals when available, plus which Signalbox features are used, such as sending feedback or running
a scheduled task.

Signalbox's project also receives resource usage, which helps us choose where to run agents in the
cloud: how long each turn takes and how long until the next one, how many shell commands of each kind
(install, build, test and so on) an agent ran and for how long, how many file edits it made, the CPU
time and peak memory of the agent's processes, and once a week the disk size of each project you
used. Commands are sorted into those kinds on your machine; their text is never sent. Threads and
projects are identified only by a one-way hash.

In Signalbox Cloud, Signalbox's project receives the same kind of resource usage for each turn,
plus the machine it ran on: how long the machine was awake and idle, how it started, its CPU time,
memory, disk use and network bytes sent, and the model tokens each turn used. You are identified by a
one-way hash of your account.

Events do not include prompts, responses, feedback text, file contents, command text, file or
folder paths, authentication tokens, conversation IDs, raw provider events, or child-agent output.
Child-agent token use is excluded from the totals.

To stop collection, turn off **Settings → General → Privacy → Share usage analytics**. This stops
events to both projects, including any not yet sent. The setting belongs to each environment, so it
applies to the environments selected in Settings. Signalbox Cloud doesn't have this switch yet.

On a server you run yourself, you can also set `T3CODE_TELEMETRY_ENABLED=false` in its environment
before starting it. The desktop app reads the variable from your shell profile (for example
`~/.zshrc`) on macOS and Linux, so export it there and restart the app. On Windows, set it as a
user environment variable.

## Export diagnostics to your own receiver

To send traces, metrics, or logs to an OpenTelemetry receiver, open
**Settings > General > Diagnostics**, select an environment, and enter each signal's OTLP HTTP
endpoint under **OpenTelemetry export** (for example `http://localhost:4318/v1/traces`). Save, then
restart that environment's server. The receiver must be reachable from the server's machine.
**Test** sends an empty export from the server to check an endpoint before or after you save it;
saved endpoints are checked when the section opens. Checks send authentication headers only to
the signal's currently running endpoint and do not follow redirects. To check a new endpoint
that requires authentication, save it and restart the server first.

`T3CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` environment variables override the saved
settings. For endpoints saved here or set with `T3CODE_OTLP_*_URL`, set `T3CODE_OTLP_HEADERS` for
receivers that need authentication and `T3CODE_OTLP_PROTOCOL=http/protobuf` for receivers that do
not accept JSON. An endpoint set with `OTEL_EXPORTER_OTLP_*` takes its headers and protocol from
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_PROTOCOL` instead.
