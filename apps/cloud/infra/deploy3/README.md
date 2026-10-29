# Deploy #3 teardown

These tools protect the temporary #1070 qualifier deployment when its operator or a consumer stops responding. The workload's minute Cron deletes its own Worker at the receipt's deployment time plus 24 hours. An hourly GitHub Actions job independently checks resources, verifies credential expiry and posts the short teardown receipt on issue #1070. Neither deadline path exports payloads or waits for an owner's release.

The durable control record is a non-sensitive issue comment. It keeps the exact Worker ID, namespace and Tail IDs, deployment UTC, deadline, cleanup token ID/expiry and participating owners after the Worker deletes itself. Independent append-only release records avoid losing concurrent owner updates. Only the configured GitHub writer IDs count. A future configured expiry is reported as `expiry-configured`; only a matching authoritative expired token record permits `expired-verified`. API denial never proves expiry.

The single-Worker token cannot be assumed to list every account resource. The primary therefore uses Worker-scoped deletion calls. The CI token verifies account-wide namespace absence afterward. The primary has no durable GitHub secret. Its public control read can fail without preventing deletion at the deadline bound into its environment; the next hourly job publishes the receipt after self-deletion. Final receipts contain only the approved teardown fields and `evidence not exported`.

The provisioning, arming, normal export/release and written extension procedure is in [Operate the Deploy #3 qualifier](../../../../../docs/operations/deploy3.md).

The large cleanup function remains cohesive because identity checks, shared-resource preservation, deletion and absence checks use one preflight inventory and one result ledger. The smaller scoped primary deliberately has a narrower responsibility.

Offline Node tests exercise the actual scheduled helper, held owners, concurrent releases, local export corruption, written extensions, deletion order, post-self-delete recovery and expiry status. They establish no live credential access, deployment, provider qualification or native-run permission. Full manifest reviews and operating preflight are still required.
