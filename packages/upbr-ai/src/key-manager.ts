/**
 * API Key Manager - handles key rotation, lockout, and environment variable parsing.
 *
 * Environment variables:
 *   UPBR_{NAME}_API_KEY=key1         # Single key
 *   UPBR_{NAME}_API_KEY_LISTS=key1 : key2 : key3   # Multiple keys
 *
 * If both are defined, they are merged and deduplicated.
 * When deduplication leaves only one key, it degenerates to single-key mode.
 */
export class KeyManager {
  private lockedKeys = new Map<string, number>(); // key -> unlock timestamp
  private availableKeys: string[];
  private currentIndex = 0;

  constructor(keys: string[]) {
    this.availableKeys = [...new Set(keys)]; // dedup
  }

  /**
   * Parse API keys from environment variables.
   * Supports both single key and key list formats.
   */
  static fromEnv(providerName: string): KeyManager {
    const prefix = `UPBR_${providerName.toUpperCase().replace(/-/g, "_")}`;
    const singleKey = process.env[`${prefix}_API_KEY`];
    const listsKey = process.env[`${prefix}_API_KEY_LISTS`];

    const keys: string[] = [];

    if (singleKey) keys.push(singleKey);
    if (listsKey) {
      keys.push(...listsKey.split(" : ").map((k) => k.trim()).filter(Boolean));
    }

    return new KeyManager(keys);
  }

  /**
   * Get the next available key. Keys locked for 5 hours are skipped.
   * If all keys are locked, throws an error.
   */
  getActiveKey(): string {
    const now = Date.now();
    const lockoutMs = 5 * 60 * 60 * 1000; // 5 hours

    if (this.availableKeys.length === 0) {
      throw new Error("No API keys available");
    }

    // If only one key, just use it (check lock)
    if (this.availableKeys.length === 1) {
      const key = this.availableKeys[0]!;
      const lockedUntil = this.lockedKeys.get(key);
      if (lockedUntil && now < lockedUntil) {
        throw new Error(
          `API key is locked for another ${Math.ceil((lockedUntil - now) / 60000)} minutes`
        );
      }
      return key;
    }

    // Try each key starting from current index
    const startIdx = this.currentIndex;
    for (let i = 0; i < this.availableKeys.length; i++) {
      const idx = (startIdx + i) % this.availableKeys.length;
      const key = this.availableKeys[idx]!;
      const lockedUntil = this.lockedKeys.get(key);

      if (!lockedUntil || now >= lockedUntil) {
        this.currentIndex = (idx + 1) % this.availableKeys.length;
        return key;
      }
    }

    // All keys locked - find earliest unlock
    let earliestUnlock = Infinity;
    for (const [, until] of this.lockedKeys) {
      if (until < earliestUnlock) earliestUnlock = until;
    }
    const waitMs = earliestUnlock - now;
    throw new Error(
      `All API keys are locked. Retry in ${Math.ceil(waitMs / 60000)} minutes.`
    );
  }

  /**
   * Lock a specific key (marks as unavailable for 5 hours).
   */
  lockKey(key: string): void {
    this.lockedKeys.set(key, Date.now() + 5 * 60 * 60 * 1000);
  }

  /**
   * Get the current count of available (unlocked) keys.
   */
  get availableCount(): number {
    const now = Date.now();
    return this.availableKeys.filter((k) => {
      const until = this.lockedKeys.get(k);
      return !until || now >= until;
    }).length;
  }

  /**
   * Get total key count.
   */
  get totalCount(): number {
    return this.availableKeys.length;
  }
}
