import { describe, expect, it } from "vitest";
import { setup, type TransactionHandle } from "./helpers";
import type { Action } from "./helpers";

describe("TransactionalReducer", () => {
  describe("rollback", () => {
    it("reverts state to snapshot", () => {
      const engine = setup();
      engine.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 1 });

      const tx = engine.create();
      tx.dispatch({ type: "inc" });
      tx.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 3 });

      tx.rollback();
      expect(engine.state).toEqual({ count: 1 });
    });

    it("rollback cleans up when no active transactions remain", () => {
      const engine = setup();
      const tx = engine.create();
      tx.dispatch({ type: "inc" });
      tx.rollback();
      expect(engine.state).toEqual({ count: 0 });
      engine.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 1 });
    });
  });
});
