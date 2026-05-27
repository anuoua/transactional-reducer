import { describe, expect, it } from "vitest";
import { setup, type TransactionHandle } from "./helpers";
import type { Action } from "./helpers";

describe("TransactionalReducer", () => {
  describe("transaction dispatch", () => {
    it("dispatches within transaction and updates state", () => {
      const engine = setup();
      const tx = engine.create();
      tx.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 1 });
      tx.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 2 });
    });

    it("dispatch on stale handle (after rollback) is ignored", () => {
      const engine = setup();
      const tx = engine.create();
      tx.dispatch({ type: "inc" });
      tx.rollback();
      expect(engine.state).toEqual({ count: 0 });
      tx.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 0 });
    });

    it("dispatch on stale handle (after commit) is ignored", () => {
      const engine = setup();
      const tx = engine.create();
      tx.dispatch({ type: "inc" });
      tx.commit();
      expect(engine.state).toEqual({ count: 1 });
      tx.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 1 });
    });
  });
});
