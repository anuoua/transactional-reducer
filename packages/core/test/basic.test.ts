import { describe, expect, it } from "vitest";
import { setup, setupWithSnapshot, type TransactionHandle } from "./helpers";
import type { Action } from "./helpers";

describe("TransactionalReducer", () => {
  describe("basic dispatch", () => {
    it("dispatches actions and updates state", () => {
      const engine = setup();
      engine.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 1 });
      engine.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 2 });
    });

    it("getDraft returns current state", () => {
      const engine = setup();
      engine.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 1 });
    });
  });

  describe("non-transactional dispatch during active transactions", () => {
    it("non-tx dispatch is logged and preserved on rollback", () => {
      const engine = setup();
      const tx = engine.create();
      engine.dispatch({ type: "inc" });
      tx.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 2 });

      tx.rollback();
      expect(engine.state).toEqual({ count: 1 });
    });

    it("non-tx dispatch is not logged when no active transactions", () => {
      const engine = setup();
      engine.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 1 });
    });
  });

  describe("custom snapshot function", () => {
    it("uses custom snapshot function instead of structuredClone", () => {
      const engine = setupWithSnapshot();
      const tx = engine.create();
      tx.dispatch({ type: "inc" });
      tx.rollback();
      expect(engine.state).toEqual({ count: 0 });
    });
  });

  describe("edge cases", () => {
    it("double commit is safe (second is ignored)", () => {
      const engine = setup();
      const tx = engine.create();
      tx.dispatch({ type: "inc" });
      tx.commit();
      tx.commit();
      expect(engine.state).toEqual({ count: 1 });
    });

    it("double rollback is safe (second is ignored)", () => {
      const engine = setup();
      const tx = engine.create();
      tx.dispatch({ type: "inc" });
      tx.rollback();
      tx.rollback();
      expect(engine.state).toEqual({ count: 0 });
    });

    it("commit then rollback is safe (rollback is ignored)", () => {
      const engine = setup();
      const tx = engine.create();
      tx.dispatch({ type: "inc" });
      tx.commit();
      tx.rollback();
      expect(engine.state).toEqual({ count: 1 });
    });

    it("rollback then commit is safe (commit is ignored)", () => {
      const engine = setup();
      const tx = engine.create();
      tx.dispatch({ type: "inc" });
      tx.rollback();
      tx.commit();
      expect(engine.state).toEqual({ count: 0 });
    });
  });
});
