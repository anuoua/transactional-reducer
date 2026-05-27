import { describe, expect, it, vi } from "vitest";
import { setup, type TransactionHandle } from "./helpers";
import type { Action } from "./helpers";

describe("TransactionalReducer", () => {
  describe("onCancel", () => {
    it("fires onCancel callback when transaction is replaced by dedup (createTx)", () => {
      const engine = setup();
      const onCancel = vi.fn();

      const tx1 = engine.create({ id: "same-id" });
      tx1.onCancel(onCancel);
      tx1.dispatch({ type: "inc" });

      expect(onCancel).not.toHaveBeenCalled();

      engine.create({ id: "same-id" });
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("fires onCancel callback when transaction is manually rolled back", () => {
      const engine = setup();
      const onCancel = vi.fn();

      const tx = engine.create();
      tx.onCancel(onCancel);
      tx.dispatch({ type: "inc" });

      expect(onCancel).not.toHaveBeenCalled();

      tx.rollback();
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("fires onCancel callback when async transaction is replaced by dedup (run)", async () => {
      const engine = setup();
      const onCancel = vi.fn();

      let resolveFirst!: () => void;
      const firstPromise = new Promise<void>((r) => {
        resolveFirst = r;
      });

      engine.run(
        async (tx) => {
          tx.onCancel(onCancel);
          tx.dispatch({ type: "inc" });
          await firstPromise;
        },
        { id: "search" },
      );

      await Promise.resolve();
      expect(onCancel).not.toHaveBeenCalled();

      engine.run(
        (tx) => {
          tx.dispatch({ type: "dec" });
        },
        { id: "search" },
      );

      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(engine.state).toEqual({ count: -1 });

      resolveFirst();
      try {
        await firstPromise;
      } catch {}
    });

    it("fires onCancel for child in rollbackSet when parent rolls back", () => {
      const engine = setup();
      const parentOnCancel = vi.fn();
      const childOnCancel = vi.fn();

      const parent = engine.create({ id: "parent" });
      parent.onCancel(parentOnCancel);
      parent.dispatch({ type: "inc" });

      parent.spawn(
        (tx) => {
          tx.onCancel(childOnCancel);
          tx.dispatch({ type: "inc" });
        },
        { id: "child", onError: "rollback" },
      );

      expect(parentOnCancel).not.toHaveBeenCalled();
      expect(childOnCancel).not.toHaveBeenCalled();

      parent.rollback();
      expect(parentOnCancel).toHaveBeenCalledTimes(1);
      expect(childOnCancel).toHaveBeenCalledTimes(1);
    });

    it("does NOT fire onCancel for preserved child (onError: commit) when parent rolls back", () => {
      const engine = setup();
      const parentOnCancel = vi.fn();
      const childOnCancel = vi.fn();

      const parent = engine.create({ id: "parent" });
      parent.onCancel(parentOnCancel);
      parent.dispatch({ type: "inc" });

      parent.spawn(
        (tx) => {
          tx.onCancel(childOnCancel);
          tx.dispatch({ type: "inc" });
        },
        { id: "child", onError: "commit" },
      );

      parent.rollback();
      expect(parentOnCancel).toHaveBeenCalledTimes(1);
      expect(childOnCancel).not.toHaveBeenCalled();
    });

    it("calls onCancel immediately if transaction is already stale", () => {
      const engine = setup();
      const onCancel = vi.fn();

      const tx = engine.create();
      tx.dispatch({ type: "inc" });
      tx.rollback();

      expect(tx.isStale()).toBe(true);
      tx.onCancel(onCancel);
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("does NOT fire onCancel on commit", () => {
      const engine = setup();
      const onCancel = vi.fn();

      const tx = engine.create();
      tx.onCancel(onCancel);
      tx.dispatch({ type: "inc" });
      tx.commit();

      expect(onCancel).not.toHaveBeenCalled();
    });

    it("supports multiple onCancel callbacks on the same transaction", () => {
      const engine = setup();
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      const tx = engine.create();
      tx.onCancel(cb1);
      tx.onCancel(cb2);
      tx.rollback();

      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(1);
    });

    it("does not double-fire onCancel when createTx replaces then _rollback runs", () => {
      const engine = setup();
      const onCancel = vi.fn();

      const tx1 = engine.create({ id: "same-id" });
      tx1.onCancel(onCancel);
      tx1.dispatch({ type: "inc" });

      engine.create({ id: "same-id" });

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("fires onCancel for rollbackSet descendants when parent rolls back (deep tree)", () => {
      const engine = setup();
      const rootCb = vi.fn();
      const l1Cb = vi.fn();
      const l2Cb = vi.fn();

      const root = engine.create({ id: "root" });
      root.onCancel(rootCb);
      root.dispatch({ type: "inc" });

      root.spawn(
        (l1) => {
          l1.onCancel(l1Cb);
          l1.dispatch({ type: "inc" });
          l1.spawn(
            (l2) => {
              l2.onCancel(l2Cb);
              l2.dispatch({ type: "inc" });
            },
            { id: "l2", onError: "rollback" },
          );
        },
        { id: "l1", onError: "rollback" },
      );

      root.rollback();
      expect(rootCb).toHaveBeenCalledTimes(1);
      expect(l1Cb).toHaveBeenCalledTimes(1);
      expect(l2Cb).toHaveBeenCalledTimes(1);
    });

    it("AbortController integration: abort fetch when transaction is replaced", async () => {
      const engine = setup();
      const ac = new AbortController();

      let resolveFirst!: () => void;
      const firstPromise = new Promise<void>((r) => {
        resolveFirst = r;
      });

      const firstRunResult = engine.run(
        async (tx) => {
          tx.onCancel(() => ac.abort());
          tx.dispatch({ type: "inc" });
          await firstPromise;
        },
        { id: "search" },
      );

      await Promise.resolve();
      expect(ac.signal.aborted).toBe(false);

      engine.run(
        (tx) => {
          tx.dispatch({ type: "dec" });
        },
        { id: "search" },
      );

      expect(ac.signal.aborted).toBe(true);
      expect(engine.state).toEqual({ count: -1 });

      resolveFirst();
      try {
        await firstRunResult;
      } catch {}
    });

    it("does NOT fire onCancel for committed child when parent auto-commits via run (sync)", () => {
      const engine = setup();
      const childOnCancel = vi.fn();

      engine.run(
        (tx) => {
          tx.dispatch({ type: "inc" });
          tx.spawn(
            (childTx) => {
              childTx.onCancel(childOnCancel);
              childTx.dispatch({ type: "inc" });
            },
            { id: "child", onError: "rollback" },
          );
        },
        { id: "parent" },
      );

      expect(childOnCancel).not.toHaveBeenCalled();
      expect(engine.state).toEqual({ count: 2 });
    });

    it("fires onCancel for still-active async child when parent auto-commits via run", async () => {
      const engine = setup();
      const childOnCancel = vi.fn();

      let resolveChild!: () => void;
      const childPromise = new Promise<void>((r) => {
        resolveChild = r;
      });

      const parentRunResult = engine.run(
        async (tx) => {
          tx.dispatch({ type: "inc" });
          tx.spawn(
            async (childTx) => {
              childTx.onCancel(childOnCancel);
              childTx.dispatch({ type: "inc" });
              await childPromise;
            },
            { id: "child", onError: "rollback" },
          );
        },
        { id: "parent" },
      );

      try {
        await parentRunResult;
      } catch {}

      expect(childOnCancel).toHaveBeenCalledTimes(1);
      expect(engine.state).toEqual({ count: 1 });

      resolveChild();
      await Promise.resolve();
    });
  });
});
