/** Null-prototype object factory — prevents __proto__ lookups from traversing Object.prototype. */
export function nullPrototype<T extends object>(obj: T): T {
  return Object.assign(Object.create(null), obj) as T;
}

/** Empty null-prototype map for accumulators. */
export function emptyMap<V>(): Record<string, V> {
  return Object.create(null) as Record<string, V>;
}
