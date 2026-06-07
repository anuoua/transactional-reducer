# @transactional-reducer/react

A React Hook that adds transaction support to `useReducer`. It wraps the [`@transactional-reducer/core`](../core/README.md) engine in a React-friendly API.

> Core concepts (rollback algorithm, deduplication strategy, commit boundary, stale handle, etc.) are documented in detail in [`@transactional-reducer/core`](../core/README.md). This document covers only the React Hook usage.

## Installation

```bash
npm install @transactional-reducer/react @transactional-reducer/core
```

## Quick Start

```tsx
import { useTransactionalReducer } from "@transactional-reducer/react";

type State = { count: number };
type Action = { type: "inc" } | { type: "dec" };

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case "inc": return { count: state.count + 1 };
    case "dec": return { count: state.count - 1 };
  }
};

function Counter() {
  const [state, engine] = useTransactionalReducer(reducer, { count: 0 });

  // non-transactional dispatch — cannot be rolled back
  const handleInc = () => engine.dispatch({ type: "inc" });

  // transactional dispatch — can be rolled back
  const handleOptimisticInc = () =>
    engine.run(async (tx) => {
      tx.dispatch({ type: "inc" }); // optimistic update to UI
      await fetch("/api/inc");       // async request
      // success → auto-commit; failure → auto-rollback
    });

  return (
    <div>
      <p>Count: {state.count}</p>
      <button onClick={handleInc}>+1</button>
      <button onClick={handleOptimisticInc}>+1 (optimistic)</button>
    </div>
  );
}
```

---

## API Reference

### Signature

```ts
function useTransactionalReducer<S, A>(
  reducer: (state: S, action: A) => S,
  initialState: S,
  options?: TransactionalReducerOptions<S>,
): [S, TransactionalReducer<S, A>];
```

The second element of the tuple is a [`TransactionalReducer`](../core/README.md#transactionalreducer) engine instance — the same object used in framework-agnostic code. All engine methods are available:

- `engine.state` — current state (synchronous)
- `engine.dispatch(action)` — non-transactional dispatch
- `engine.run(task, options?)` — start a root transaction with automatic lifecycle management
- `engine.create(options?)` — manually create a root transaction
- `engine.getTransaction(id)` — find a transaction by ID
- `engine.commitAll()` — commit all active root transactions
- `engine.rollbackAll()` — roll back all active root transactions
- `engine.subscribe(listener)` — subscribe to state changes

Types such as `TransactionalReducerOptions`, `TransactionOptions`, and `TransactionHandle` are all exported from [`@transactional-reducer/core`](../core/README.md#api-reference).

### Return Value

Returns a tuple `[state, engine]`:

| Field | Type | Description |
|-------|------|-------------|
| `state` | `S` | Current state (driven by React's render cycle) |
| `engine` | `TransactionalReducer<S, A>` | The engine instance — access all methods directly |

### `engine.run(task, options?)`

Starts a root transaction with automatic lifecycle management. Behaves identically to [`engine.run()`](../core/README.md#engineruntask-options).

### `engine.create(options?)`

Manually creates a root transaction. Behaves identically to [`engine.create()`](../core/README.md#enginecreateoptions).

### `engine.state`

Returns the engine's instantaneous state. React state updates may be batched or deferred, so `state` (the first tuple element) might be stale inside async callbacks. `engine.state` always returns the most up-to-date value.

```tsx
await engine.run(async (tx) => {
  tx.dispatch({ type: "inc" });
  // state.count may still be the old value (React batching)
  const currentCount = engine.state.count; // latest value
  tx.dispatch({ type: "set", value: currentCount * 2 });
});
```

### `engine.getTransaction(id)`

Finds a transaction by ID. Equivalent to [`engine.getTransaction()`](../core/README.md#enginegettransactionid).

---

## Usage Guide

### 1. Optimistic Update + Auto-Rollback

```tsx
async function handleSave() {
  await engine.run(async (tx) => {
    tx.dispatch({ type: "setSaving", value: true });
    tx.dispatch({ type: "updateData", value: newData });
    await saveToServer(newData);
    // success → auto-commit; failure → auto-rollback
  });
}
```

### 2. Cancellable Async Tasks

Assign an `id` to a transaction; a new transaction with the same ID will automatically cancel the old one ([deduplication strategy](../core/README.md#deduplication--onduplicate-strategy)):

```tsx
async function handleSearch(query: string) {
  await engine.run(async (tx) => {
    const ac = new AbortController();
    tx.onCancel(() => ac.abort());
    tx.dispatch({ type: "setLoading", value: true });
    const results = await fetchResults(query, { signal: ac.signal });
    tx.dispatch({ type: "setResults", value: results });
  }, { id: "search" });
}
```

### 3. Manual Transaction Lifecycle Management

```tsx
function EditForm() {
  const [state, engine] = useTransactionalReducer(reducer, initialState);
  const txRef = useRef<TransactionHandle<Action>>();

  const startEditing = () => {
    txRef.current = engine.create({ id: "edit-form" });
  };

  const updateField = (field: string, value: string) => {
    txRef.current?.dispatch({ type: "updateField", field, value });
  };

  const save = async () => {
    try {
      await saveProfile(engine.state);
      txRef.current?.commit();
    } catch {
      txRef.current?.rollback();
    }
  };

  const cancel = () => {
    txRef.current?.rollback();
  };
}
```

### 4. Nested Transactions (spawn)

```tsx
await engine.run(async (tx) => {
  tx.dispatch({ type: "setSubmitting", value: true });

  await tx.spawn(async (childTx) => {
    childTx.dispatch({ type: "setValidating", value: true });
    const isValid = await validateForm();
    if (!isValid) throw new Error("validation failed");
  }, { id: "validate" });

  await submitForm();
  tx.dispatch({ type: "setSubmitting", value: false });
}, { id: "submit" });
```

### 5. Concurrent Transactions

```tsx
const [result1, result2] = await Promise.all([
  engine.run(async (tx) => {
    tx.dispatch({ type: "setUsersLoading", value: true });
    const users = await fetchUsers();
    tx.dispatch({ type: "setUsers", value: users });
  }, { id: "fetch-users" }),
  engine.run(async (tx) => {
    tx.dispatch({ type: "setPostsLoading", value: true });
    const posts = await fetchPosts();
    tx.dispatch({ type: "setPosts", value: posts });
  }, { id: "fetch-posts" }),
]);
```

---

## Learn More

- **Core concepts** (rollback algorithm, generation mechanism, deduplication strategy, commit boundary, onCancel, etc.): See [`@transactional-reducer/core`](../core/README.md#core-mechanics)
- **Common scenarios** (search auto-cancel, multi-step commit + partial retain): See [`@transactional-reducer/core`](../core/README.md#common-scenarios)
- **Caveats**: See [`@transactional-reducer/core`](../core/README.md#caveats)

---

## React-Specific Notes

1. **React batching**: Inside async callbacks, React's `state` may not be up to date. Use `engine.state` to get the instantaneous state.

2. **Engine stability**: The `engine` reference is stable throughout the component's lifecycle (backed by `useRef`), so it can safely be omitted from `useEffect`/`useCallback` dependency arrays.

3. **Component isolation**: Each component instance holds an independent engine instance; state is not shared across components.
