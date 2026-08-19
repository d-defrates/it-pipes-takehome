# ITpipes Platform Homework

Design review is in `DESIGN.md`; assumptions, remaining risks, and AI usage are in `NOTES.md`.

## Running the tests

Requires Node 20+ (developed on Node 26). No AWS credentials, Docker, or JVM are needed —
the job store, queue, converter, and clock are in-memory fakes.

```bash
npm install
npm test
```

Other commands:

```bash
npm run test:watch   # vitest in watch mode
npm run typecheck    # tsc --noEmit
```

## Layout

| File | Purpose |
|---|---|
| `src/worker.ts` | The per-message handler under review. |
| `src/fakes.ts` | In-memory `JobStore`, `QueueMessage`, `Converter`, and `Clock`. |
| `src/worker.test.ts` | Focused tests for the risks addressed in `DESIGN.md`. |

## Test seams

`handle()` only touches four interfaces, so every production observation can be reproduced
in a single Node process:

- **`InMemoryJobStore`** — a `Map` in place of DynamoDB, which also records every write so a
  test can see a stale attempt overwrite a terminal state.
- **`FakeMessage`** — counts `ack()` and `retry()` instead of talking to SQS, and takes a
  `receiveCount` so the redelivery limit is reachable without three real deliveries.
- **`FakeConverter`** — hands back a conversion whose `completion` the test resolves or rejects
  on demand, and records whether `kill()` was called. Stands in for both the TypeScript import
  library and the vendor JVM subprocess.
- **`FakeClock`** — the timeout is fired by the test, so exercising a 30 s budget (or a 2 h one)
  costs no wall-clock time.

Duplicate delivery is reproduced by calling `handle()` twice concurrently against the same
store, which is the in-process equivalent of two SQS deliveries reaching two workers under
100 ms apart.

## Current test status

Against the unmodified starter worker, three of the four tests fail on purpose — they are the
regression tests for the risks being repaired:

- the timed-out conversion is never killed or reaped,
- two concurrent deliveries both start a conversion,
- a late attempt overwrites a result another attempt already published.
