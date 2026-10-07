# Product usage data

The Signalbox server sends product usage events to two PostHog projects: the one run by
[T3 Code](https://github.com/pingdotgg/t3code), which Signalbox is built on, and Signalbox's own. Both receive the
same events, associated with a hashed account or installation identifier. Events include the
provider, model, reasoning effort, permission mode, turn result, duration, and main-agent token
totals when available, plus which Signalbox features are used, such as sending feedback or running
a scheduled task.

Events do not include prompts, responses, feedback text, file contents, authentication tokens,
conversation IDs, raw provider events, or child-agent output. Child-agent token use is excluded from
the totals.

To stop collection, turn off **Settings → General → Privacy → Share usage analytics**. This stops
events to both projects, including any not yet sent. The setting belongs to each environment, so it
applies to the environments selected in Settings.

On a server you run yourself, you can also set `T3CODE_TELEMETRY_ENABLED=false` in its environment
before starting it. The desktop app reads the variable from your shell profile (for example
`~/.zshrc`) on macOS and Linux, so export it there and restart the app. On Windows, set it as a
user environment variable.
