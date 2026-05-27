import { describe, expect, it } from "vitest";
import {
  setupWithIdGenerator,
  setupWithIdGeneratorAndOnDuplicate,
  type TransactionHandle,
} from "./helpers";
import type { Action } from "./helpers";

describe("TransactionalReducer", () => {
  describe("onDuplicate: rollback (default)", () => {
    it("create with same id rolls back existing active transaction", () => {
      const engine = setupWithIdGenerator();
      const tx1 = engine.create({ id: "same-id" });
      tx1.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 1 });

      const tx2 = engine.create({ id: "same-id" });
      expect(engine.state).toEqual({ count: 0 });
      expect(tx1.isStale()).toBe(true);
      tx2.dispatch({ type: "dec" });
      expect(engine.state).toEqual({ count: -1 });
    });

    it("run with same id rolls back existing active transaction", () => {
      const engine = setupWithIdGenerator();
      const manualTx = engine.create({ id: "named" });
      manualTx.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 1 });

      engine.run(
        (tx) => {
          tx.dispatch({ type: "dec" });
        },
        { id: "named" },
      );
      expect(engine.state).toEqual({ count: -1 });
    });

    it("spawn with same id rolls back existing active async child transaction", async () => {
      const engine = setupWithIdGenerator();
      const parent = engine.create({ id: "parent" });

      let resolveChild!: () => void;
      const childPromise = parent.spawn(
        async (tx) => {
          tx.dispatch({ type: "inc" });
          await new Promise<void>((r) => {
            resolveChild = r;
          });
        },
        { id: "child1" },
      );
      await Promise.resolve();
      expect(engine.state).toEqual({ count: 1 });

      parent.spawn(
        (tx) => {
          tx.dispatch({ type: "dec" });
        },
        { id: "child1" },
      );
      expect(engine.state).toEqual({ count: -1 });

      resolveChild();
      try {
        await childPromise;
      } catch {}
    });

    it("explicit onDuplicate:'rollback' behaves same as default", () => {
      const engine = setupWithIdGenerator();
      const tx1 = engine.create({ id: "same-id" });
      tx1.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 1 });

      engine.create({ id: "same-id", onError: "rollback", onDuplicate: "rollback" });
      expect(engine.state).toEqual({ count: 0 });
      expect(tx1.isStale()).toBe(true);
    });
  });

  describe("onDuplicate: commit", () => {
    it("create with same id commits existing active transaction", () => {
      const engine = setupWithIdGenerator();
      const tx1 = engine.create({ id: "same-id" });
      tx1.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 1 });

      engine.create({ id: "same-id", onError: "rollback", onDuplicate: "commit" });
      expect(engine.state).toEqual({ count: 1 });
      expect(tx1.isStale()).toBe(true);
    });

    it("spawn with commit preserves old child's actions when parent rolls back", async () => {
      const engine = setupWithIdGenerator();
      const parent = engine.create({ id: "parent" });

      let resolveOld!: () => void;
      const oldPromise = parent.spawn(
        async (tx) => {
          tx.dispatch({ type: "inc" });
          await new Promise<void>((r) => {
            resolveOld = r;
          });
        },
        { id: "child" },
      );
      await Promise.resolve();
      expect(engine.state).toEqual({ count: 1 });

      let resolveNew!: () => void;
      const newPromise = parent.spawn(
        async (tx) => {
          tx.dispatch({ type: "dec" });
          await new Promise<void>((r) => {
            resolveNew = r;
          });
        },
        { id: "child", onDuplicate: "commit" },
      );
      await Promise.resolve();
      expect(engine.state).toEqual({ count: 0 });

      resolveNew();
      try {
        await newPromise;
      } catch {}
      expect(engine.state).toEqual({ count: 0 });

      resolveOld();
      try {
        await oldPromise;
      } catch {}

      parent.rollback();
      expect(engine.state).toEqual({ count: 1 });
    });

    it("spawn with commit preserves old child's committed descendants when parent rolls back", async () => {
      const engine = setupWithIdGenerator();
      const parent = engine.create({ id: "parent" });

      let resolveOld!: () => void;
      const oldPromise = parent.spawn(
        async (tx) => {
          tx.dispatch({ type: "inc" });
          let resolveGrand!: () => void;
          const grandPromise = tx.spawn(
            async (gtx) => {
              gtx.dispatch({ type: "inc" });
              await new Promise<void>((r) => {
                resolveGrand = r;
              });
            },
            { id: "grand", onError: "commit" },
          );
          await Promise.resolve();
          resolveGrand!();
          try {
            await grandPromise;
          } catch {}
          await new Promise<void>((r) => {
            resolveOld = r;
          });
        },
        { id: "child" },
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(engine.state).toEqual({ count: 2 });

      let resolveNew!: () => void;
      const newPromise = parent.spawn(
        async (tx) => {
          tx.dispatch({ type: "dec" });
          await new Promise<void>((r) => {
            resolveNew = r;
          });
        },
        { id: "child", onDuplicate: "commit" },
      );
      await Promise.resolve();
      expect(engine.state).toEqual({ count: 1 });

      resolveNew!();
      try {
        await newPromise;
      } catch {}

      resolveOld!();
      try {
        await oldPromise;
      } catch {}

      parent.rollback();
      expect(engine.state).toEqual({ count: 2 });
    });

    it("spawn with commit rolls back old child's active descendants before committing", async () => {
      const engine = setupWithIdGenerator();
      const parent = engine.create({ id: "parent" });

      let resolveOld!: () => void;
      const oldPromise = parent.spawn(
        async (tx) => {
          tx.dispatch({ type: "inc" });
          tx.spawn(
            async (gtx) => {
              gtx.dispatch({ type: "inc" });
              await new Promise<void>(() => {});
            },
            { id: "active-grand" },
          );
          await Promise.resolve();
          expect(engine.state).toEqual({ count: 2 });
          await new Promise<void>((r) => {
            resolveOld = r;
          });
        },
        { id: "child" },
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(engine.state).toEqual({ count: 2 });

      parent.spawn(
        (tx) => {
          tx.dispatch({ type: "dec" });
        },
        { id: "child", onDuplicate: "commit" },
      );
      expect(engine.state).toEqual({ count: 0 });

      resolveOld!();
      try {
        await oldPromise;
      } catch {}

      parent.rollback();
      expect(engine.state).toEqual({ count: 1 });
    });

    it("create with commit replaces child transaction, preserving its actions on parent rollback", async () => {
      const engine = setupWithIdGenerator();
      const parent = engine.create({ id: "parent" });

      let resolveChild!: () => void;
      const childPromise = parent.spawn(
        async (tx) => {
          tx.dispatch({ type: "inc" });
          await new Promise<void>((r) => {
            resolveChild = r;
          });
        },
        { id: "child" },
      );
      await Promise.resolve();
      expect(engine.state).toEqual({ count: 1 });

      engine.create({ id: "child", onError: "rollback", onDuplicate: "commit" });
      expect(engine.state).toEqual({ count: 1 });

      resolveChild!();
      try {
        await childPromise;
      } catch {}

      parent.rollback();
      expect(engine.state).toEqual({ count: 1 });
    });
  });

  describe("onDuplicate: reuse", () => {
    it("create with same id returns existing active transaction", () => {
      const engine = setupWithIdGenerator();
      const tx1 = engine.create({ id: "same-id" });
      tx1.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 1 });

      const tx2 = engine.create({ id: "same-id", onError: "rollback", onDuplicate: "reuse" });
      expect(tx2).toBe(tx1);
      expect(engine.state).toEqual({ count: 1 });
      expect(tx1.isStale()).toBe(false);
    });

    it("create with reuse and no existing transaction creates new one", () => {
      const engine = setupWithIdGenerator();
      const tx = engine.create({ id: "new-id", onError: "rollback", onDuplicate: "reuse" });
      expect(tx.id).toBe("new-id");
      tx.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 1 });
    });

    it("create with reuse on committed transaction creates new one", () => {
      const engine = setupWithIdGenerator();
      const tx1 = engine.create({ id: "same-id" });
      tx1.dispatch({ type: "inc" });
      tx1.commit();

      const tx2 = engine.create({ id: "same-id", onError: "rollback", onDuplicate: "reuse" });
      expect(tx2).not.toBe(tx1);
      expect(engine.state).toEqual({ count: 1 });
    });

    it("run with reuse throws when active transaction exists", () => {
      const engine = setupWithIdGenerator();
      engine.create({ id: "named" });

      expect(() =>
        engine.run(
          (tx) => {
            tx.dispatch({ type: "inc" });
          },
          { id: "named", onDuplicate: "reuse" },
        ),
      ).toThrow(/already active/);
    });

    it("spawn with reuse throws when active async child transaction exists", async () => {
      const engine = setupWithIdGenerator();
      const parent = engine.create({ id: "parent" });

      let resolveChild!: () => void;
      const childPromise = parent.spawn(
        async (tx) => {
          tx.dispatch({ type: "inc" });
          await new Promise<void>((r) => {
            resolveChild = r;
          });
        },
        { id: "child" },
      );
      await Promise.resolve();

      expect(() =>
        parent.spawn(
          (tx) => {
            tx.dispatch({ type: "inc" });
          },
          { id: "child", onDuplicate: "reuse" },
        ),
      ).toThrow(/already active/);

      resolveChild!();
      try {
        await childPromise;
      } catch {}
    });

    it("reuse without id creates new transaction (no target to reuse)", () => {
      const engine = setupWithIdGenerator();
      const tx = engine.create({ onError: "rollback", onDuplicate: "reuse" });
      expect(tx.id).toBeTruthy();
      tx.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 1 });
    });
  });

  describe("onDuplicate: reject", () => {
    it("create with same id throws when active transaction exists", () => {
      const engine = setupWithIdGenerator();
      const tx1 = engine.create({ id: "same-id" });
      tx1.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 1 });

      expect(() =>
        engine.create({ id: "same-id", onError: "rollback", onDuplicate: "reject" }),
      ).toThrow(/already active/);
      expect(engine.state).toEqual({ count: 1 });
      expect(tx1.isStale()).toBe(false);
    });

    it("run with same id throws when active transaction exists", () => {
      const engine = setupWithIdGenerator();
      engine.create({ id: "named" });

      expect(() =>
        engine.run(
          (tx) => {
            tx.dispatch({ type: "inc" });
          },
          { id: "named", onDuplicate: "reject" },
        ),
      ).toThrow(/already active/);
    });

    it("spawn with reject throws when active async child transaction exists", async () => {
      const engine = setupWithIdGenerator();
      const parent = engine.create({ id: "parent" });

      let resolveChild!: () => void;
      const childPromise = parent.spawn(
        async (tx) => {
          tx.dispatch({ type: "inc" });
          await new Promise<void>((r) => {
            resolveChild = r;
          });
        },
        { id: "child" },
      );
      await Promise.resolve();

      expect(() =>
        parent.spawn(
          (tx) => {
            tx.dispatch({ type: "inc" });
          },
          { id: "child", onDuplicate: "reject" },
        ),
      ).toThrow(/already active/);

      resolveChild!();
      try {
        await childPromise;
      } catch {}
    });

    it("reject with no existing transaction creates new one normally", () => {
      const engine = setupWithIdGenerator();
      const tx = engine.create({ id: "new-id", onError: "rollback", onDuplicate: "reject" });
      expect(tx.id).toBe("new-id");
      tx.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 1 });
    });
  });

  describe("onDuplicate: global default", () => {
    it("global onDuplicate:'reject' applies to create", () => {
      const engine = setupWithIdGeneratorAndOnDuplicate("reject");
      const tx1 = engine.create({ id: "same-id" });
      tx1.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 1 });

      expect(() => engine.create({ id: "same-id" })).toThrow(/already active/);
    });

    it("global onDuplicate:'reuse' applies to create", () => {
      const engine = setupWithIdGeneratorAndOnDuplicate("reuse");
      const tx1 = engine.create({ id: "same-id" });
      tx1.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 1 });

      const tx2 = engine.create({ id: "same-id" });
      expect(tx2).toBe(tx1);
    });

    it("global onDuplicate:'commit' applies to create", () => {
      const engine = setupWithIdGeneratorAndOnDuplicate("commit");
      const tx1 = engine.create({ id: "same-id" });
      tx1.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 1 });

      const tx2 = engine.create({ id: "same-id" });
      expect(engine.state).toEqual({ count: 1 });
      tx2.dispatch({ type: "dec" });
      expect(engine.state).toEqual({ count: 0 });
    });

    it("per-call onDuplicate overrides global default", () => {
      const engine = setupWithIdGeneratorAndOnDuplicate("reject");
      const tx1 = engine.create({ id: "same-id" });
      tx1.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 1 });

      engine.create({ id: "same-id", onError: "rollback", onDuplicate: "rollback" });
      expect(engine.state).toEqual({ count: 0 });
      expect(tx1.isStale()).toBe(true);
    });

    it("global onDuplicate:'reuse' makes run throw when active transaction exists", () => {
      const engine = setupWithIdGeneratorAndOnDuplicate("reuse");
      engine.create({ id: "named" });

      expect(() =>
        engine.run(
          (tx) => {
            tx.dispatch({ type: "inc" });
          },
          { id: "named" },
        ),
      ).toThrow(/already active/);
    });
  });
});
