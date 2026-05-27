import {
  TransactionalReducer,
  type TransactionHandle,
  type TransactionOptions,
  type TransactionalReducerOptions,
  type OnDuplicateStrategy,
} from "../src/TransactionalReducer";

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
