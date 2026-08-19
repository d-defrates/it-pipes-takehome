

# Design Review

## Proposed Design

See `DesignDrawing.png`. The shape of the proposal is kept — API Gateway + Lambda for job submission, DynamoDB for job metadata, SQS feeding ECS Fargate workers, results in S3 — with three changes: the single queue and fleet are split into an import path and an export path, workers are sized to fit one conversion's ~2 GB footprint, and webhook delivery moves behind its own queue.

Callers `POST /jobs` with an S3 `inputKey`, a job type, an idempotency key, and an optional `callbackUrl`. The Job Lambda writes the job as `queued` to DynamoDB and enqueues to the **Import Q** or **Export Q**. Workers lease the job (conditional transition to `running`), read input from S3, run the TypeScript import library or the vendor JVM export subprocess, write `jobs/{jobId}/result.json` or `.zip` to S3, then conditionally mark the job `succeeded` or `failed`. On a terminal state, the worker enqueues to the **Webhook Q**, and the Webhook Lambda delivers the callback with retries; polling `GET /jobs/{jobId}` is always available as the fallback.

### Worker sizing

A conversion is single-threaded and needs ~2 GB, so memory — not CPU — sets concurrency per task.

| | Import worker | Export worker |
|---|---|---|
| Task size | 2 vCPU / 6 GB | 1 vCPU / 4 GB |
| Concurrent messages | 2 | 1 |
| Ephemeral storage | default (20 GB) | 200 GB |
| Visibility timeout | 15 min | 2 hr |

Import tasks get 6 GB so two 2 GB conversions leave ~2 GB of headroom for the Node runtime and up to 500 MB of JSON buffering. Export tasks run one conversion at a time and need large ephemeral storage to stage media and assemble a 10–40 GB zip. Both fleets scale from zero on queue depth, independently.

For the onboarding evening (3,000 jobs, 80/20): 2,400 imports × ~2 min ≈ 4,800 job-minutes, cleared in about an hour at 80 concurrent conversions, so ~40 import tasks. 600 exports × ~30 min ≈ 18,000 job-minutes, cleared in about four hours at ~75 concurrent conversions, so ~75 export tasks. Those become the max-task ceilings on each service.

## Risk Ranking

The top risks I would address first, in order:

1. **Memory overcommit → OOM (exit 137).** The proposal runs up to 10 concurrent conversions per 4 GB Fargate task, but each conversion needs ~2 GB. That caps real concurrency at about two jobs per task, not ten. Under load, workers exceed available memory, the JVM or import library is killed (exit 137), and the job fails or retries. **Customer impact:** failed or flaky conversions during onboarding bursts, longer time-to-result, and wasted compute on retries that often succeed only after a later attempt.

2. **One shared queue and worker fleet for import and export.** Imports are seconds to a few minutes and produce up to ~500 MB of JSON; exports are tens of minutes and produce 10–40 GB zips. Putting both on the same queue means a burst of exports (or the 20% export share during a 3,000-job evening) can starve imports and you cannot scale or size each path independently. **Customer impact:** import jobs sit queued behind long exports, so teams waiting on JSON conversion see unpredictable delays even when import capacity would otherwise be sufficient.

3. **Webhook delivery without a durable queue.** Completion webhooks are retried with backoff in the proposal, but if delivery is driven only by a Lambda invoked synchronously from the worker (or without a persisted outbox), a failed callback can be lost when the worker moves on or the task dies. **Customer impact:** callers who rely on `callbackUrl` miss completion notifications and must fall back to polling; integrations that are not built to poll appear stuck or broken even when the conversion succeeded.

### Things I would leave alone

1. **Callers passing S3 references instead of bytes through the API.** I'm assuming callers get files into S3 via pre-signed URL or cross-account IAM; either way, our servers should not be the middle man for 2 GB inputs or 40 GB packages. **I would revisit if** callers tell us the upload step is the main source of their integration failures, or if we need server-side validation of the file before a job is accepted — at that point a thin upload-broker endpoint that still hands off to S3 would be worth the cost.

2. **Scaling the worker fleets to zero.** Idle capacity is the thing we least want to pay for at 1,000 jobs/day, and cold-start cost on a job measured in minutes is noise. **I would revisit if** p95 queued-to-running latency during a burst exceeds our target, or if scale-out from zero repeatedly fails to keep up with a 3,000-job evening. The fix then is a scheduled or manually triggered pre-warm ahead of known onboarding, not abandoning scale-to-zero — I am deliberately not building that for v1.

3. **API Gateway and Lambda for the job API.** Volume is low and spiky, and the cost section puts Lambda plus HTTP API at roughly $3/month against ~$330 for compute, so an always-on service cannot pay for itself here. **I would revisit if** polling volume pushes API requests toward the millions per month, or if we need long-lived connections or tighter tail latency than Lambda gives us.

## Smallest Changes

The minimum set I would ship before calling this v1:

