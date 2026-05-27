import { describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTransactionalReducer } from "../src/useTransactionalReducer";

type State = { count: number };
type Action = { type: "inc" } | { type: "dec" } | { type: "set"; value: number };

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case "inc":
      return { count: state.count + 1 };
    case "dec":
      return { count: state.count - 1 };
    case "set":
      return { count: action.value };
  }
};

const initialState: State = { count: 0 };

describe("useTransactionalReducer", () => {
  describe("basic dispatch", () => {
    it("returns initial state", () => {
      const { result } = renderHook(() => useTransactionalReducer(reducer, initialState));
      expect(result.current[0]).toEqual({ count: 0 });
    });

    it("dispatches actions and updates state", () => {
      const { result } = renderHook(() => useTransactionalReducer(reducer, initialState));

      act(() => {
        result.current[1].dispatch({ type: "inc" });
      });
      expect(result.current[0]).toEqual({ count: 1 });

      act(() => {
        result.current[1].dispatch({ type: "inc" });
      });
      expect(result.current[0]).toEqual({ count: 2 });
    });

    it("dispatches dec action", () => {
      const { result } = renderHook(() => useTransactionalReducer(reducer, initialState));

      act(() => {
        result.current[1].dispatch({ type: "dec" });
      });
      expect(result.current[0]).toEqual({ count: -1 });
    });

    it("dispatches set action", () => {
      const { result } = renderHook(() => useTransactionalReducer(reducer, initialState));

      act(() => {
        result.current[1].dispatch({ type: "set", value: 42 });
      });
      expect(result.current[0]).toEqual({ count: 42 });
    });
  });

  describe("getDraft", () => {
    it("returns current draft state", () => {
      const { result } = renderHook(() => useTransactionalReducer(reducer, initialState));

      expect(result.current[1].getDraft()).toEqual({ count: 0 });

      act(() => {
        result.current[1].dispatch({ type: "inc" });
      });
      expect(result.current[1].getDraft()).toEqual({ count: 1 });
    });
  });

  describe("run (synchronous transaction)", () => {
    it("commits successful transaction", () => {
      const { result } = renderHook(() => useTransactionalReducer(reducer, initialState));

      act(() => {
        result.current[1].run((tx) => {
          tx.dispatch({ type: "inc" });
          tx.dispatch({ type: "inc" });
        });
      });

      expect(result.current[0]).toEqual({ count: 2 });
    });

    it("rolls back on error by default", () => {
      const { result } = renderHook(() => useTransactionalReducer(reducer, initialState));

      act(() => {
        try {
          result.current[1].run((tx) => {
            tx.dispatch({ type: "inc" });
            throw new Error("fail");
          });
        } catch {}
      });

      expect(result.current[0]).toEqual({ count: 0 });
    });

    it("commits on error when onError is commit", () => {
      const { result } = renderHook(() => useTransactionalReducer(reducer, initialState));

      act(() => {
        try {
          result.current[1].run(
            (tx) => {
              tx.dispatch({ type: "inc" });
              throw new Error("fail");
            },
            { onError: "commit" },
          );
        } catch {}
      });

      expect(result.current[0]).toEqual({ count: 1 });
    });

    it("returns the task result", () => {
      const { result } = renderHook(() => useTransactionalReducer(reducer, initialState));

      let returnValue: string | undefined;
      act(() => {
        returnValue = result.current[1].run(() => "hello");
      });

      expect(returnValue).toBe("hello");
    });

    it("preserves non-tx dispatch during transaction rollback", () => {
      const { result } = renderHook(() => useTransactionalReducer(reducer, initialState));

      act(() => {
        result.current[1].dispatch({ type: "inc" });
        try {
          result.current[1].run((tx) => {
            tx.dispatch({ type: "inc" });
            throw new Error("fail");
          });
        } catch {}
      });

      expect(result.current[0]).toEqual({ count: 1 });
    });
  });

  describe("create + manual commit/rollback", () => {
    it("creates a transaction and commits it", () => {
      const { result } = renderHook(() => useTransactionalReducer(reducer, initialState));

      act(() => {
        const tx = result.current[1].create();
        tx.dispatch({ type: "inc" });
        tx.commit();
      });

      expect(result.current[0]).toEqual({ count: 1 });
    });

    it("creates a transaction and rolls it back", () => {
      const { result } = renderHook(() => useTransactionalReducer(reducer, initialState));

      act(() => {
        const tx = result.current[1].create();
        tx.dispatch({ type: "inc" });
        tx.dispatch({ type: "inc" });
        tx.rollback();
      });

      expect(result.current[0]).toEqual({ count: 0 });
    });

    it("creates a transaction with custom id", () => {
      const { result } = renderHook(() => useTransactionalReducer(reducer, initialState));

      act(() => {
        const tx = result.current[1].create({ id: "my-tx" });
        tx.dispatch({ type: "inc" });
        tx.commit();
      });

      expect(result.current[0]).toEqual({ count: 1 });
    });
  });

  describe("getTransaction", () => {
    it("returns a created transaction by id", () => {
      const { result } = renderHook(() => useTransactionalReducer(reducer, initialState));

      act(() => {
        result.current[1].create({ id: "tx-1" });
      });

      const tx = result.current[1].getTransaction("tx-1");
      expect(tx).toBeDefined();
      expect(tx!.id).toBe("tx-1");
    });

    it("returns undefined for unknown id", () => {
      const { result } = renderHook(() => useTransactionalReducer(reducer, initialState));

      expect(result.current[1].getTransaction("nonexistent")).toBeUndefined();
    });

    it("returns undefined after transaction is committed", () => {
      const { result } = renderHook(() => useTransactionalReducer(reducer, initialState));

      act(() => {
        const tx = result.current[1].create({ id: "tx-1" });
        tx.dispatch({ type: "inc" });
        tx.commit();
      });

      expect(result.current[1].getTransaction("tx-1")).toBeUndefined();
    });
  });

  describe("state reactivity", () => {
    it("state updates trigger re-renders", () => {
      const { result } = renderHook(() => useTransactionalReducer(reducer, initialState));

      expect(result.current[0]).toEqual({ count: 0 });

      act(() => {
        result.current[1].dispatch({ type: "inc" });
      });
      expect(result.current[0]).toEqual({ count: 1 });

      act(() => {
        result.current[1].dispatch({ type: "inc" });
      });
      expect(result.current[0]).toEqual({ count: 2 });
    });

    it("transaction rollback reverts state", () => {
      const { result } = renderHook(() => useTransactionalReducer(reducer, initialState));

      act(() => {
        result.current[1].dispatch({ type: "inc" });
      });
      expect(result.current[0]).toEqual({ count: 1 });

      act(() => {
        const tx = result.current[1].create();
        tx.dispatch({ type: "inc" });
        tx.dispatch({ type: "inc" });
        tx.rollback();
      });
      expect(result.current[0]).toEqual({ count: 1 });
    });

    it("transaction commit preserves state changes", () => {
      const { result } = renderHook(() => useTransactionalReducer(reducer, initialState));

      act(() => {
        result.current[1].dispatch({ type: "inc" });
      });
      expect(result.current[0]).toEqual({ count: 1 });

      act(() => {
        const tx = result.current[1].create();
        tx.dispatch({ type: "inc" });
        tx.dispatch({ type: "inc" });
        tx.commit();
      });
      expect(result.current[0]).toEqual({ count: 3 });
    });
  });

  describe("options", () => {
    it("accepts custom snapshot function", () => {
      const { result } = renderHook(() =>
        useTransactionalReducer(reducer, initialState, {
          snapshot: (s) => ({ count: s.count }),
        }),
      );

      act(() => {
        const tx = result.current[1].create();
        tx.dispatch({ type: "inc" });
        tx.rollback();
      });

      expect(result.current[0]).toEqual({ count: 0 });
    });

    it("accepts custom idGenerator", () => {
      let counter = 0;
      const { result } = renderHook(() =>
        useTransactionalReducer(reducer, initialState, {
          idGenerator: () => `custom_${++counter}`,
        }),
      );

      act(() => {
        result.current[1].create();
      });

      const tx = result.current[1].getTransaction("custom_1");
      expect(tx).toBeDefined();
      expect(tx!.id).toBe("custom_1");
    });
  });

  describe("multiple transactions", () => {
    it("manages multiple concurrent transactions", () => {
      const { result } = renderHook(() => useTransactionalReducer(reducer, initialState));

      act(() => {
        const tx1 = result.current[1].create({ id: "tx1" });
        const tx2 = result.current[1].create({ id: "tx2" });

        tx1.dispatch({ type: "inc" });
        tx2.dispatch({ type: "inc" });

        tx1.commit();
        tx2.rollback();
      });

      expect(result.current[0]).toEqual({ count: 1 });
    });

    it("interleaved dispatch and transactions", () => {
      const { result } = renderHook(() => useTransactionalReducer(reducer, initialState));

      act(() => {
        result.current[1].dispatch({ type: "inc" });
        const tx = result.current[1].create();
        tx.dispatch({ type: "inc" });
        tx.rollback();
        result.current[1].dispatch({ type: "inc" });
      });

      expect(result.current[0]).toEqual({ count: 2 });
    });
  });

  describe("nested transactions via run", () => {
    it("nested run creates child transactions", () => {
      const { result } = renderHook(() =>
        useTransactionalReducer(reducer, initialState, {
          idGenerator: () => `tx_${Date.now()}_${Math.random()}`,
        }),
      );

      act(() => {
        result.current[1].run((tx) => {
          tx.dispatch({ type: "inc" });
          tx.spawn((childTx) => {
            childTx.dispatch({ type: "inc" });
          });
        });
      });

      expect(result.current[0]).toEqual({ count: 2 });
    });

    it("child rollback does not affect parent", () => {
      const { result } = renderHook(() => useTransactionalReducer(reducer, initialState));

      act(() => {
        const tx = result.current[1].create({ id: "parent" });
        tx.dispatch({ type: "inc" });
        tx.spawn(
          (childTx) => {
            childTx.dispatch({ type: "inc" });
            childTx.rollback();
          },
          { id: "child" },
        );
      });

      expect(result.current[0]).toEqual({ count: 1 });
    });
  });

  describe("api stability", () => {
    it("api object reference is stable across renders", () => {
      const { result, rerender } = renderHook(() => useTransactionalReducer(reducer, initialState));

      const firstApi = result.current[1];
      rerender();
      const secondApi = result.current[1];
      expect(firstApi).toBe(secondApi);
    });

    it("dispatch function is stable across renders", () => {
      const { result, rerender } = renderHook(() => useTransactionalReducer(reducer, initialState));

      const firstDispatch = result.current[1].dispatch;
      rerender();
      const secondDispatch = result.current[1].dispatch;
      expect(firstDispatch).toBe(secondDispatch);
    });
  });

  describe("subscription cleanup", () => {
    it("unsubscribes on unmount", () => {
      const { result, unmount } = renderHook(() => useTransactionalReducer(reducer, initialState));

      expect(result.current[0]).toEqual({ count: 0 });

      act(() => {
        result.current[1].dispatch({ type: "inc" });
      });
      expect(result.current[0]).toEqual({ count: 1 });

      unmount();
    });
  });
});
