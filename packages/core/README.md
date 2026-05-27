# @transactional-reducer/core

A state management engine that adds transaction support to the reducer pattern. It allows you to wrap a group of dispatch operations in a transaction with **commit** and **rollback** semantics, just like a database transaction.

Framework-agnostic — works with React, Vue, Node.js, or any JavaScript environment.

## Core Value

- **Optimistic updates + automatic rollback**: Optimistically update state first, then automatically revert changes if the async operation fails
- **Cancellable async tasks**: A new transaction with the same id automatically cancels the previous one, preventing race conditions; `onCancel` supports proactive resource cleanup (e.g., aborting network requests)
- **Flexible deduplication strategies**: `onDuplicate` supports four strategies — `rollback` (roll back the old transaction), `commit` (commit the old transaction), `reuse` (reuse the old transaction), `reject` (reject the creation)
- **Nested transactions**: Parent-child transactions are supported; child transactions can commit independently or roll back with the parent
- **Commit boundary**: A child transaction with `onError: "commit"` is preserved when the parent rolls back, enabling "partial success" semantics

## Installation

```bash
npm install @transactional-reducer/core
```

## Quick Start

```ts
import { TransactionalReducer } from "@transactional-reducer/core";

type State = { count: number };
type Action = { type: "inc" } | { type: "dec" };

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case "inc": return { count: state.count + 1 };
    case "dec": return { count: state.count - 1 };
  }
};

const engine = new TransactionalReducer(reducer, { count: 0 });

// Non-transactional dispatch — not rollable back
engine.dispatch({ type: "inc" });
console.log(engine.state); // { count: 1 }

// Transactional dispatch — rollable back
engine.run(async (tx) => {
  tx.dispatch({ type: "inc" }); // optimistic update
  await fetch("/api/inc");       // async request
  // success → auto commit; failure → auto rollback
});

// Manual lifecycle management
const tx = engine.create();
tx.dispatch({ type: "inc" });
tx.rollback();
console.log(engine.state); // { count: 1 } (rolled back)

// Subscribe to state changes
engine.subscribe((state) => {
  console.log("state changed:", state);
});
```

---

## API Reference

### Exports

```ts
import {
  TransactionalReducer,
  type Transaction,
  type TransactionHandle,
  type TransactionOptions,
  type TransactionalReducerOptions,
  type OnErrorStrategy,
  type OnDuplicateStrategy,
  type ActionLogEntry,
  type Ref,
} from "@transactional-reducer/core";
```

### TransactionalReducer

```ts
class TransactionalReducer<S, A> {
  constructor(reducer: (state: S, action: A) => S, initialState: S, options?: TransactionalReducerOptions<S>);

  get state(): S;
  subscribe(listener: (state: S) => void): () => void;

  dispatch(action: A): void;
  run<R>(task: (tx: TransactionHandle<A>) => R, options?: TransactionOptions): R;
  create(options?: TransactionOptions): TransactionHandle<A>;
  getTransaction(id: string): TransactionHandle<A> | undefined;
}
```

#### `engine.state`

The current state. Updated immediately after each dispatch.

#### `engine.subscribe(listener)`

Subscribe to state changes. Returns an unsubscribe function.

```ts
const unsubscribe = engine.subscribe((state) => {
  console.log(state);
});
unsubscribe(); // unsubscribed
```

#### `engine.dispatch(action)`

Non-transactional dispatch, not rollable back. When no transaction is active, the action is not recorded in the action log (rollback is impossible, so logging is pure overhead). When a transaction is active, the action is recorded in the action log to ensure it is preserved during rollback replay.

#### `engine.run(task, options?)`

Starts a root transaction with automatic lifecycle management:

- **Sync task succeeds** → rolls back all still-active child transactions, then commits
- **Sync task throws** → rolls back or commits based on `onError`
- **Async task succeeds** → after Promise resolves, rolls back all still-active child transactions, then commits
- **Async task throws** → after Promise rejects, rolls back or commits based on `onError`

The return value of `task` is returned as-is (including Promises), enabling chained calls.

