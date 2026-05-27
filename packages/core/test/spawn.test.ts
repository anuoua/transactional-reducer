import { describe, expect, it } from "vitest";
import { setup, type TransactionHandle } from "./helpers";
import type { Action } from "./helpers";

describe("TransactionalReducer", () => {
  describe("spawn", () => {
    it("creates child transaction with correct parentId", () => {
      const engine = setup();
      const parent = engine.create({ id: "parent" });
      parent.spawn(
        (tx) => {
          tx.dispatch({ type: "inc" });
        },
        { id: "child" },
      );
      const childHandle = engine.getTransaction("child");
      expect(childHandle?.parentId).toBe("parent");
      expect(childHandle?.id).toBe("child");
    });

    it("spawn inherits onError from options", () => {
      const engine = setup();
      const parent = engine.create({ id: "parent" });
      parent.spawn(
        (tx) => {
          tx.dispatch({ type: "inc" });
        },
        { id: "child", onError: "commit" },
      );
      const childHandle = engine.getTransaction("child");
      expect(childHandle?.onError).toBe("commit");
    });

    it("spawn throws on inactive parent", () => {
      const engine = setup();
      const parent = engine.create({ id: "parent" });
      parent.commit();
      expect(() =>
        parent.spawn(
          (tx) => {
            tx.dispatch({ type: "inc" });
          },
          { id: "child" },
        ),
      ).toThrow(/Cannot spawn from transaction "parent"/);
    });

    it("auto-commits child on sync success", () => {
      const engine = setup();
      const parent = engine.create({ id: "parent" });
      parent.dispatch({ type: "inc" });

      parent.spawn(
        (tx) => {
          tx.dispatch({ type: "inc" });
        },
        { id: "child" },
      );

      expect(engine.state).toEqual({ count: 2 });
      expect(parent.isStale()).toBe(false);

      parent.rollback();
      expect(engine.state).toEqual({ count: 0 });
    });

    it("auto-rollbacks child on sync error", () => {
      const engine = setup();
      const parent = engine.create({ id: "parent" });
      parent.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 1 });

      expect(() =>
        parent.spawn(
          (tx) => {
            tx.dispatch({ type: "inc" });
            throw new Error("child-fail");
          },
          { id: "child" },
        ),
      ).toThrow("child-fail");

      expect(engine.state).toEqual({ count: 1 });
      expect(parent.isStale()).toBe(false);

      parent.commit();
      expect(engine.state).toEqual({ count: 1 });
    });

    it("auto-commits child on async success", async () => {
      const engine = setup();
      const parent = engine.create({ id: "parent" });
      parent.dispatch({ type: "inc" });

      await parent.spawn(
        async (tx) => {
          tx.dispatch({ type: "inc" });
        },
        { id: "child" },
      );

      expect(engine.state).toEqual({ count: 2 });
      parent.commit();
      expect(engine.state).toEqual({ count: 2 });
    });

    it("auto-rollbacks child on async error", async () => {
      const engine = setup();
      const parent = engine.create({ id: "parent" });
      parent.dispatch({ type: "inc" });

      await expect(
        parent.spawn(
          async (tx) => {
            tx.dispatch({ type: "inc" });
            throw new Error("async-child-fail");
          },
          { id: "child" },
        ),
      ).rejects.toThrow("async-child-fail");

      expect(engine.state).toEqual({ count: 1 });
      parent.commit();
      expect(engine.state).toEqual({ count: 1 });
    });

    it("closure captures arguments for child task function", () => {
      const engine = setup();
      const parent = engine.create({ id: "parent" });
      parent.spawn(
        (tx) => {
          tx.dispatch({ type: "set", value: 5 });
        },
        { id: "child" },
      );
      expect(engine.state).toEqual({ count: 5 });
    });

    it("with onError: commit on child sync error preserves child changes", () => {
      const engine = setup();
      const parent = engine.create({ id: "parent" });
      parent.dispatch({ type: "inc" });

      let thrownError: Error | undefined;
      try {
        parent.spawn(
          (tx) => {
            tx.dispatch({ type: "inc" });
            throw new Error("child-fail");
          },
          { id: "child", onError: "commit" },
        );
      } catch (e) {
        thrownError = e as Error;
      }
      expect(thrownError?.message).toBe("child-fail");

      expect(engine.state).toEqual({ count: 2 });
      parent.commit();
      expect(engine.state).toEqual({ count: 2 });
    });

    it("deeply nested spawn works correctly", () => {
      const engine = setup();
      const root = engine.create({ id: "root" });
      root.dispatch({ type: "inc" });

      root.spawn(
        (l1) => {
          l1.dispatch({ type: "inc" });
          l1.spawn(
            (l2) => {
              l2.dispatch({ type: "inc" });
            },
            { id: "l2" },
          );
        },
        { id: "l1" },
      );

      expect(engine.state).toEqual({ count: 3 });
      root.commit();
      expect(engine.state).toEqual({ count: 3 });
    });
  });
});
