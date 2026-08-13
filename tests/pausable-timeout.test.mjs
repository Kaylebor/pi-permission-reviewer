import assert from "node:assert/strict";
import test from "node:test";
import { PausableTimeout } from "../src/pausable-timeout.mjs";

function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    clock: {
      now: () => now,
      setTimeout(callback, delay) {
        const handle = { id: ++nextId, unref() {} };
        timers.set(handle.id, { callback, at: now + delay });
        return handle;
      },
      clearTimeout(handle) {
        timers.delete(handle.id);
      },
    },
    advance(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
  };
}

test("permission-review pauses do not consume the execution timeout", () => {
  const fake = fakeClock();
  let fired = 0;
  const timeout = new PausableTimeout(() => { fired += 1; }, fake.clock);
  timeout.start(1_000);
  fake.advance(400);
  assert.equal(timeout.pause(), true);
  fake.advance(5_000);
  assert.equal(fired, 0);
  assert.equal(timeout.resume(), true);
  fake.advance(599);
  assert.equal(fired, 0);
  fake.advance(1);
  assert.equal(fired, 1);
});

test("nested network reviews resume the timeout only after all settle", () => {
  const fake = fakeClock();
  let fired = false;
  const timeout = new PausableTimeout(() => { fired = true; }, fake.clock);
  timeout.start(100);
  timeout.pause();
  timeout.pause();
  fake.advance(1_000);
  timeout.resume();
  fake.advance(1_000);
  assert.equal(fired, false);
  timeout.resume();
  fake.advance(100);
  assert.equal(fired, true);
});

test("stopping a paused timeout prevents a later resume or callback", () => {
  const fake = fakeClock();
  let fired = false;
  const timeout = new PausableTimeout(() => { fired = true; }, fake.clock);
  timeout.start(100);
  timeout.pause();
  timeout.stop();
  assert.equal(timeout.resume(), false);
  fake.advance(1_000);
  assert.equal(fired, false);
});
