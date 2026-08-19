import { describe, expect, it } from "vitest";
import {
  FakeClock,
  FakeConverter,
  FakeMessage,
  InMemoryJobStore,
  flush,
  queuedJob,
} from "./fakes.js";
import { handle } from "./worker.js";

describe("handle", () => {
  it("succeeds a job and publishes the output key", async () => {
    const store = new InMemoryJobStore();
    store.seed(queuedJob());
    const message = new FakeMessage("job-1");
    const converter = new FakeConverter();
    const clock = new FakeClock();

    const done = handle(message, store, converter, clock);
    await flush();
    converter.only.succeed();
    await done;

    expect(await store.get("job-1")).toMatchObject({
      status: "succeeded",
      attempt: 1,
      outputKey: "jobs/job-1/result.json",
    });
    expect(message.acked).toBe(1);
  });

  it("kills the conversion when it times out", async () => {
    const store = new InMemoryJobStore();
    store.seed(queuedJob());
    const message = new FakeMessage("job-1");
    const converter = new FakeConverter();
    const clock = new FakeClock();

    const done = handle(message, store, converter, clock);
    await flush();
    clock.fire();
    await done;

    // A timed-out subprocess keeps running unless its owner reaps it.
    expect(converter.only.killed).toBe(1);
    expect(message.retried).toBe(1);
    expect((await store.get("job-1"))?.status).not.toBe("succeeded");
  });

  it("budgets the timeout and names the output by job type", async () => {
    const store = new InMemoryJobStore();
    store.seed(queuedJob({ id: "imp", type: "import" }));
    store.seed(queuedJob({ id: "exp", type: "export" }));
    const converter = new FakeConverter();
    const clock = new FakeClock();

    const importRun = handle(new FakeMessage("imp"), store, converter, clock);
    await flush();
    converter.started[0]?.succeed();
    await importRun;

    const exportRun = handle(new FakeMessage("exp"), store, converter, clock);
    await flush();
    converter.started[1]?.succeed();
    await exportRun;

    // 30 s would fail every export and most large imports.
    expect(clock.requested).toEqual([10 * 60_000, 90 * 60_000]);
    expect(converter.started[1]?.outputKey).toBe("jobs/exp/result.zip");
  });

  it("runs one conversion when the same job is delivered twice at once", async () => {
    const store = new InMemoryJobStore();
    store.seed(queuedJob());
    const converter = new FakeConverter();
    const clock = new FakeClock();
    const first = new FakeMessage("job-1");
    const second = new FakeMessage("job-1");

    const runs = Promise.all([
      handle(first, store, converter, clock),
      handle(second, store, converter, clock),
    ]);
    await flush();

    expect(converter.started).toHaveLength(1);

    converter.started[0]?.succeed();
    clock.fire();
    await runs;

    expect((await store.get("job-1"))?.attempt).toBe(1);
  });

  it("does not let a late attempt overwrite a terminal result", async () => {
    const store = new InMemoryJobStore();
    store.seed(queuedJob());
    const converter = new FakeConverter();
    const clock = new FakeClock();
    const slow = new FakeMessage("job-1", 1);
    const fatal = new FakeMessage("job-1", 3);

    // The first attempt is still converting when its message is redelivered,
    // so a second attempt legitimately takes over the still-`running` job.
    const slowRun = handle(slow, store, converter, clock);
    await flush();
    const fatalRun = handle(fatal, store, converter, clock);
    await flush();

    converter.started[1]?.fail(new Error("exit 2: required table missing"));
    await fatalRun;
    expect((await store.get("job-1"))?.status).toBe("failed");

    // The first attempt finishes afterwards and must not resurrect the job.
    converter.started[0]?.succeed();
    await slowRun;

    expect((await store.get("job-1"))?.status).toBe("failed");
  });
});
