export class LruCache {
    maxSize;
    ttlMs;
    store = new Map();
    constructor(maxSize, ttlMs) {
        this.maxSize = maxSize;
        this.ttlMs = ttlMs;
    }
    get(key) {
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
    set(key, value) {
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
