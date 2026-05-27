#!/usr/bin/env bash
set -euo pipefail

DIR="/workspaces/transactional-reducer/packages/core/test"
mkdir -p "$DIR"

cat > "$DIR/helpers.ts" << 'ENDOFFILE'
import {
  TransactionalReducer,
  type TransactionHandle,
  type TransactionOptions,
  type TransactionalReducerOptions,
  type OnDuplicateStrategy,
} from "../TransactionalReducer";

export type State = { count: number };
export type Action = { type: "inc" } | { type: "dec" } | { type: "set"; value: number };

export const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case "inc":
      return { count: state.count + 1 };
    case "dec":
      return { count: state.count - 1 };
    case "set":
      return { count: action.value };
  }
};

export const initialState: State = { count: 0 };

export function setup(options?: TransactionalReducerOptions<State>) {
  return new TransactionalReducer(reducer, initialState, options);
}

export function setupWithIdGenerator() {
  let counter = 0;
  return new TransactionalReducer(reducer, initialState, {
    idGenerator: () => `tx_${++counter}`,
  });
}

export function setupWithSnapshot() {
  return new TransactionalReducer(reducer, initialState, {
    snapshot: (s) => ({ count: s.count }),
  });
}

export function setupWithIdGeneratorAndOnDuplicate(onDuplicate: OnDuplicateStrategy) {
  let counter = 0;
  return new TransactionalReducer(reducer, initialState, {
    idGenerator: () => `tx_${++counter}`,
    onDuplicate,
  });
}

export { type TransactionHandle, type TransactionOptions as SpawnOptions };
ENDOFFILE

cat > "$DIR/basic.test.ts" << 'ENDOFFILE'
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
ENDOFFILE

cat > "$DIR/dispatch.test.ts" << 'ENDOFFILE'
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
ENDOFFILE

cat > "$DIR/start.test.ts" << 'ENDOFFILE'
import { describe, expect, it } from "vitest";
import { setup, type TransactionHandle } from "./helpers";
import type { Action } from "./helpers";

describe("TransactionalReducer", () => {
  describe("run", () => {
    it("auto-commits on sync success", () => {
      const engine = setup();
      engine.run((tx) => {
        tx.dispatch({ type: "inc" });
      });
      expect(engine.state).toEqual({ count: 1 });
    });

    it("auto-rollbacks on sync error", () => {
      const engine = setup();
      expect(() =>
        engine.run((tx) => {
          tx.dispatch({ type: "inc" });
          throw new Error("fail");
        }),
      ).toThrow("fail");
      expect(engine.state).toEqual({ count: 0 });
    });

    it("auto-commits on async success", async () => {
      const engine = setup();
      const ret = await engine.run(async (tx) => {
        tx.dispatch({ type: "inc" });
        return "done";
      });
      expect(engine.state).toEqual({ count: 1 });
      expect(ret).toBe("done");
    });

    it("auto-rollbacks on async error", async () => {
      const engine = setup();
      await expect(
        engine.run(async (tx) => {
          tx.dispatch({ type: "inc" });
          throw new Error("async-fail");
        }),
      ).rejects.toThrow("async-fail");
      expect(engine.state).toEqual({ count: 0 });
    });

    it("closure captures arguments for task function", () => {
      const engine = setup();
      engine.run((tx) => {
        tx.dispatch({ type: "set", value: 5 });
      });
      expect(engine.state).toEqual({ count: 5 });
    });

    it("with id option: calling while manual tx with same id is active rolls back that tx", () => {
      const engine = setup();
      const manualTx = engine.create({ id: "named" });
      manualTx.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 1 });

      engine.run((tx) => {
        tx.dispatch({ type: "dec" });
      }, { id: "named" });
      expect(engine.state).toEqual({ count: -1 });
    });

    it("with id option: different invocations with different ids coexist", () => {
      const engine = setup();
      engine.run((tx) => {
        tx.dispatch({ type: "inc" });
      }, { id: "task-a" });
      engine.run((tx) => {
        tx.dispatch({ type: "inc" });
      }, { id: "task-b" });
      expect(engine.state).toEqual({ count: 2 });
    });

    it("with onError: commit on sync error preserves changes", () => {
      const engine = setup();
      let thrownError: Error | undefined;
      try {
        engine.run((tx) => {
          tx.dispatch({ type: "inc" });
          throw new Error("fail");
        }, { onError: "commit" });
      } catch (e) {
        thrownError = e as Error;
      }
      expect(thrownError?.message).toBe("fail");
      expect(engine.state).toEqual({ count: 1 });
    });

    it("with onError: commit on async error preserves changes", async () => {
      const engine = setup();
      let thrownError: Error | undefined;
      try {
        await engine.run(async (tx) => {
          tx.dispatch({ type: "inc" });
          throw new Error("async-fail");
        }, { onError: "commit" });
      } catch (e) {
        thrownError = e as Error;
      }
      expect(thrownError?.message).toBe("async-fail");
      expect(engine.state).toEqual({ count: 1 });
    });
  });
});
ENDOFFILE

