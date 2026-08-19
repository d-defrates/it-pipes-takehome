
# Coding Concerns

Ranked by urgency. I fixed the first four; each has a test in `src/worker.test.ts` that fails against the starter worker.

## Fixed

1. **No lease before starting work.** Protect against concurrent duplicates: the terminal-state check was a read-then-write with no condition, so two deliveries 100 ms apart both read `queued` and both started a conversion. Two 2 GB conversions for one job double the memory pressure that produces exit 137, and they race each other's bytes at the same output key. `JobStore.put` now takes an `expectedAttempt` and returns false when another attempt has moved on, so only one delivery acquires the job.
2. **Terminal writes spread a stale snapshot.** A slow attempt may finish after another attempt has created a result. Prioritizing this fix because it can produce an inconsistent state if we are overwriting a file and the user thinks it is already finished and the API tries to download it. Same conditional write as above: a late attempt's write is refused rather than flipping a `failed` job back to `succeeded`.
3. **A timed-out conversion was never killed.** Actually need to kill the process if it times out — `Promise.race` only settles the race, so the loser kept running and holding ~2 GB while a retry started a second conversion. The worker now kills and reaps before it acks or retries, so the orphan is gone before the message becomes visible again. A kill that fails is swallowed rather than replacing the conversion error the caller cares about.
4. **One hardcoded 30 s timeout.** 30s doesn't make sense for jobs that can take 10 minutes or more; it fails essentially every export, and before fix 3 each of those failures leaked an orphan. Budgets are now per job type (10 min import, 90 min export), chosen to expire before the queue's visibility timeout so the worker kills its own conversion instead of racing a redelivery.

Fix 4 needed the job type, so I added `type: "import" | "export"` to `Job` — the interface change my design already called for. It also fixes the output key, which was hardcoded to `.json` and would have named every export package `result.json`.

## Not fixed yet

5. **No permanent-vs-transient error classification.** Exit 2 "required table missing" retries on the same bad input as readily as a transient exit 137. Left alone because the final state is already correct — you just pay 3x for a database that can never convert. Wasted compute, not a wrong answer.
6. **`receiveCount` is used as the retry budget.** Duplicate deliveries are separate messages each carrying their own count, so the effective budget is higher than the intended 3. Wrong bound, right shape.
7. **Jobs that exhaust redelivery never reach a terminal state.** Below the cap the worker calls `retry()` without writing anything, so a message that lands in the DLQ leaves the job at `running` forever and a polling caller waits on a job no worker will pick up again. This is the gap the four externally visible states don't cover, and closing it needs a DLQ consumer — new infrastructure, not a worker change.
8. **No visibility-timeout heartbeat.** A 30-minute export outlives any sane visibility timeout, so SQS redelivers mid-run. This is the main *source* of the duplicate deliveries in fix 1, but it belongs to the poll loop and queue config, neither of which is in scope here.
9. **Success is claimed without verifying the output object exists.** `completion` resolving is taken as proof the result reached S3. Tightening this means reaching into a storage seam the starter doesn't model.

I am treating the starter worker as if the original design was still implemented. My new design calls for passing "import" | "export" to the job in order to determine which type of job to execute. I will ignore this for now.


# AI Usage
I created the design .png and let an LLM take first crack at the DESIGN.md document based on my design and a list of my critiques of the original proposed design. Usually I would spend more time going over its output but the 90minute time cap. Prevented me from doing so. 
I used AI heavily for implementing fixes. I identified several problems then used AI to refine my list and iterated with it to prioritize.


# My Notes
exit 137- memory overcommit, OOM: this is probably occuring because 10 concurrent jobs on 4 GB RAM, each job taking 2 GB?

Why are the worker fleets shared for import and export? They have different job profiles and we don't want export requests to affect our import processes. They need to be divided into 2 different queues. EC2 over Fargate might be a better choice for the export workload since it is so I/O heavy but I don't have time to investigate enough to defend that decision.

## Costs
1. S3 storage- eventually will want to implement lifecycle policies to move files into Glacier. Don't have to implement immediately.
2. Export takes so a long time, Fargate might not be the best choice for these tasks. This may be a heavier lift moving the export jobs to an EC2  architecture.