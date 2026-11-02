/**
 * A Map that forgets its least recently used entries past `limit`, for what
 * the page reads once and keeps while it is open: recorded calls, function
 * spans and recorded answers. A console tab can stay open for days while
 * traffic runs, so nothing the page keeps per run may grow without end.
 */
export class BoundedCache<K, V> {
  private readonly entries = new Map<K, V>()

  constructor(private readonly limit: number) {}

  has(key: K): boolean {
    return this.entries.has(key)
  }

  get(key: K): V | undefined {
    const value = this.entries.get(key)
    if (value !== undefined) {
      // A Map iterates in insertion order, so setting the key again marks it as the newest.
      this.entries.delete(key)
      this.entries.set(key, value)
    }

    return value
  }

  set(key: K, value: V): void {
    this.entries.delete(key)
    this.entries.set(key, value)
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.limit) {
        return
      }

      this.entries.delete(oldest)
    }
  }
}
