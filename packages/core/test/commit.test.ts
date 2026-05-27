import { describe, expect, it } from "vitest";
import { setup, type TransactionHandle } from "./helpers";
import type { Action } from "./helpers";

describe("TransactionalReducer", () => {
  describe("commit", () => {
    it("root commit preserves changes and clears transaction", () => {
      const engine = setup();
      const tx = engine.create();
      tx.dispatch({ type: "inc" });
      tx.dispatch({ type: "inc" });
      tx.commit();
      expect(engine.state).toEqual({ count: 2 });
      expect(tx.isStale()).toBe(true);
    });

    it("commit after non-transactional dispatches preserves all changes", () => {
      const engine = setup();
      engine.dispatch({ type: "inc" });
      const tx = engine.create();
      tx.dispatch({ type: "inc" });
      tx.commit();
      expect(engine.state).toEqual({ count: 2 });
    });

    it("commit cleans up action log when no active transactions remain", () => {
      const engine = setup();
      const tx = engine.create();
      tx.dispatch({ type: "inc" });
      tx.commit();
      expect(engine.state).toEqual({ count: 1 });
      engine.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 2 });
    });
  });
});