> **Note**: `run`/`spawn` automatically roll back all still-active child transactions before committing. This means if the parent transaction finishes first, any unfinished child transactions are forcibly rolled back. This differs from manually calling `tx.commit()` — manual `commit()` does not automatically roll back active child transactions.

#### `engine.create(options?)`

Manually creates a root transaction. You are responsible for calling `tx.commit()` or `tx.rollback()` to end the transaction.

> **Differences from `run`**:
> - `create` does not provide automatic lifecycle management (no auto commit/rollback on success/failure)
> - `create` does not automatically roll back active child transactions before committing
> - `create` supports all deduplication strategies, including `reuse` (returns the old transaction handle)
> - In async scenarios, it is recommended to manually check `tx.isStale()` before calling `commit()`/`rollback()`

#### `engine.getTransaction(id)`

Looks up a transaction by id. Returns a `TransactionHandle` or `undefined`.

### TransactionOptions

```ts
interface TransactionOptions {
  id?: string;                       // transaction id, used for deduplication and lookup
  onError?: OnErrorStrategy;         // "rollback" | "commit", default "rollback"
  onDuplicate?: OnDuplicateStrategy; // "rollback" | "reuse" | "commit" | "reject", default "rollback"
}
```

### TransactionHandle

```ts
interface TransactionHandle<A> {
  readonly id: string;
  readonly parentId: string | null;
  readonly onError: OnErrorStrategy;

  dispatch(action: A): void;
  spawn<R>(task: (tx: TransactionHandle<A>) => R, options?: TransactionOptions): R;
  commit(): void;
  rollback(): void;
  isStale(): boolean;
  onCancel(callback: () => void): void;
}
```

#### `tx.dispatch(action)`

Dispatches an action within the transaction. Silently ignored if the handle is stale.

#### `tx.spawn(task, options?)`

Creates a child transaction with automatic lifecycle management (same as `run`). Throws an error if the parent handle is stale.

The child transaction's `id` is not automatically prefixed with the parent's id — the user has full control and should take care to avoid collisions.

#### `tx.commit()`

Commits the transaction. Silently ignored if the handle is stale.

- **Child transaction commit**: Only marks the status as `"committed"`, remaining within the parent's scope. If the parent rolls back, the committed child's changes are also reverted.
- **Root transaction commit**: Makes the actions permanent and cleans up the transaction record.

#### `tx.rollback()`