cat > "$DIR/commit.test.ts" << 'ENDOFFILE'
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
ENDOFFILE

cat > "$DIR/rollback.test.ts" << 'ENDOFFILE'
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
ENDOFFILE

cat > "$DIR/concurrent.test.ts" << 'ENDOFFILE'
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
ENDOFFILE

cat > "$DIR/create.test.ts" << 'ENDOFFILE'
import { describe, expect, it } from "vitest";
import { setup, setupWithIdGenerator, type TransactionHandle } from "./helpers";
import type { Action } from "./helpers";

describe("TransactionalReducer", () => {
  describe("create", () => {
    it("creates a transaction handle with correct id", () => {
      const engine = setupWithIdGenerator();
      const tx = engine.create();
      expect(tx.id).toBe("tx_1");
      expect(tx.parentId).toBeNull();
      expect(tx.onError).toBe("rollback");
    });

    it("creates transaction with custom id", () => {
      const engine = setup();
      const tx = engine.create({ id: "my-tx" });
      expect(tx.id).toBe("my-tx");
    });

    it("creates transaction with custom onError", () => {
      const engine = setup();
      const tx = engine.create({ id: "my-tx", onError: "commit" });
      expect(tx.onError).toBe("commit");
    });

    it("beginning transaction with same id rolls back existing active one", () => {
      const engine = setupWithIdGenerator();
      const tx1 = engine.create({ id: "same-id" });
      tx1.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 1 });

      const tx2 = engine.create({ id: "same-id" });
      expect(engine.state).toEqual({ count: 0 });
      tx2.dispatch({ type: "dec" });
      expect(engine.state).toEqual({ count: -1 });
    });

    it("getTransaction retrieves handle by id", () => {
      const engine = setupWithIdGenerator();
      engine.create({ id: "lookup-tx" });
      const retrieved = engine.getTransaction("lookup-tx");
      expect(retrieved?.id).toBe("lookup-tx");
      expect(retrieved?.parentId).toBeNull();
    });
  });
});
ENDOFFILE

cat > "$DIR/spawn.test.ts" << 'ENDOFFILE'
import { describe, expect, it } from "vitest";
import { setup, type TransactionHandle } from "./helpers";
import type { Action } from "./helpers";

