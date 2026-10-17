# Notifications and push

`PushNotifier` accepts thread transitions and automation notices. It owns whether
an update earns a push, device preferences, session checks and delivery cleanup.
The first thread summary is a silent baseline. Delivery failures stay in logs and
never fail the thread update or automation run.

`layerWithDevices` takes the environment identity and a live-session check from
composition. The check must use the registering person's session store; a failed
check skips delivery without deleting the registration.

`PushDevices` and `pushRpc` are the registration entry points. Registration stays
bound to the authenticated account session. `pushRules` defines qualification and
message grouping. Native payloads, credential decoding, JWT signing and HTTP
requests are private under `adapters/`.

Tests use these root entry points with local SQLite and HTTP stand-ins. The cloud
sends mobile pushes. Web and desktop consume shell updates for local notification
presentation.
