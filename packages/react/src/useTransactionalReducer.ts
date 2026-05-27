import { useEffect, useMemo, useRef, useState } from "react"
import {
  TransactionalReducer,
  type TransactionOptions,
  type TransactionHandle,
  type TransactionalReducerOptions,
} from "@transactional-reducer/core"

export {
  type TransactionOptions,
  type TransactionHandle,
  type TransactionalReducerOptions,
  type OnErrorStrategy,
  type OnDuplicateStrategy,
  type ActionLogEntry,
  TransactionalReducer,
} from "@transactional-reducer/core"

export function useTransactionalReducer<S, A>(
  reducer: (state: S, action: A) => S,
  initialState: S,
  options?: TransactionalReducerOptions<S>,
): [
  S,
  {
    dispatch: (action: A) => void
    run<R>(task: (tx: TransactionHandle<A>) => R, options?: TransactionOptions): R
    create(options?: TransactionOptions): TransactionHandle<A>
    getDraft(): S
    getTransaction(id: string): TransactionHandle<A> | undefined
  },
] {
  const [state, setState] = useState(initialState)

  const engine = useRef<TransactionalReducer<S, A> | null>(new TransactionalReducer(reducer, initialState, options))

  useEffect(
    () => engine.current!.subscribe(setState),
    [],
  )

  const api = useMemo(
    () => ({
      dispatch: (action: A) => engine.current!.dispatch(action),
      run: <R,>(task: (tx: TransactionHandle<A>) => R, opts?: TransactionOptions) =>
        engine.current!.run(task, opts),
      create: (opts?: TransactionOptions) => engine.current!.create(opts),
      getDraft: () => engine.current!.state,
      getTransaction: (id: string) => engine.current!.getTransaction(id),
    }),
    [],
  )

  return [state, api] as const
}
