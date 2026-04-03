type CacheEntry<T> = {
  value: T;
  createdAt: number;
};

export class LruCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly maxSize: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }

    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.store.delete(key);
      return null;
    }

    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T) {
    this.store.delete(key);
    this.store.set(key, { value, createdAt: Date.now() });

    while (this.store.size > this.maxSize) {
      const oldestKey = this.store.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.store.delete(oldestKey);
    }
  }
}