describe("TransactionalReducer", () => {
  describe("spawn", () => {
    it("creates child transaction with correct parentId", () => {
      const engine = setup();
      const parent = engine.create({ id: "parent" });
      parent.spawn((tx) => {
        tx.dispatch({ type: "inc" });
      }, { id: "child" });
      const childHandle = engine.getTransaction("child");
      expect(childHandle?.parentId).toBe("parent");
      expect(childHandle?.id).toBe("child");
    });

    it("spawn inherits onError from options", () => {
      const engine = setup();
      const parent = engine.create({ id: "parent" });
      parent.spawn((tx) => {
        tx.dispatch({ type: "inc" });
      }, { id: "child", onError: "commit" });
      const childHandle = engine.getTransaction("child");
      expect(childHandle?.onError).toBe("commit");
    });

    it("spawn throws on inactive parent", () => {
      const engine = setup();
      const parent = engine.create({ id: "parent" });
      parent.commit();
      expect(() =>
        parent.spawn((tx) => {
          tx.dispatch({ type: "inc" });
        }, { id: "child" }),
      ).toThrow(/Cannot spawn from transaction "parent"/);
    });

    it("auto-commits child on sync success", () => {
      const engine = setup();
      const parent = engine.create({ id: "parent" });
      parent.dispatch({ type: "inc" });

      parent.spawn((tx) => {
        tx.dispatch({ type: "inc" });
      }, { id: "child" });

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
        parent.spawn((tx) => {
          tx.dispatch({ type: "inc" });
          throw new Error("child-fail");
        }, { id: "child" }),
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

      await parent.spawn(async (tx) => {
        tx.dispatch({ type: "inc" });
      }, { id: "child" });

      expect(engine.state).toEqual({ count: 2 });
      parent.commit();
      expect(engine.state).toEqual({ count: 2 });
    });

    it("auto-rollbacks child on async error", async () => {
      const engine = setup();
      const parent = engine.create({ id: "parent" });
      parent.dispatch({ type: "inc" });

      await expect(
        parent.spawn(async (tx) => {
          tx.dispatch({ type: "inc" });
          throw new Error("async-child-fail");
        }, { id: "child" }),
      ).rejects.toThrow("async-child-fail");

      expect(engine.state).toEqual({ count: 1 });
      parent.commit();
      expect(engine.state).toEqual({ count: 1 });
    });

    it("closure captures arguments for child task function", () => {
      const engine = setup();
      const parent = engine.create({ id: "parent" });
      parent.spawn((tx) => {
        tx.dispatch({ type: "set", value: 5 });
      }, { id: "child" });
      expect(engine.state).toEqual({ count: 5 });
    });

    it("with onError: commit on child sync error preserves child changes", () => {
      const engine = setup();
      const parent = engine.create({ id: "parent" });
      parent.dispatch({ type: "inc" });

      let thrownError: Error | undefined;
      try {
        parent.spawn((tx) => {
          tx.dispatch({ type: "inc" });
          throw new Error("child-fail");
        }, { id: "child", onError: "commit" });
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

      root.spawn((l1) => {
        l1.dispatch({ type: "inc" });
        l1.spawn((l2) => {
          l2.dispatch({ type: "inc" });
        }, { id: "l2" });
      }, { id: "l1" });

      expect(engine.state).toEqual({ count: 3 });
      root.commit();
      expect(engine.state).toEqual({ count: 3 });
    });
  });
});
ENDOFFILE

cat > "$DIR/onCancel.test.ts" << 'ENDOFFILE'
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

      engine.run(async (tx) => {
        tx.onCancel(onCancel);
        tx.dispatch({ type: "inc" });
        await firstPromise;
      }, { id: "search" });

      await Promise.resolve();
      expect(onCancel).not.toHaveBeenCalled();

      engine.run((tx) => {
        tx.dispatch({ type: "dec" });
      }, { id: "search" });

      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(engine.state).toEqual({ count: -1 });

      resolveFirst();
      try { await firstPromise; } catch { }
    });

    it("fires onCancel for child in rollbackSet when parent rolls back", () => {
      const engine = setup();
      const parentOnCancel = vi.fn();
      const childOnCancel = vi.fn();

      const parent = engine.create({ id: "parent" });
      parent.onCancel(parentOnCancel);
      parent.dispatch({ type: "inc" });

      parent.spawn((tx) => {
        tx.onCancel(childOnCancel);
        tx.dispatch({ type: "inc" });
      }, { id: "child", onError: "rollback" });

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

      parent.spawn((tx) => {
        tx.onCancel(childOnCancel);
        tx.dispatch({ type: "inc" });
      }, { id: "child", onError: "commit" });

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

      root.spawn((l1) => {
        l1.onCancel(l1Cb);
        l1.dispatch({ type: "inc" });
        l1.spawn((l2) => {
          l2.onCancel(l2Cb);
          l2.dispatch({ type: "inc" });
        }, { id: "l2", onError: "rollback" });
      }, { id: "l1", onError: "rollback" });

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

      const firstRunResult = engine.run(async (tx) => {
        tx.onCancel(() => ac.abort());
        tx.dispatch({ type: "inc" });
        await firstPromise;
      }, { id: "search" });

      await Promise.resolve();
      expect(ac.signal.aborted).toBe(false);

      engine.run((tx) => {
        tx.dispatch({ type: "dec" });
      }, { id: "search" });

      expect(ac.signal.aborted).toBe(true);
      expect(engine.state).toEqual({ count: -1 });

      resolveFirst();
      try { await firstRunResult; } catch { }
    });

    it("does NOT fire onCancel for committed child when parent auto-commits via run (sync)", () => {
      const engine = setup();
      const childOnCancel = vi.fn();

      engine.run((tx) => {
        tx.dispatch({ type: "inc" });
        tx.spawn((childTx) => {
          childTx.onCancel(childOnCancel);
          childTx.dispatch({ type: "inc" });
        }, { id: "child", onError: "rollback" });
      }, { id: "parent" });

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

      const parentRunResult = engine.run(async (tx) => {
        tx.dispatch({ type: "inc" });
        tx.spawn(async (childTx) => {
          childTx.onCancel(childOnCancel);
          childTx.dispatch({ type: "inc" });
          await childPromise;
        }, { id: "child", onError: "rollback" });
      }, { id: "parent" });

      try { await parentRunResult; } catch { }

      expect(childOnCancel).toHaveBeenCalledTimes(1);
      expect(engine.state).toEqual({ count: 1 });

      resolveChild();
      await Promise.resolve();
    });
  });
});
ENDOFFILE

