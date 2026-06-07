import { useEffect, useRef, useState } from "react";
import {
  TransactionalReducer,
  type TransactionalReducerOptions,
} from "@transactional-reducer/core";

export {
  TransactionalReducer,
  type TransactionOptions,
  type TransactionHandle,
  type TransactionalReducerOptions,
  type OnErrorStrategy,
  type OnDuplicateStrategy,
  type ActionLogEntry,
} from "@transactional-reducer/core";

export function useTransactionalReducer<S, A>(
  reducer: (state: S, action: A) => S,
  initialState: S,
  options?: TransactionalReducerOptions<S>,
): [S, TransactionalReducer<S, A>] {
  const [state, setState] = useState(initialState);

  const engine = useRef<TransactionalReducer<S, A>>(
    new TransactionalReducer(reducer, initialState, options),
  );

  useEffect(() => engine.current.subscribe(setState), []);

  return [state, engine.current] as const;
}
