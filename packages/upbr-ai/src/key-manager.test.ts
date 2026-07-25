import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { KeyManager } from "./key-manager";

describe("KeyManager", () => {
  describe("construction & dedup", () => {
    test("deduplicates duplicate keys", () => {
      const km = new KeyManager(["a", "b", "a", "c", "b"]);
      expect(km.totalCount).toBe(3);
    });

    test("empty keys array works", () => {
      const km = new KeyManager([]);
      expect(km.totalCount).toBe(0);
      expect(km.availableCount).toBe(0);
    });

    test("single key", () => {
      const km = new KeyManager(["key1"]);
      expect(km.totalCount).toBe(1);
      expect(km.getActiveKey()).toBe("key1");
    });
  });

  describe("getActiveKey rotation", () => {
    test("round-robin through multiple keys", () => {
      const km = new KeyManager(["k1", "k2", "k3"]);
      expect(km.getActiveKey()).toBe("k1");
      expect(km.getActiveKey()).toBe("k2");
      expect(km.getActiveKey()).toBe("k3");
      expect(km.getActiveKey()).toBe("k1");
    });

    test("skip locked keys in rotation", () => {
      const km = new KeyManager(["k1", "k2", "k3"]);
      km.lockKey("k1");
      expect(km.availableCount).toBe(2);
      expect(km.getActiveKey()).toBe("k2");
      expect(km.getActiveKey()).toBe("k3");
      expect(km.getActiveKey()).toBe("k2"); // k1 still locked
    });

    test("throws when all keys locked", () => {
      const km = new KeyManager(["k1", "k2"]);
      km.lockKey("k1");
      km.lockKey("k2");
      expect(() => km.getActiveKey()).toThrow(/All API keys are locked/);
    });

    test("throws when no keys available", () => {
      const km = new KeyManager([]);
      expect(() => km.getActiveKey()).toThrow(/No API keys available/);
    });
  });

  describe("lockKey", () => {
    test("locked key decreases availableCount", () => {
      const km = new KeyManager(["k1", "k2"]);
      expect(km.availableCount).toBe(2);
      km.lockKey("k1");
      expect(km.availableCount).toBe(1);
    });

    test("locking all keys makes availableCount 0", () => {
      const km = new KeyManager(["k1"]);
      km.lockKey("k1");
      expect(km.availableCount).toBe(0);
    });

    test("locked single key throws on getActiveKey", () => {
      const km = new KeyManager(["only"]);
      km.lockKey("only");
      expect(() => km.getActiveKey()).toThrow(/locked for another/);
    });
  });

  describe("fromEnv", () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      delete process.env.UPBR_TEST_API_KEY;
      delete process.env.UPBR_TEST_API_KEY_LISTS;
    });

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    test("parses single key from env", () => {
      process.env.UPBR_TEST_API_KEY = "my-secret-key";
      const km = KeyManager.fromEnv("test");
      expect(km.totalCount).toBe(1);
      expect(km.getActiveKey()).toBe("my-secret-key");
    });

    test("parses key list with space-colon-space separator", () => {
      process.env.UPBR_TEST_API_KEY_LISTS = "k1 : k2 : k3";
      const km = KeyManager.fromEnv("test");
      expect(km.totalCount).toBe(3);
      expect(km.getActiveKey()).toBe("k1");
    });

    test("merges single key and list, deduplicates", () => {
      process.env.UPBR_TEST_API_KEY = "k1";
      process.env.UPBR_TEST_API_KEY_LISTS = "k1 : k2 : k3";
      const km = KeyManager.fromEnv("test");
      // k1 appears in both, deduped to one
      expect(km.totalCount).toBe(3);
    });

    test("handles provider name with dashes", () => {
      process.env.UPBR_MY_PROVIDER_API_KEY = "dash-key";
      const km = KeyManager.fromEnv("my-provider");
      expect(km.getActiveKey()).toBe("dash-key");
    });

    test("empty env variables yield empty KeyManager", () => {
      delete process.env.UPBR_NONE_API_KEY;
      delete process.env.UPBR_NONE_API_KEY_LISTS;
      const km = KeyManager.fromEnv("none");
      expect(km.totalCount).toBe(0);
    });
  });
});