cat > "$DIR/onDuplicate.test.ts" << 'ENDOFFILE'
import { describe, expect, it } from "vitest";
import { setupWithIdGenerator, setupWithIdGeneratorAndOnDuplicate, type TransactionHandle } from "./helpers";
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

      engine.run((tx) => {
        tx.dispatch({ type: "dec" });
      }, { id: "named" });
      expect(engine.state).toEqual({ count: -1 });
    });

    it("spawn with same id rolls back existing active async child transaction", async () => {
      const engine = setupWithIdGenerator();
      const parent = engine.create({ id: "parent" });

      let resolveChild!: () => void;
      const childPromise = parent.spawn(async (tx) => {
        tx.dispatch({ type: "inc" });
        await new Promise<void>((r) => { resolveChild = r; });
      }, { id: "child1" });
      await Promise.resolve();
      expect(engine.state).toEqual({ count: 1 });

      parent.spawn((tx) => {
        tx.dispatch({ type: "dec" });
      }, { id: "child1" });
      expect(engine.state).toEqual({ count: -1 });

      resolveChild();
      try { await childPromise; } catch { }
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
      const oldPromise = parent.spawn(async (tx) => {
        tx.dispatch({ type: "inc" });
        await new Promise<void>((r) => { resolveOld = r; });
      }, { id: "child" });
      await Promise.resolve();
      expect(engine.state).toEqual({ count: 1 });

      let resolveNew!: () => void;
      const newPromise = parent.spawn(async (tx) => {
        tx.dispatch({ type: "dec" });
        await new Promise<void>((r) => { resolveNew = r; });
      }, { id: "child", onDuplicate: "commit" });
      await Promise.resolve();
      expect(engine.state).toEqual({ count: 0 });

      resolveNew();
      try { await newPromise; } catch { }
      expect(engine.state).toEqual({ count: 0 });

      resolveOld();
      try { await oldPromise; } catch { }

      parent.rollback();
      expect(engine.state).toEqual({ count: 1 });
    });

    it("spawn with commit preserves old child's committed descendants when parent rolls back", async () => {
      const engine = setupWithIdGenerator();
      const parent = engine.create({ id: "parent" });

      let resolveOld!: () => void;
      const oldPromise = parent.spawn(async (tx) => {
        tx.dispatch({ type: "inc" });
        let resolveGrand!: () => void;
        const grandPromise = tx.spawn(async (gtx) => {
          gtx.dispatch({ type: "inc" });
          await new Promise<void>((r) => { resolveGrand = r; });
        }, { id: "grand", onError: "commit" });
        await Promise.resolve();
        resolveGrand!();
        try { await grandPromise; } catch { }
        await new Promise<void>((r) => { resolveOld = r; });
      }, { id: "child" });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(engine.state).toEqual({ count: 2 });

      let resolveNew!: () => void;
      const newPromise = parent.spawn(async (tx) => {
        tx.dispatch({ type: "dec" });
        await new Promise<void>((r) => { resolveNew = r; });
      }, { id: "child", onDuplicate: "commit" });
      await Promise.resolve();
      expect(engine.state).toEqual({ count: 1 });

      resolveNew!();
      try { await newPromise; } catch { }

      resolveOld!();
      try { await oldPromise; } catch { }

      parent.rollback();
      expect(engine.state).toEqual({ count: 2 });
    });

    it("spawn with commit rolls back old child's active descendants before committing", async () => {
      const engine = setupWithIdGenerator();
      const parent = engine.create({ id: "parent" });

      let resolveOld!: () => void;
      const oldPromise = parent.spawn(async (tx) => {
        tx.dispatch({ type: "inc" });
        tx.spawn(async (gtx) => {
          gtx.dispatch({ type: "inc" });
          await new Promise<void>(() => { });
        }, { id: "active-grand" });
        await Promise.resolve();
        expect(engine.state).toEqual({ count: 2 });
        await new Promise<void>((r) => { resolveOld = r; });
      }, { id: "child" });
      await Promise.resolve();
      await Promise.resolve();
      expect(engine.state).toEqual({ count: 2 });

      parent.spawn((tx) => {
        tx.dispatch({ type: "dec" });
      }, { id: "child", onDuplicate: "commit" });
      expect(engine.state).toEqual({ count: 0 });

      resolveOld!();
      try { await oldPromise; } catch { }

      parent.rollback();
      expect(engine.state).toEqual({ count: 1 });
    });

    it("create with commit replaces child transaction, preserving its actions on parent rollback", async () => {
      const engine = setupWithIdGenerator();
      const parent = engine.create({ id: "parent" });

      let resolveChild!: () => void;
      const childPromise = parent.spawn(async (tx) => {
        tx.dispatch({ type: "inc" });
        await new Promise<void>((r) => { resolveChild = r; });
      }, { id: "child" });
      await Promise.resolve();
      expect(engine.state).toEqual({ count: 1 });

      engine.create({ id: "child", onError: "rollback", onDuplicate: "commit" });
      expect(engine.state).toEqual({ count: 1 });

      resolveChild!();
      try { await childPromise; } catch { }

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
        engine.run((tx) => {
          tx.dispatch({ type: "inc" });
        }, { id: "named", onDuplicate: "reuse" }),
      ).toThrow(/already active/);
    });

    it("spawn with reuse throws when active async child transaction exists", async () => {
      const engine = setupWithIdGenerator();
      const parent = engine.create({ id: "parent" });

      let resolveChild!: () => void;
      const childPromise = parent.spawn(async (tx) => {
        tx.dispatch({ type: "inc" });
        await new Promise<void>((r) => { resolveChild = r; });
      }, { id: "child" });
      await Promise.resolve();

      expect(() =>
        parent.spawn((tx) => {
          tx.dispatch({ type: "inc" });
        }, { id: "child", onDuplicate: "reuse" }),
      ).toThrow(/already active/);

      resolveChild!();
      try { await childPromise; } catch { }
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
        engine.run((tx) => {
          tx.dispatch({ type: "inc" });
        }, { id: "named", onDuplicate: "reject" }),
      ).toThrow(/already active/);
    });

    it("spawn with reject throws when active async child transaction exists", async () => {
      const engine = setupWithIdGenerator();
      const parent = engine.create({ id: "parent" });

      let resolveChild!: () => void;
      const childPromise = parent.spawn(async (tx) => {
        tx.dispatch({ type: "inc" });
        await new Promise<void>((r) => { resolveChild = r; });
      }, { id: "child" });
      await Promise.resolve();

      expect(() =>
        parent.spawn((tx) => {
          tx.dispatch({ type: "inc" });
        }, { id: "child", onDuplicate: "reject" }),
      ).toThrow(/already active/);

      resolveChild!();
      try { await childPromise; } catch { }
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
        engine.run((tx) => {
          tx.dispatch({ type: "inc" });
        }, { id: "named" }),
      ).toThrow(/already active/);
    });
  });
});
ENDOFFILE

