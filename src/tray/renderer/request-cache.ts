/**
 * A cache of loaded values, per key (a summary per range, the Doctor report, and so on). Pure, so the tests drive it directly.
 *
 * Two ways a late response could replace a newer value, and the rules that prevent both:
 * - Same key, duplicate requests. Each load for a key is a request; loads are not shared. Only the newest load started for a key may
 *   write that key, so a late earlier response cannot overwrite a newer cached value, whatever order the responses arrive in.
 * - A request started before a clear(). clear() drops every value and forgets every key's newest load, so a load that started before it
 *   no longer matches its key and cannot write. A response from before a Refresh cannot repopulate what the Refresh cleared.
 *
 * A load returns its own value to its caller whether or not that value was written; the caller decides whether to show it. A cached
 * value is returned without a request. A newest load that fails leaves the key empty, and an older load that succeeds does not fill it.
 */
export class RequestCache<K, T> {
  private readonly values = new Map<K, T>();
  /** The number of the newest load started for each key. Only that load may write the key. */
  private readonly newest = new Map<K, number>();
  private starts = 0;

  /** The cached value for `key`, or undefined. */
  get(key: K): T | undefined {
    return this.values.get(key);
  }

  /** Returns the cached value for `key`, or starts a load for it and writes the result if the load is still the newest and current. */
  async load(key: K, fetch: () => Promise<T>): Promise<T> {
    const cached = this.values.get(key);
    if (cached !== undefined) return cached;
    const start = ++this.starts;
    this.newest.set(key, start);
    const value = await fetch();
    if (this.newest.get(key) === start) this.values.set(key, value);
    return value;
  }

  /** Drops every value, and retires every load still in flight: none of them may write after this. */
  clear(): void {
    this.values.clear();
    this.newest.clear(); // a load started before this finds no matching number, so it cannot write
  }
}
