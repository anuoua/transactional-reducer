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

      engine.run(
        (tx) => {
          tx.dispatch({ type: "dec" });
        },
        { id: "named" },
      );
      expect(engine.state).toEqual({ count: -1 });
    });

    it("with id option: different invocations with different ids coexist", () => {
      const engine = setup();
      engine.run(
        (tx) => {
          tx.dispatch({ type: "inc" });
        },
        { id: "task-a" },
      );
      engine.run(
        (tx) => {
          tx.dispatch({ type: "inc" });
        },
        { id: "task-b" },
      );
      expect(engine.state).toEqual({ count: 2 });
    });

    it("with onError: commit on sync error preserves changes", () => {
      const engine = setup();
      let thrownError: Error | undefined;
      try {
        engine.run(
          (tx) => {
            tx.dispatch({ type: "inc" });
            throw new Error("fail");
          },
          { onError: "commit" },
        );
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
        await engine.run(
          async (tx) => {
            tx.dispatch({ type: "inc" });
            throw new Error("async-fail");
          },
          { onError: "commit" },
        );
      } catch (e) {
        thrownError = e as Error;
      }
      expect(thrownError?.message).toBe("async-fail");
      expect(engine.state).toEqual({ count: 1 });
    });
  });
});
