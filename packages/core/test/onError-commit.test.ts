import { describe, expect, it } from "vitest";
import { setup, type TransactionHandle } from "./helpers";
import type { Action } from "./helpers";

describe("TransactionalReducer", () => {
  describe("onError: commit boundary", () => {
    it("parent rollback preserves child with onError: commit", () => {
      const engine = setup();
      const parent = engine.create({ id: "parent" });
      parent.dispatch({ type: "inc" });

      parent.spawn(
        (tx) => {
          tx.dispatch({ type: "inc" });
        },
        { id: "child", onError: "commit" },
      );

      expect(engine.state).toEqual({ count: 2 });

      parent.rollback();
      expect(engine.state).toEqual({ count: 1 });
    });

    it("parent rollback preserves child subtree with onError: commit", () => {
      const engine = setup();
      const parent = engine.create({ id: "parent" });
      parent.dispatch({ type: "inc" });

      parent.spawn(
        (child) => {
          child.dispatch({ type: "inc" });
          child.spawn(
            (gc) => {
              gc.dispatch({ type: "inc" });
            },
            { id: "grandchild" },
          );
        },
        { id: "child", onError: "commit" },
      );

      expect(engine.state).toEqual({ count: 3 });

      parent.rollback();
      expect(engine.state).toEqual({ count: 2 });
    });

    it("run rollback preserves spawned child with onError: commit", async () => {
      const engine = setup();
      let thrownError: Error | undefined;
      try {
        await engine.run(
          async (tx) => {
            tx.dispatch({ type: "inc" });
            await tx.spawn(
              async (childTx) => {
                childTx.dispatch({ type: "inc" });
              },
              { id: "validate", onError: "commit" },
            );
            throw new Error("submit-fail");
          },
          { id: "submit", onError: "rollback" },
        );
      } catch (e) {
        thrownError = e as Error;
      }
      expect(thrownError?.message).toBe("submit-fail");
      expect(engine.state).toEqual({ count: 1 });
    });

    it("child with onError: rollback is rolled back when parent rolls back", () => {
      const engine = setup();
      const parent = engine.create({ id: "parent" });
      parent.dispatch({ type: "inc" });

      parent.spawn(
        (tx) => {
          tx.dispatch({ type: "inc" });
        },
        { id: "child", onError: "rollback" },
      );

      expect(engine.state).toEqual({ count: 2 });

      parent.rollback();
      expect(engine.state).toEqual({ count: 0 });
    });

    it("mixed onError: commit child preserved, rollback child undone on parent rollback", () => {
      const engine = setup();
      const parent = engine.create({ id: "parent" });
      parent.dispatch({ type: "inc" });

      parent.spawn(
        (tx) => {
          tx.dispatch({ type: "inc" });
        },
        { id: "commit-child", onError: "commit" },
      );

      parent.spawn(
        (tx) => {
          tx.dispatch({ type: "inc" });
        },
        { id: "rollback-child", onError: "rollback" },
      );

      expect(engine.state).toEqual({ count: 3 });

      parent.rollback();
      expect(engine.state).toEqual({ count: 1 });
    });
  });

  describe("preserved child rollback after parent rollback", () => {
    it("preserved async child (onError:commit) rollback after parent rollback", async () => {
      const engine = setup();
      const parent = engine.create({ id: "parent" });
      parent.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 1 });

      let resolveChild!: () => void;
      const childPromise = new Promise<void>((r) => {
        resolveChild = r;
      });

      const spawnResult = parent.spawn(
        async (tx) => {
          tx.dispatch({ type: "inc" });
          await childPromise;
        },
        { id: "child", onError: "commit" },
      );

      await Promise.resolve();
      expect(engine.state).toEqual({ count: 2 });

      parent.rollback();
      expect(engine.state).toEqual({ count: 1 });

      const child = engine.getTransaction("child");
      expect(child).toBeDefined();
      expect(child!.parentId).toBeNull();

      child!.rollback();
      expect(engine.state).toEqual({ count: 0 });

      resolveChild();
      try {
        await spawnResult;
      } catch {}
    });

    it("preserved async child subtree rollback after parent rollback", async () => {
      const engine = setup();
      const parent = engine.create({ id: "parent" });
      parent.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 1 });

      let resolveChild!: () => void;
      let resolveGrandchild!: () => void;
      const childPromise = new Promise<void>((r) => {
        resolveChild = r;
      });
      const gcPromise = new Promise<void>((r) => {
        resolveGrandchild = r;
      });

      const spawnResult = parent.spawn(
        async (childTx) => {
          childTx.dispatch({ type: "inc" });
          await childTx.spawn(
            async (gcTx) => {
              gcTx.dispatch({ type: "inc" });
              await gcPromise;
            },
            { id: "grandchild" },
          );
          await childPromise;
        },
        { id: "child", onError: "commit" },
      );

      await Promise.resolve();
      expect(engine.state).toEqual({ count: 3 });

      parent.rollback();
      expect(engine.state).toEqual({ count: 2 });

      const child = engine.getTransaction("child");
      expect(child).toBeDefined();
      expect(child!.parentId).toBeNull();

      child!.rollback();
      expect(engine.state).toEqual({ count: 0 });

      resolveGrandchild!();
      resolveChild!();
      try {
        await spawnResult;
      } catch {}
    });

    it("preserved async child dispatch + rollback after parent rollback", async () => {
      const engine = setup();
      const parent = engine.create({ id: "parent" });
      parent.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 1 });

      let resolveChild!: () => void;
      const childPromise = new Promise<void>((r) => {
        resolveChild = r;
      });

      const spawnResult = parent.spawn(
        async (tx) => {
          tx.dispatch({ type: "inc" });
          await childPromise;
        },
        { id: "child", onError: "commit" },
      );

      await Promise.resolve();
      expect(engine.state).toEqual({ count: 2 });

      parent.rollback();
      expect(engine.state).toEqual({ count: 1 });

      const child = engine.getTransaction("child");
      expect(child).toBeDefined();

      child!.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 2 });

      child!.rollback();
      expect(engine.state).toEqual({ count: 0 });

      resolveChild();
      try {
        await spawnResult;
      } catch {}
    });
  });
});
