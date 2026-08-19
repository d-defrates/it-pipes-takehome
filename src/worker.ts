export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export type JobType = "import" | "export";

/**
 * Each budget must expire well before the queue's visibility timeout (15 min
 * for imports, 2 h for exports), so the worker kills its own conversion rather
 * than racing a redelivery.
 */
const TIMEOUT_MS: Record<JobType, number> = {
  import: 10 * 60_000,
  export: 90 * 60_000,
};

const OUTPUT_EXTENSION: Record<JobType, string> = {
  import: "json",
  export: "zip",
};

export interface Job {
  id: string;
  type: JobType;
  inputKey: string;
  status: JobStatus;
  attempt: number;
  outputKey?: string;
  error?: string;
}

export interface JobStore {
  get(id: string): Promise<Job | undefined>;
  /**
   * Writes only if the stored job still has `expectedAttempt`. Returns false
   * when another attempt has moved on, so callers must not assume they own the
   * job after an unconditional read.
   */
  put(job: Job, expectedAttempt: number): Promise<boolean>;
}

export interface QueueMessage {
  jobId: string;
  receiveCount: number;
  ack(): Promise<void>;
  retry(): Promise<void>;
}

export interface RunningConversion {
  completion: Promise<void>;
  kill(): Promise<void>;
}

export interface Converter {
  start(inputKey: string, outputKey: string): RunningConversion;
}

export interface Clock {
  timeout(ms: number): Promise<never>;
}

export async function handle(
  message: QueueMessage,
  store: JobStore,
  converter: Converter,
  clock: Clock,
): Promise<void> {
  const job = await store.get(message.jobId);
  if (!job) {
    await message.ack();
    return;
  }

  if (job.status === "succeeded" || job.status === "failed") {
    await message.ack();
    return;
  }

  const attempt = job.attempt + 1;
  const acquired = await store.put({ ...job, status: "running", attempt }, job.attempt);
  if (!acquired) {
    await message.ack();
    return;
  }

  const outputKey = `jobs/${job.id}/result.${OUTPUT_EXTENSION[job.type]}`;
  const conversion = converter.start(job.inputKey, outputKey);
  // The loser of the race below is abandoned; an unobserved rejection would
  // take down the conversions sharing this task.
  conversion.completion.catch(() => {});

  try {
    await Promise.race([
      conversion.completion,
      clock.timeout(TIMEOUT_MS[job.type]),
    ]);

    await store.put(
      {
        ...job,
        status: "succeeded",
        attempt,
        outputKey,
      },
      attempt,
    );
    await message.ack();
  } catch (error) {
    try {
      await conversion.kill();
    } catch {
      // A conversion that cannot be killed is an operational problem, not this
      // job's outcome: report the conversion error the caller cares about.
    }

    if (message.receiveCount >= 3) {
      await store.put(
        {
          ...job,
          status: "failed",
          attempt,
          error: String(error),
        },
        attempt,
      );
      await message.ack();
      return;
    }

    await message.retry();
  }
}
