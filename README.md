# transactional-reducer

A state management library that adds **transaction** support to the reducer pattern. It lets you wrap a group of dispatch operations in a transaction with **commit** and **rollback** semantics — just like database transactions.

## Features

- **Optimistic updates with automatic rollback**: Optimistically update state first; changes are automatically reverted if the async operation fails
- **Cancellable async tasks**: A new transaction with the same ID automatically cancels the previous one, preventing race conditions
- **Flexible deduplication strategies**: Four strategies — `rollback`, `commit`, `reuse`, and `reject`
- **Nested transactions**: Parent and child transactions; children can commit independently or roll back with their parent
- **Commit boundaries**: A child transaction with `onError: "commit"` is preserved even when its parent rolls back
- **Framework-agnostic**: The core engine works in any JavaScript environment

## Packages

| Package | Description |
|---|---|
| [`@transactional-reducer/core`](packages/core/README.md) | Core engine — framework-agnostic |
| [`@transactional-reducer/react`](packages/react/README.md) | React Hook (`useTransactionalReducer`) |

## Quick Start

```ts
import { TransactionalReducer } from "@transactional-reducer/core";

const reducer = (state, action) => {
  switch (action.type) {
    case "inc": return { count: state.count + 1 };
    case "dec": return { count: state.count - 1 };
  }
};

const engine = new TransactionalReducer(reducer, { count: 0 });

// Optimistic update with automatic rollback
await engine.run(async (tx) => {
  tx.dispatch({ type: "inc" });
  await fetch("/api/inc");
  // Success → auto-commit; failure → auto-rollback
});
```

React usage:

```tsx
import { useTransactionalReducer } from "@transactional-reducer/react";

function Counter() {
  const [state, api] = useTransactionalReducer(reducer, { count: 0 });

  const handleOptimisticInc = () =>
    api.run(async (tx) => {
      tx.dispatch({ type: "inc" });
      await fetch("/api/inc");
    });

  return (
    <div>
      <p>{state.count}</p>
      <button onClick={handleOptimisticInc}>+1 (optimistic)</button>
    </div>
  );
}
```

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## License

MIT