1. **Right-size the workers.** Cap concurrency to what memory allows (2 conversions per import task, 1 per export task, per the sizing table) and raise export ephemeral storage to 200 GB so a 40 GB package has room to assemble. This is the fix for exit 137 and for exports that would otherwise fail on disk.
2. **Split the queue and the worker fleets** into an import path and an export path. They are fundamentally different workloads — minutes versus tens of minutes — so they need separate scaling policies, visibility timeouts, and task sizes. Especially given the 80/20 mix.
3. **Make webhook delivery durable.** Workers enqueue to a Webhook Q after the terminal state is committed; a Webhook Lambda delivers with backoff and its own DLQ. A failed callback must never affect job state.
4. **Lease the job before running it.** A conditional DynamoDB transition to `running` so that two SQS deliveries under 100 ms apart cannot both start a conversion, plus a guard so a late-finishing attempt cannot overwrite a result another attempt already published.
5. **Fix the timeouts and subprocess handling.** Timeouts must be per job type — 30 seconds fails nearly every export — and a timed-out conversion must be killed and reaped rather than left running.
6. **Classify errors as permanent or transient.** Exit 2 with a missing table will never succeed on retry and should fail immediately; exit 137 and timeouts should retry, then land in the DLQ.

Items 1–3 are infrastructure and 4–6 are in the worker itself; the code changes for 4 and 5 are the ones I made in Part 2. Reaching S3 through a gateway VPC endpoint rather than a NAT Gateway also belongs here — see the cost section for why.


## Job Lifecycle

See `DesignDrawing.png` for the full flow. Below is one import and one export end to end, including who owns each state transition, where retries apply, how results are published, and how callers learn the outcome.

### Shared concepts

**State ownership.** The Job API Lambda owns creation: it writes a new record with `status: queued`. ECS workers own everything after that: a conditional transition to `running` (lease/acquire so duplicate SQS deliveries do not run two conversions), then `succeeded` or `failed`. The Webhook Lambda does not change job state; it only delivers notifications. DynamoDB is the source of truth for status; S3 is the source of truth for bytes.

**Idempotency.** Callers send an idempotency key on `POST /jobs`. If the same key is submitted again, the API returns the existing `jobId` and does not enqueue a second message.

**S3 references.** File bytes never pass through the API. Callers upload inputs to S3 (e.g. via pre-signed URL or cross-account IAM) and pass an `inputKey`. Workers read input and write output under `jobs/{jobId}/result` (`.json` for import, `.zip` for export). Callers fetch results from S3 using the `outputKey` returned in the job record or webhook payload.

**How the caller learns the outcome.** Either poll `GET /jobs/{jobId}` until `succeeded` or `failed`, or optionally register a `callbackUrl` and receive a completion webhook after the job reaches a terminal state. Webhooks are at-least-once; polling remains the fallback.

**Retry boundaries.** Conversion retries are bounded by SQS redelivery and worker logic (e.g. DLQ after N attempts). Transient failures—OOM (exit 137), network blips, timeouts—should retry. Permanent failures—invalid database (exit 2, e.g. "required table missing")—should transition to `failed` immediately without further conversion retries. Webhook delivery retries are separate: a failed callback does not revert a succeeded job.

### Import (Access database → JSON)

1. **Submit.** Caller uploads a database file (10 MB–2 GB) to S3 and calls `POST /jobs` with `type: import`, `inputKey`, optional `callbackUrl`, and an idempotency key. API Gateway invokes the Job Lambda.
2. **Queue.** Job Lambda writes `queued` to DynamoDB, enqueues `{ jobId }` to the **Import Q**, and returns `202` with `jobId`. No conversion runs in Lambda.
3. **Acquire.** An import worker (right-sized: 2 concurrent conversions per 6 GB task, not 10) pulls the message, conditionally moves the job to `running`, and increments `attempt`.
4. **Convert.** Worker reads the database from S3 and runs the TypeScript import library (seconds to several minutes). Output is written to S3 as `jobs/{jobId}/result.json` (up to ~500 MB).
5. **Complete.** After S3 write succeeds, worker conditionally sets `status: succeeded` and `outputKey`. If another attempt already published a terminal result, the late writer must not overwrite it. On timeout or transient error, worker kills the subprocess, does not ack the message (or calls `retry()`), and SQS redelivers. On permanent validation error, worker sets `failed` with the error message and acks.
6. **Notify.** If `callbackUrl` was provided, worker enqueues a message to the **Webhook Q** (only after terminal state is committed). Webhook Lambda POSTs job id, status, `outputKey`, and error; failures retry with backoff via the queue. Caller may also poll `GET /jobs/{jobId}` and then read JSON from S3.

### Export (JSON + media map → zip package)