cat > "$DIR/onError-commit.test.ts" << 'ENDOFFILE'
import { describe, expect, it } from "vitest";
import { setup, type TransactionHandle } from "./helpers";
import type { Action } from "./helpers";

describe("TransactionalReducer", () => {
  describe("onError: commit boundary", () => {
    it("parent rollback preserves child with onError: commit", () => {
      const engine = setup();
      const parent = engine.create({ id: "parent" });
      parent.dispatch({ type: "inc" });

      parent.spawn((tx) => {
        tx.dispatch({ type: "inc" });
      }, { id: "child", onError: "commit" });

      expect(engine.state).toEqual({ count: 2 });

      parent.rollback();
      expect(engine.state).toEqual({ count: 1 });
    });

    it("parent rollback preserves child subtree with onError: commit", () => {
      const engine = setup();
      const parent = engine.create({ id: "parent" });
      parent.dispatch({ type: "inc" });

      parent.spawn((child) => {
        child.dispatch({ type: "inc" });
        child.spawn((gc) => {
          gc.dispatch({ type: "inc" });
        }, { id: "grandchild" });
      }, { id: "child", onError: "commit" });

      expect(engine.state).toEqual({ count: 3 });

      parent.rollback();
      expect(engine.state).toEqual({ count: 2 });
    });

    it("run rollback preserves spawned child with onError: commit", async () => {
      const engine = setup();
      let thrownError: Error | undefined;
      try {
        await engine.run(async (tx) => {
          tx.dispatch({ type: "inc" });
          await tx.spawn(async (childTx) => {
            childTx.dispatch({ type: "inc" });
          }, { id: "validate", onError: "commit" });
          throw new Error("submit-fail");
        }, { id: "submit", onError: "rollback" });
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

      parent.spawn((tx) => {
        tx.dispatch({ type: "inc" });
      }, { id: "child", onError: "rollback" });

      expect(engine.state).toEqual({ count: 2 });

      parent.rollback();
      expect(engine.state).toEqual({ count: 0 });
    });

    it("mixed onError: commit child preserved, rollback child undone on parent rollback", () => {
      const engine = setup();
      const parent = engine.create({ id: "parent" });
      parent.dispatch({ type: "inc" });

      parent.spawn((tx) => {
        tx.dispatch({ type: "inc" });
      }, { id: "commit-child", onError: "commit" });

      parent.spawn((tx) => {
        tx.dispatch({ type: "inc" });
      }, { id: "rollback-child", onError: "rollback" });

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
      const childPromise = new Promise<void>((r) => { resolveChild = r; });

      const spawnResult = parent.spawn(async (tx) => {
        tx.dispatch({ type: "inc" });
        await childPromise;
      }, { id: "child", onError: "commit" });

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
      try { await spawnResult; } catch { }
    });

    it("preserved async child subtree rollback after parent rollback", async () => {
      const engine = setup();
      const parent = engine.create({ id: "parent" });
      parent.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 1 });

      let resolveChild!: () => void;
      let resolveGrandchild!: () => void;
      const childPromise = new Promise<void>((r) => { resolveChild = r; });
      const gcPromise = new Promise<void>((r) => { resolveGrandchild = r; });

      const spawnResult = parent.spawn(async (childTx) => {
        childTx.dispatch({ type: "inc" });
        await childTx.spawn(async (gcTx) => {
          gcTx.dispatch({ type: "inc" });
          await gcPromise;
        }, { id: "grandchild" });
        await childPromise;
      }, { id: "child", onError: "commit" });

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
      try { await spawnResult; } catch { }
    });

    it("preserved async child dispatch + rollback after parent rollback", async () => {
      const engine = setup();
      const parent = engine.create({ id: "parent" });
      parent.dispatch({ type: "inc" });
      expect(engine.state).toEqual({ count: 1 });

      let resolveChild!: () => void;
      const childPromise = new Promise<void>((r) => { resolveChild = r; });

      const spawnResult = parent.spawn(async (tx) => {
        tx.dispatch({ type: "inc" });
        await childPromise;
      }, { id: "child", onError: "commit" });

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
      try { await spawnResult; } catch { }
    });
  });
});
ENDOFFILE

echo "Done. Created all files in $DIR/"
ls -la "$DIR"