Rolls back the transaction. Silently ignored if the handle is stale. See [Rollback Algorithm](#the-six-phases-of-the-rollback-algorithm).

#### `tx.isStale()`

Checks whether the handle is stale. A handle is stale when `transactionsRef` holds a different object for that id, or the handle's status is no longer `"active"`.

#### `tx.onCancel(callback)`

Registers a cancellation callback. If the handle is already stale, the callback executes immediately. See [onCancel Trigger Timing](#oncancel-trigger-timing).

### TransactionalReducerOptions

```ts
interface TransactionalReducerOptions<S> {
  idGenerator?: () => string;           // custom id generator
  snapshot?: (state: S) => S;           // custom snapshot function (default: structuredClone)
  onDuplicate?: OnDuplicateStrategy;    // global default deduplication strategy (default: "rollback")
}
```

### OnErrorStrategy

```ts
type OnErrorStrategy = "rollback" | "commit"
```

- `"rollback"`: Roll back the transaction when the task throws (default)
- `"commit"`: Preserve changes when the task throws (commit boundary)

### OnDuplicateStrategy

```ts
type OnDuplicateStrategy = "rollback" | "reuse" | "commit" | "reject"
```

See [Deduplication Strategies](#deduplication--onduplicate-strategies).

---

## Usage Guide

### 1. Non-transactional Dispatch

```ts
engine.dispatch({ type: "inc" }); // not rollable back
```

### 2. Optimistic Update + Automatic Rollback

```ts
await engine.run(async (tx) => {
  tx.dispatch({ type: "setSaving", value: true });
  tx.dispatch({ type: "updateData", value: newData });
  await saveToServer(newData);
  // success → auto commit
  // failure → auto rollback
});
```

### 3. Cancellable Async Tasks + onCancel

Assign an `id` to the transaction; a new transaction with the same id will automatically cancel (roll back) the old one:

```ts
async function handleSearch(query: string) {
  await engine.run(async (tx) => {
    const ac = new AbortController();
    tx.onCancel(() => ac.abort());
    tx.dispatch({ type: "setLoading", value: true });
    const results = await fetchResults(query, { signal: ac.signal });
    tx.dispatch({ type: "setResults", value: results });
  }, { id: "search" });
}

// User quickly types "a", "ab", "abc":
// - Requests for "a" and "ab" are automatically rolled back
// - Only the results for "abc" are preserved
```

### 4. Manual Transaction Lifecycle Management

```ts
const tx = engine.create({ id: "edit-form" });
tx.dispatch({ type: "updateField", field: "name", value: "new" });

// Save
await saveToServer(engine.state);
tx.commit();

// Or cancel
tx.rollback();
```

### 5. Nested Transactions (spawn)

```ts
await engine.run(async (tx) => {
  tx.dispatch({ type: "setSubmitting", value: true });

  await tx.spawn(async (childTx) => {
    childTx.dispatch({ type: "setValidating", value: true });
    const isValid = await validateForm();
    if (!isValid) throw new Error("validation failed");
  }, { id: "validate" });

  await submitForm();
}, { id: "submit" });
```

Key behaviors:

- A committed child transaction remains within the parent's scope — if the parent rolls back, the child's changes are also reverted
- A rolled-back child transaction does not affect the parent
- Child transaction ids are user-specified and not auto-prefixed

### 6. Commit Boundary (onError: "commit")

`onError: "commit"` creates a commit boundary — the child transaction is preserved when the parent rolls back:

```ts
await engine.run(async (tx) => {
  await tx.spawn(async (childTx) => {
    childTx.dispatch({ type: "updateCache", value: data });
  }, { id: "local-cache", onError: "commit" });

  await submitToServer(); // fails → entire transaction rolls back
  // but local-cache changes are preserved
}, { id: "submit" });
```

Commit boundary semantics:

- When the parent rolls back, preserved child transactions become independent root transactions (`parentId` is set to `null`)
- The commit boundary covers the entire subtree
- Preserved child transactions can continue to be used

### 7. Mixed onError Strategies

```ts
await engine.run(async (tx) => {
  tx.dispatch({ type: "setOrderStatus", value: "pending" });

  await tx.spawn(async (childTx) => {
    childTx.dispatch({ type: "removeFromCart", itemId });
  }, { id: "cart-update", onError: "commit" });

  await tx.spawn(async (childTx) => {
    childTx.dispatch({ type: "showSpinner", value: true });
  }, { id: "ui-effects", onError: "rollback" });

  await placeOrder();
}, { id: "order" });
// placeOrder() fails:
// - cart-update preserved
// - ui-effects rolled back
// - tx itself rolled back
```

### 8. Concurrent Transactions

```ts
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

Each transaction is managed independently; rolling back one does not affect the other.

### 9. State Subscription

```ts
const unsubscribe = engine.subscribe((state) => {
  render(state);
});

// Every dispatch inside a transaction triggers a notification
engine.run((tx) => {
  tx.dispatch({ type: "inc" }); // triggers notification
  tx.dispatch({ type: "inc" }); // triggers notification
  tx.rollback();                // triggers notification (state restored)
});
```

### 10. Custom Snapshot Function

The default uses `structuredClone`. If your state contains non-clonable objects:

```ts
const engine = new TransactionalReducer(reducer, initialState, {
  snapshot: (state) => ({
    ...state,
    data: [...state.data],
    ref: state.ref,
  }),
});
```

### 11. Custom ID Generator

```ts
let counter = 0;
const engine = new TransactionalReducer(reducer, initialState, {
  idGenerator: () => `tx_${++counter}`,
});
```

---

## Core Mechanisms

### Action Log + Snapshot + Replay

Transaction rollback is not simply "restore a snapshot" — it uses a **snapshot + replay** approach:

1. When a transaction is created, a snapshot of the current state and the starting position of the action log (snapshotIndex) are recorded
2. Each dispatch within the transaction is recorded in the action log with a `txId` tag
3. On rollback, the action log is replayed from the snapshot, **skipping entries belonging to the rolled-back transaction**

This design ensures that rollback only reverts the target transaction's changes while preserving:

- Non-transactional dispatches that occurred during the transaction
- Actions from concurrent sibling transactions
- Actions from descendant transactions with `onError: "commit"`

```
Timeline:
  ┌─ snapshot ─┬─── tx1 dispatch ────┬─── non-transactional dispatch ────┬─── tx2 dispatch ────┐
  │            │     inc              │       inc                          │       dec            │
  └────────────┴──────────────────────┴────────────────────────────────────┴──────────────────────┘

tx1 rollback → replay from snapshot, skip tx1's inc, preserve the non-transactional dispatch's inc and tx2's dec
```

### Generation Mechanism and Stale Handles

When a transaction with the same id is replaced (via deduplication), the old handle becomes "stale". Stale detection is implemented through a **generation** counter:

1. Each time a new transaction is created with the same id, the generation for that id in `generationRef` is incremented
2. The old handle's closure-bound generation no longer matches the new value in `generationRef`
3. `isStale()` checks two conditions: whether `transactionsRef` holds a different object for that id, or whether the handle's status is no longer `"active"`

Behavior of operations on stale handles:

- `dispatch` → ignored
- `commit` / `rollback` → ignored
- `spawn` → throws an error
- `onCancel` → callback executes immediately

This prevents async callbacks from inadvertently operating on stale handles (e.g., an old search request completing won't overwrite new search results).

### Deduplication / onDuplicate Strategies

When creating a transaction with an `id`, if an active transaction with the same id already exists, the `onDuplicate` strategy determines the behavior:

| Strategy | Behavior | Use Case |
|----------|----------|----------|
| `rollback` (default) | Rolls back the old transaction, creates a new one | Search/validation — new request supersedes the old one |
| `commit` | Commits the old transaction (including rolling back its active children), creates a new one | Treat the old task as completed |
| `reuse` | `create`: returns the old handle; `run`/`spawn`: throws an error | Edit forms — only one instance allowed |
| `reject` | Throws an error, rejects creation | Strictly forbid concurrency |

Strategy priority: `TransactionOptions.onDuplicate` > `TransactionalReducerOptions.onDuplicate` > `"rollback"`

```ts
// rollback (default) — new request supersedes the old one
engine.run(async (tx) => { ... }, { id: "search" });

// reuse — only one instance allowed, reuse existing transaction
const tx = engine.create({ id: "edit-form", onDuplicate: "reuse" });

// reject — strictly forbid concurrency
engine.run(async (tx) => { ... }, { id: "save", onDuplicate: "reject" });

// commit — treat the old task as completed
engine.run(async (tx) => { ... }, { id: "refresh", onDuplicate: "commit" });
```

> **Note**: `reuse` does not work with `run` and `spawn` — they throw an error instead of reusing the old transaction, because the automatic lifecycle management of `run`/`spawn` cannot be safely applied to an existing transaction.

### onCancel Trigger Timing

- Transaction replaced by deduplication (a new transaction with the same id rolls back the old one) → triggers
- Transaction manually rolled back via `rollback()` → triggers
- Transaction rolled back due to parent rollback (in rollbackSet) → triggers
- Transaction forcibly rolled back due to parent auto-commit (`run`/`spawn` rolls back still-active children on completion) → triggers
- Transaction committed via `commit()` → **does not trigger**
- Child transaction with `onError: "commit"` preserved during parent rollback → **does not trigger**

Special behaviors:

- If the handle is already stale (`isStale()` returns true), the callback executes immediately
- Multiple callbacks can be registered; they execute in order
- Callbacks are not double-triggered

### Child Transaction Commit vs Root Transaction Commit

**Child transaction commit**: Only marks the status as `"committed"`. The record remains in `transactionsRef` and the parent can still manage it. If the parent rolls back, the committed child's changes are also reverted.

**Root transaction commit**:

1. Relabels this transaction's and its descendants' action log entries as non-transactional dispatches (`txId: null`), making them permanent
2. Removes the root transaction record from `transactionsRef`
3. Cleans up committed descendant records
4. If no active transactions remain, clears the entire action log and transaction map

### The Six Phases of the Rollback Algorithm

If the transaction handle is stale, `_rollback()` returns immediately. The following describes the behavior when the handle is still active:

1. **Classify descendants**: Partition descendants into `preserveSet` (subtrees with `onError: "commit"`) and `rollbackSet`
2. **Mark skipped**: Mark actions from `rollbackSet` as `skipped`
3. **Relabel preserveSet**: Relabel actions from committed preserved child transactions as non-transactional dispatches (`txId: null`)
4. **Replay**: Replay from snapshot, skipping `skipped` entries
5. **Detach preserved transactions**: Committed preserved transactions are deleted; active preserved transactions have `parentId` set to `null` (becoming independent roots) and their snapshots are updated
6. **Final cleanup**: If no active transactions remain, clear all data

### Automatic Cleanup

When no transactions are active, the action log, transaction map, and generation map are cleared. Since rollback is no longer possible, the log is pure overhead.

---

## Common Scenarios

### Search with Auto-Cancel

```ts
const handleSearch = debounce(async (query: string) => {
  await engine.run(async (tx) => {
    const ac = new AbortController();
    tx.onCancel(() => ac.abort());
    tx.dispatch({ type: "setQuery", value: query });
    tx.dispatch({ type: "setLoading", value: true });
    const results = await searchAPI(query, { signal: ac.signal });
    tx.dispatch({ type: "setResults", value: results });
    tx.dispatch({ type: "setLoading", value: false });
  }, { id: "search" });
}, 300);
```

### Form Editing + Cancel to Restore

```ts
const tx = engine.create({ id: "edit-profile" });

function updateField(field: string, value: string) {
  tx.dispatch({ type: "updateField", field, value });
}

async function save() {
  try {
    await saveProfile(engine.state);
    tx.commit();
  } catch {
    tx.rollback();
  }
}

function cancel() {
  tx.rollback();
}
```

### Multi-Step Submit with Partial Preservation

```ts
await engine.run(async (tx) => {
  await tx.spawn(async (childTx) => {
    childTx.dispatch({ type: "lockItems", items });
    await lockInventory(items);
  }, { id: "lock-inventory", onError: "commit" });

  tx.dispatch({ type: "setPaymentProcessing", value: true });
  await processPayment(paymentInfo);
  tx.dispatch({ type: "setPaymentProcessing", value: false });
}, { id: "checkout" });
```

---

## Caveats

1. **Transaction id collisions**: Child transaction ids are not automatically prefixed with the parent's id — the user has full control. Take care to avoid using the same id for child transactions under different parents.

2. **Stale handle safety**: `dispatch`/`commit`/`rollback` on a stale handle are silently ignored; `spawn` throws an error. This is by design to prevent async callbacks from interfering with new transactions.

3. **Snapshot performance**: The default uses `structuredClone`, which may have performance overhead for large state objects. You can provide a lighter-weight clone function via the `snapshot` option.

4. **Idempotency requirements**: Since rollback uses a "snapshot + replay" mechanism, reducers should strive to be idempotent — the same action should produce reasonable results when applied to different base states.

5. **Sync vs async**: `run` and `spawn` handle lifecycle management slightly differently for sync vs async tasks. Sync tasks cannot become stale during execution, so no additional checks are needed; async tasks check for stale state in their Promise callbacks.

6. **onCancel and AbortError**: After using `onCancel` + `AbortController` to cancel an async request, the cancelled transaction's Promise will reject with an `AbortError` (rather than silently skipping commit and resolving). This is expected behavior — cancellation means the task is aborted, and the error should propagate to the caller.
