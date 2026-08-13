/** A one-shot wall-clock budget that can exclude externally reviewed pauses. */
export class PausableTimeout {
  #active = false;
  #handle;
  #pauseDepth = 0;
  #remainingMs = 0;
  #startedAt = 0;

  constructor(onTimeout, clock = {}) {
    this.onTimeout = onTimeout;
    this.now = clock.now ?? Date.now;
    this.setTimer = clock.setTimeout ?? setTimeout;
    this.clearTimer = clock.clearTimeout ?? clearTimeout;
  }

  start(durationMs) {
    this.stop();
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new Error("timeout duration must be positive and finite");
    }
    this.#active = true;
    this.#remainingMs = durationMs;
    this.#arm();
  }

  pause() {
    if (!this.#active) return false;
    this.#pauseDepth += 1;
    if (this.#pauseDepth === 1) this.#disarm(true);
    return true;
  }

  resume() {
    if (!this.#active || this.#pauseDepth === 0) return false;
    this.#pauseDepth -= 1;
    if (this.#pauseDepth === 0) this.#arm();
    return true;
  }

  stop() {
    this.#disarm(false);
    this.#active = false;
    this.#pauseDepth = 0;
    this.#remainingMs = 0;
  }

  #arm() {
    if (!this.#active || this.#pauseDepth > 0 || this.#handle) return;
    this.#startedAt = this.now();
    this.#handle = this.setTimer(() => {
      this.#handle = undefined;
      this.#active = false;
      this.#remainingMs = 0;
      this.onTimeout();
    }, this.#remainingMs);
    this.#handle?.unref?.();
  }

  #disarm(accountElapsed) {
    if (!this.#handle) return;
    this.clearTimer(this.#handle);
    this.#handle = undefined;
    if (accountElapsed) {
      this.#remainingMs = Math.max(
        0,
        this.#remainingMs - Math.max(0, this.now() - this.#startedAt),
      );
    }
  }
}
