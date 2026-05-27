import { describe, expect, it } from "vitest";
import { setup, setupWithIdGenerator, type TransactionHandle } from "./helpers";
import type { Action } from "./helpers";

describe("TransactionalReducer", () => {
  describe("create", () => {
    it("creates a transaction handle with correct id", () => {
      const engine = setupWithIdGenerator();
      const tx = engine.create();
      expect(tx.id).toBe("tx_1");
      expect(tx.parentId).toBeNull();
      expect(tx.onError).toBe("rollback");
    });

    it("creates transaction with custom id", () => {
      const engine = setup();
      const tx = engine.create({ id: "my-tx" });
      expect(tx.id).toBe("my-tx");
    });

    it("creates transaction with custom onError", () => {
      const engine = setup();
      const tx = engine.create({ id: "my-tx", onError: "commit" });
      expect(tx.onError).toBe("commit");
    });

    it("beginning transaction with same id rolls back existing active one", () => {
      const engine = setupWithIdGenerator();
      const tx1 = engine.create({ id: "same-id" });
      tx1.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 1 });

      const tx2 = engine.create({ id: "same-id" });
      expect(engine.state).toEqual({ count: 0 });
      tx2.dispatch({ type: "dec" });
      expect(engine.state).toEqual({ count: -1 });
    });

    it("getTransaction retrieves handle by id", () => {
      const engine = setupWithIdGenerator();
      engine.create({ id: "lookup-tx" });
      const retrieved = engine.getTransaction("lookup-tx");
      expect(retrieved?.id).toBe("lookup-tx");
      expect(retrieved?.parentId).toBeNull();
    });
  });
});
