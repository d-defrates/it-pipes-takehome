import type {
  Clock,
  Converter,
  Job,
  JobStore,
  QueueMessage,
  RunningConversion,
} from "./worker.js";

export class InMemoryJobStore implements JobStore {
  private jobs = new Map<string, Job>();
  readonly writes: Job[] = [];

  async get(id: string): Promise<Job | undefined> {
    const job = this.jobs.get(id);
    return job ? { ...job } : undefined;
  }

  async put(job: Job): Promise<void> {
    this.jobs.set(job.id, { ...job });
    this.writes.push({ ...job });
  }

  seed(job: Job): void {
    this.jobs.set(job.id, { ...job });
  }
}

export class FakeMessage implements QueueMessage {
  acked = 0;
  retried = 0;

  constructor(
    readonly jobId: string,
    readonly receiveCount = 1,
  ) {}

  async ack(): Promise<void> {
    this.acked += 1;
  }

  async retry(): Promise<void> {
    this.retried += 1;
  }
}

/** One conversion the test drives by hand: it finishes only when told to. */
export class FakeConversion implements RunningConversion {
  killed = 0;
  settled = false;
  readonly completion: Promise<void>;
  private resolve!: () => void;
  private reject!: (reason: unknown) => void;

  constructor(
    readonly inputKey: string,
    readonly outputKey: string,
  ) {
    this.completion = new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    // The worker may abandon this promise on timeout; an unobserved rejection
    // must not crash the test process.
    this.completion.catch(() => {});
  }

  succeed(): void {
    this.settled = true;
    this.resolve();
  }

  fail(reason: unknown): void {
    this.settled = true;
    this.reject(reason);
  }

  async kill(): Promise<void> {
    this.killed += 1;
  }
}

export class FakeConverter implements Converter {
  readonly started: FakeConversion[] = [];

  start(inputKey: string, outputKey: string): RunningConversion {
    const conversion = new FakeConversion(inputKey, outputKey);
    this.started.push(conversion);
    return conversion;
  }

  get only(): FakeConversion {
    if (this.started.length !== 1) {
      throw new Error(`expected exactly 1 conversion, saw ${this.started.length}`);
    }
    return this.started[0]!;
  }
}

/**
 * Timeouts are triggered by the test, never by the wall clock, so a 30 s or a
 * 2 h budget costs the same to exercise.
 */
export class FakeClock implements Clock {
  readonly requested: number[] = [];
  private fires: Array<(reason: unknown) => void> = [];

  timeout(ms: number): Promise<never> {
    this.requested.push(ms);
    const pending = new Promise<never>((_resolve, reject) => {
      this.fires.push(reject);
    });
    pending.catch(() => {});
    return pending;
  }

  fire(reason: unknown = new Error("timeout")): void {
    const fires = this.fires;
    this.fires = [];
    for (const reject of fires) reject(reason);
  }
}

/** Lets a test await the point where the worker is blocked on the conversion. */
export const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

export const queuedJob = (overrides: Partial<Job> = {}): Job => ({
  id: "job-1",
  inputKey: "uploads/db.mdb",
  status: "queued",
  attempt: 0,
  ...overrides,
});
