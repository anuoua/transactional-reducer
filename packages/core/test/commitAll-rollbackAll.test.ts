import { describe, expect, it, vi } from "vitest";
import { setup } from "./helpers";

describe("TransactionalReducer", () => {
  describe("rollbackAll", () => {
    it("rolls back all active root transactions", () => {
      const engine = setup();
      const tx1 = engine.create({ id: "tx1" });
      const tx2 = engine.create({ id: "tx2" });

      tx1.dispatch({ type: "inc" });
      tx2.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 2 });

      engine.rollbackAll();
      expect(engine.state).toEqual({ count: 0 });
    });

    it("preserves non-transactional dispatches before transactions", () => {
      const engine = setup();
      engine.dispatch({ type: "inc" });
      const tx = engine.create({ id: "tx1" });
      tx.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 2 });

      engine.rollbackAll();
      expect(engine.state).toEqual({ count: 1 });
    });

    it("is a no-op when no active transactions exist", () => {
      const engine = setup();
      engine.dispatch({ type: "inc" });
      engine.rollbackAll();
      expect(engine.state).toEqual({ count: 1 });
    });

    it("cascades to child transactions", () => {
      const engine = setup();
      const tx = engine.create({ id: "parent" });
      tx.dispatch({ type: "inc" });
      tx.spawn((child) => {
        child.dispatch({ type: "inc" });
      });
      expect(engine.state).toEqual({ count: 2 });

      engine.rollbackAll();
      expect(engine.state).toEqual({ count: 0 });
    });

    it("triggers onCancel callbacks", () => {
      const engine = setup();
      const tx = engine.create({ id: "tx1" });
      let cancelled = false;
      tx.onCancel(() => {
        cancelled = true;
      });

      engine.rollbackAll();
      expect(cancelled).toBe(true);
    });

    it("rolls back pending async transactions created via run", async () => {
      const engine = setup();
      let resolve1!: () => void;
      let resolve2!: () => void;
      const p1 = new Promise<void>((r) => { resolve1 = r; });
      const p2 = new Promise<void>((r) => { resolve2 = r; });

      const promise1 = engine.run(async (tx) => {
        tx.dispatch({ type: "inc" });
        await p1;
        tx.dispatch({ type: "inc" });
      }, { id: "a" });

      const promise2 = engine.run(async (tx) => {
        tx.dispatch({ type: "inc" });
        await p2;
        tx.dispatch({ type: "inc" });
      }, { id: "b" });

      expect(engine.state).toEqual({ count: 2 });

      engine.rollbackAll();
      expect(engine.state).toEqual({ count: 0 });

      resolve1();
      resolve2();
      await promise1.catch(() => {});
      await promise2.catch(() => {});
    });

    it("async completions after rollbackAll are silently ignored", async () => {
      const engine = setup();
      let resolve!: () => void;
      const p = new Promise<void>((r) => { resolve = r; });

      const promise = engine.run(async (tx) => {
        tx.dispatch({ type: "inc" });
        await p;
        tx.dispatch({ type: "inc" });
      }, { id: "task" });

      expect(engine.state).toEqual({ count: 1 });
      engine.rollbackAll();
      expect(engine.state).toEqual({ count: 0 });

      resolve();
      await promise.catch(() => {});
      expect(engine.state).toEqual({ count: 0 });
    });

    it("triggers onCancel for pending async transactions", async () => {
      const engine = setup();
      const onCancel = vi.fn();
      let resolve!: () => void;
      const p = new Promise<void>((r) => { resolve = r; });

      const promise = engine.run(async (tx) => {
        tx.onCancel(onCancel);
        tx.dispatch({ type: "inc" });
        await p;
      }, { id: "task" });

      expect(onCancel).not.toHaveBeenCalled();
      engine.rollbackAll();
      expect(onCancel).toHaveBeenCalledTimes(1);

      resolve();
      await promise.catch(() => {});
    });

    it("AbortController integration: abort pending requests on rollbackAll", async () => {
      const engine = setup();
      const ac = new AbortController();
      let resolve!: () => void;
      const p = new Promise<void>((r) => { resolve = r; });

      const promise = engine.run(async (tx) => {
        tx.onCancel(() => ac.abort());
        tx.dispatch({ type: "inc" });
        await p;
      }, { id: "fetch" });

      expect(ac.signal.aborted).toBe(false);
      engine.rollbackAll();
      expect(ac.signal.aborted).toBe(true);
      expect(engine.state).toEqual({ count: 0 });

      resolve();
      await promise.catch(() => {});
    });

    it("rolls back multiple concurrent async transactions independently", async () => {
      const engine = setup();
      let resolveA!: () => void;
      let resolveB!: () => void;
      const pA = new Promise<void>((r) => { resolveA = r; });
      const pB = new Promise<void>((r) => { resolveB = r; });

      const promiseA = engine.run(async (tx) => {
        tx.dispatch({ type: "inc" });
        await pA;
      }, { id: "a" });

      const promiseB = engine.run(async (tx) => {
        tx.dispatch({ type: "inc" });
        await pB;
      }, { id: "b" });

      expect(engine.state).toEqual({ count: 2 });

      engine.rollbackAll();
      expect(engine.state).toEqual({ count: 0 });

      resolveA();
      resolveB();
      await promiseA.catch(() => {});
      await promiseB.catch(() => {});
    });

    it("rollbackAll during nested async spawn cancels children", async () => {
      const engine = setup();
      let resolveParent!: () => void;
      let resolveChild!: () => void;
      const pParent = new Promise<void>((r) => { resolveParent = r; });
      const pChild = new Promise<void>((r) => { resolveChild = r; });

      const promise = engine.run(async (tx) => {
        tx.dispatch({ type: "inc" });
        tx.spawn(async (child) => {
          child.dispatch({ type: "inc" });
          await pChild;
        });
        await pParent;
      }, { id: "parent" });

      expect(engine.state).toEqual({ count: 2 });

      engine.rollbackAll();
      expect(engine.state).toEqual({ count: 0 });

      resolveParent();
      resolveChild();
      await promise.catch(() => {});
    });

    it("allows new transactions after rollbackAll", async () => {
      const engine = setup();
      let resolve!: () => void;
      const p = new Promise<void>((r) => { resolve = r; });

      const promise = engine.run(async (tx) => {
        tx.dispatch({ type: "inc" });
        await p;
      }, { id: "old" });

      engine.rollbackAll();
      expect(engine.state).toEqual({ count: 0 });

      engine.dispatch({ type: "set", value: 42 });
      expect(engine.state).toEqual({ count: 42 });

      resolve();
      await promise.catch(() => {});
    });

    it("rollbackAll with mixed sync-committed and async-pending transactions", async () => {
      const engine = setup();
      engine.dispatch({ type: "inc" });

      const syncTx = engine.create({ id: "sync" });
      syncTx.dispatch({ type: "inc" });

      let resolve!: () => void;
      const p = new Promise<void>((r) => { resolve = r; });
      const promise = engine.run(async (tx) => {
        tx.dispatch({ type: "inc" });
        await p;
      }, { id: "async" });

      expect(engine.state).toEqual({ count: 3 });

      engine.rollbackAll();
      expect(engine.state).toEqual({ count: 1 });

      resolve();
      await promise.catch(() => {});
    });
  });

  describe("commitAll", () => {
    it("commits all active root transactions", () => {
      const engine = setup();
      const tx1 = engine.create({ id: "tx1" });
      const tx2 = engine.create({ id: "tx2" });

      tx1.dispatch({ type: "inc" });
      tx2.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 2 });

      engine.commitAll();
      expect(engine.state).toEqual({ count: 2 });
      expect(tx1.isStale()).toBe(true);
      expect(tx2.isStale()).toBe(true);
    });

    it("rolls back active child transactions before committing", async () => {
      const engine = setup();
      const tx = engine.create({ id: "parent" });
      tx.dispatch({ type: "inc" });
      let resolveChild: () => void;
      const childDone = new Promise<void>((r) => {
        resolveChild = r;
      });
      tx.spawn(async (child) => {
        child.dispatch({ type: "inc" });
        await childDone;
      });
      expect(engine.state).toEqual({ count: 2 });

      engine.commitAll();
      expect(engine.state).toEqual({ count: 1 });
      resolveChild!();
    });

    it("is a no-op when no active transactions exist", () => {
      const engine = setup();
      engine.dispatch({ type: "inc" });
      engine.commitAll();
      expect(engine.state).toEqual({ count: 1 });
    });

    it("allows normal dispatch after commitAll", () => {
      const engine = setup();
      const tx = engine.create({ id: "tx1" });
      tx.dispatch({ type: "inc" });
      engine.commitAll();

      engine.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 2 });
    });
  });
});