1. **Submit.** Caller places JSON and media references in S3 and calls `POST /jobs` with `type: export`, `inputKey` (and any media-map key the API contract defines), optional `callbackUrl`, and idempotency key.
2. **Queue.** Job Lambda writes `queued` to DynamoDB and enqueues to the **Export Q** (separate from import so long exports do not starve imports).
3. **Acquire.** Export worker (one conversion per task, 200 GB ephemeral storage, longer visibility timeout) leases the job and sets `running`.
4. **Convert.** Worker reads JSON and media from S3 and invokes the vendor JVM subprocess (tens of minutes; package may be 10–40 GB). Timeout must be job-type-aware (not 30s). On timeout or failure, the worker must kill and reap the subprocess so it does not keep running in the background.
5. **Complete.** Worker writes the zip to S3 (`jobs/{jobId}/result.zip` or equivalent), then conditionally marks `succeeded` with `outputKey`. Same late-writer and permanent-vs-transient retry rules as import apply; exit 137 may succeed on a later attempt if memory was overcommitted on the first try.
6. **Notify.** Worker enqueues Webhook Q on terminal state. Caller receives webhook or polls, then downloads the zip from S3 via `outputKey`.

Job metadata is retained for 90 days in DynamoDB as required, but result objects are not: a lifecycle rule expires `jobs/{jobId}/result` after 7 days. That rule is part of v1, not a later optimization — the cost section shows it is the difference between roughly $650 and $8,300 a month. Archiving to Glacier is the wrong tool for objects this short-lived, since its minimum storage duration would cost more than expiring them. Once a result expires the metadata still resolves, so the API can answer `410 Gone` and offer a re-run instead of a dead link.

## Cost at Normal Volume

Normal volume is 1,000 jobs/day: 800 imports and 200 exports. Fleet sizing for the onboarding burst is above; this is the steady-state monthly bill.

**Fargate.** Both fleets scale from zero, so we pay for job time plus startup overhead.

- Imports: 800 × 2 min = 1,600 job-min/day. At 2 conversions per task that is 800 task-min/day ≈ 400 task-hr/month. A 2 vCPU / 6 GB task costs (2 × $0.04048) + (6 × $0.004445) ≈ **$0.108/hr** → **~$43/month**.
- Exports: 200 × 30 min = 6,000 job-min/day. At 1 conversion per task that is 100 task-hr/day ≈ 3,000 task-hr/month. A 1 vCPU / 4 GB task with 200 GB ephemeral storage costs $0.0405 + $0.0178 + (180 GB × $0.000111) ≈ **$0.078/hr** → **~$235/month**.
- Add ~20% for task startup, image pull, and drain: **~$330/month**.

**S3.** Exports dominate. 200 packages/day × ~20 GB ≈ 4 TB/day ≈ 120 TB/month of new objects. Imports add 800 × ~100 MB ≈ 80 GB/day ≈ 2.4 TB/month. With a 7-day expiry on result objects, steady-state stored data is roughly 28 TB → **~$650/month** at $0.023/GB. Requests (multipart PUTs for large zips, plus GETs) are **under $10/month**.

**Everything else is rounding error.** DynamoDB on-demand at ~120k writes and a few million reads/month is **under $1**. SQS stays inside the 1M-request free tier. Lambda and HTTP API Gateway together are **~$3**. CloudWatch logs and metrics, **~$20**.

**Total: roughly $1,000/month**, dominated by S3.

**Biggest line item:** S3 storage of export packages (~$650/month, and it grows linearly with retention). **The single change that cuts it most** is a short lifecycle expiry on `jobs/{jobId}/result` — 7 days instead of matching the 90-day metadata retention. At 90 days the same traffic stores ~360 TB and costs **~$8,300/month**, roughly 13× the bill, for packages callers have almost certainly already downloaded. Job metadata still lives 90 days in DynamoDB, so the API can return `410 Gone` with a re-run option rather than a dead link.

One infrastructure note that matters more than any of the above: workers must reach S3 through a **gateway VPC endpoint**, not a NAT Gateway. Pushing 120 TB/month through NAT at $0.045/GB would add **~$5,400/month** and quietly become the largest line item. Same reasoning for egress — the estimate assumes callers are ITpipes backend services in the same region, so transfer is free; if customers download packages over the public internet, 120 TB at $0.09/GB is **~$10,800/month** and dwarfs everything else.

### Assumptions

- Prices are us-east-1 on-demand, Linux/x86 Fargate, S3 Standard, no Savings Plans or Compute Savings commitments.
- Average import takes ~2 min and produces ~100 MB of JSON; average export takes ~30 min and produces ~20 GB (midpoint of the stated 10–40 GB).
- Job volume is spread across the day; scale-from-zero means idle capacity is not billed between bursts.
- Result objects expire after 7 days. Job metadata is retained 90 days in DynamoDB as required.
- Callers are in-region AWS services, so data transfer out is free; source media for exports is already in S3 and is not re-uploaded.
- No load balancer in front of the workers (queue-driven, no inbound traffic) and no NAT data processing for S3 traffic.
- Excludes cross-account or customer-facing egress, multi-region replication, and non-production environments.