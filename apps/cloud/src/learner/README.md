# Level learners

Personal levels live in their user's SQLite store, with independent scopes for
its root and folders. `LearnerHomes` rejects company threads before any learner
read or write. Shared company learners belong to the follow-up to #668 and #454.
A per-person store must never stand in for a shared company level.

`LearnerService` owns pairing, rule validation and scoring. Jev judges supplied
evidence; SQL owns isolation and idempotency. Transports route through
`UserLearner`, which derives the level from the authenticated thread.

A higher level reads a descendant at query time and receives rule text and
statistics. Evidence stays in its original scope. Moving a thread changes the
home of new events; retries retain the original event's home.
