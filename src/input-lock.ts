// Adapted from pi-approval-guardian's MIT-licensed exact-input locking design.
// See THIRD_PARTY_NOTICES.md.
export function lockToolInput(event: { input: unknown }): void {
  assertJsonLike(event.input);
  freeze(event.input);
  const descriptor = Object.getOwnPropertyDescriptor(event, "input");
  Object.defineProperty(event, "input", {
    value: event.input,
    enumerable: descriptor?.enumerable ?? true,
    writable: false,
    configurable: false,
  });
}

function assertJsonLike(value: unknown, active = new WeakSet<object>()): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number");
    return;
  }
  if (typeof value !== "object") throw new Error(`non-JSON ${typeof value}`);
  if (active.has(value)) throw new Error("cyclic input");
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new Error("array with custom prototype");
    }
    let indices = 0;
    active.add(value);
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      if (typeof key === "symbol") throw new Error("symbol-keyed input");
      const index = Number(key);
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        String(index) !== key ||
        index >= value.length
      ) {
        throw new Error("non-JSON array property");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error("non-JSON array index");
      }
      indices++;
      assertJsonLike(descriptor.value, active);
    }
    if (indices !== value.length) throw new Error("sparse array");
    active.delete(value);
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("non-plain input object");
  }
  active.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") throw new Error("symbol-keyed input");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("non-JSON input property");
    }
    assertJsonLike(descriptor.value, active);
  }
  active.delete(value);
}

function freeze(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) freeze(descriptor.value, seen);
  }
  Object.freeze(value);
}
