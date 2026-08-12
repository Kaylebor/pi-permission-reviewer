import assert from "node:assert/strict";
import test from "node:test";
import { lockToolInput } from "../src/input-lock.ts";

test("locks the reviewed input against later extension mutation", () => {
  const event = { input: { command: "cargo test", nested: { timeout: 10 } } };
  lockToolInput(event);
  assert.ok(Object.isFrozen(event.input));
  assert.ok(Object.isFrozen(event.input.nested));
  assert.throws(() => {
    event.input.command = "rm -rf /";
  }, TypeError);
});

test("rejects exotic runtime input", () => {
  assert.throws(() => lockToolInput({ input: new Date() }), /non-plain/);
});

test("accepts and recursively locks JSON arrays", () => {
  const event = { input: { items: [{ path: "README.md" }] } };
  lockToolInput(event);
  assert.ok(Object.isFrozen(event.input.items));
  assert.ok(Object.isFrozen(event.input.items[0]));
});

test("rejects sparse arrays", () => {
  const items: unknown[] = [];
  items.length = 1;
  assert.throws(() => lockToolInput({ input: { items } }), /sparse/);
});
