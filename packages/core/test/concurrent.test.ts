import { describe, expect, it } from "vitest";
import { setup, type TransactionHandle } from "./helpers";
import type { Action } from "./helpers";

describe("TransactionalReducer", () => {
  describe("concurrent transactions", () => {
    it("multiple independent transactions can coexist", () => {
      const engine = setup();
      const tx1 = engine.create({ id: "tx1" });
      const tx2 = engine.create({ id: "tx2" });

      tx1.dispatch({ type: "inc" });
      tx2.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 2 });

      tx1.rollback();
      expect(engine.state).toEqual({ count: 1 });

      tx2.commit();
      expect(engine.state).toEqual({ count: 1 });
    });

    it("rollback one transaction preserves changes from committed sibling", () => {
      const engine = setup();
      const tx1 = engine.create({ id: "tx1" });
      const tx2 = engine.create({ id: "tx2" });

      tx1.dispatch({ type: "inc" });
      tx2.dispatch({ type: "inc" });
      tx2.commit();
      tx1.rollback();
      expect(engine.state).toEqual({ count: 1 });
    });
  });
});
