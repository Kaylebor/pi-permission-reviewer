interface Waiter {
  resolve(release: () => void): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** Cancellable FIFO semaphore for sandbox-worker process slots. */
export class ExecutionSlots {
  private active = 0;
  private limit: number;
  private readonly waiters: Waiter[] = [];

  constructor(limit: number) {
    this.limit = validateLimit(limit);
  }

  setLimit(limit: number): void {
    this.limit = validateLimit(limit);
    this.drain();
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(asError(signal.reason, "sandbox execution cancelled while queued"));
    }
    if (this.active < this.limit && this.waiters.length === 0) {
      this.active += 1;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          reject(asError(signal.reason, "sandbox execution cancelled while queued"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
      this.drain();
    });
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.waiters.length;
  }

  private drain(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (waiter.onAbort && waiter.signal) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      if (waiter.signal?.aborted) {
        waiter.reject(asError(waiter.signal.reason, "sandbox execution cancelled while queued"));
        continue;
      }
      this.active += 1;
      waiter.resolve(this.releaseOnce());
    }
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.drain();
    };
  }
}

function validateLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) {
    throw new Error("sandbox concurrency must be an integer from 1 to 32");
  }
  return value;
}

function asError(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback);
}
