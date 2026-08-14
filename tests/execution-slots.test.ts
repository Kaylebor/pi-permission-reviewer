import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionSlots } from "../src/execution-slots.ts";

test("execution slots queue in FIFO order and start automatically", async () => {
  const slots = new ExecutionSlots(1);
  const releaseFirst = await slots.acquire();
  const order: number[] = [];
  const second = slots.acquire().then((release) => {
    order.push(2);
    release();
  });
  const third = slots.acquire().then((release) => {
    order.push(3);
    release();
  });
  assert.equal(slots.activeCount, 1);
  assert.equal(slots.queuedCount, 2);
  releaseFirst();
  await Promise.all([second, third]);
  assert.deepEqual(order, [2, 3]);
  assert.equal(slots.activeCount, 0);
});

test("queued execution can be cancelled without consuming a slot", async () => {
  const slots = new ExecutionSlots(1);
  const release = await slots.acquire();
  const controller = new AbortController();
  const queued = slots.acquire(controller.signal);
  controller.abort(new Error("session changed"));
  await assert.rejects(queued, /session changed/);
  release();
  assert.equal(slots.activeCount, 0);
  assert.equal(slots.queuedCount, 0);
});

test("raising the limit drains queued executions", async () => {
  const slots = new ExecutionSlots(1);
  const releaseFirst = await slots.acquire();
  const second = slots.acquire();
  slots.setLimit(2);
  const releaseSecond = await second;
  assert.equal(slots.activeCount, 2);
  releaseSecond();
  releaseFirst();
});
