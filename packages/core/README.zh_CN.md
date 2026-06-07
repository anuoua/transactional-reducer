# @transactional-reducer/core

为 reducer 模式提供事务（Transaction）支持的状态管理引擎。允许你将一组 dispatch 操作包裹在事务中，支持**提交（commit）**和**回滚（rollback）**，就像数据库事务一样。

框架无关——可用于 React、Vue、Node.js 或任何 JavaScript 环境。

## 核心价值

- **乐观更新 + 自动回滚**：先乐观地更新状态，异步操作失败时自动撤销变更
- **可取消的异步任务**：相同 id 的事务自动取消前一个，避免竞态条件；`onCancel` 支持在取消时主动清理资源（如中止网络请求）
- **灵活的去重策略**：`onDuplicate` 支持四种策略——`rollback`（回滚旧事务）、`commit`（提交旧事务）、`reuse`（复用旧事务）、`reject`（拒绝创建）
- **嵌套事务**：支持父子事务，子事务可独立提交或随父事务回滚
- **提交边界**：`onError: "commit"` 的子事务在父事务回滚时被保留，实现"部分成功"语义

## 安装

```bash
npm install @transactional-reducer/core
```

## 快速开始

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

// 普通 dispatch —— 不可回滚
engine.dispatch({ type: "inc" });
console.log(engine.state); // { count: 1 }

// 事务性 dispatch —— 可回滚
engine.run(async (tx) => {
  tx.dispatch({ type: "inc" }); // 乐观更新
  await fetch("/api/inc");       // 异步请求
  // 成功 → 自动 commit；失败 → 自动 rollback
});

// 手动管理生命周期
const tx = engine.create();
tx.dispatch({ type: "inc" });
tx.rollback();
console.log(engine.state); // { count: 1 }（回滚了）

// 订阅状态变化
engine.subscribe((state) => {
  console.log("state changed:", state);
});
```

---

## API 参考

### 导出

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

当前状态。每次 dispatch 后立即更新。

#### `engine.subscribe(listener)`

订阅状态变化。返回取消订阅的函数。

```ts
const unsubscribe = engine.subscribe((state) => {
  console.log(state);
});
unsubscribe(); // 取消订阅
```

#### `engine.dispatch(action)`

普通 dispatch，不可回滚。当没有活跃事务时，不会记录到 action log（不可能回滚，日志纯属开销）。当有活跃事务时，会记录到 action log 以确保回滚重放时保留。

#### `engine.run(task, options?)`

启动一个根事务并自动管理生命周期：

- **同步任务成功** → 先回滚所有仍活跃的子事务，再提交
- **同步任务抛错** → 根据 `onError` 决定回滚或提交
- **异步任务成功** → Promise resolve 后先回滚所有仍活跃的子事务，再提交
- **异步任务抛错** → Promise reject 后根据 `onError` 决定回滚或提交

`task` 的返回值会被原样返回（包括 Promise），方便链式调用。

> **注意**：`run`/`spawn` 在提交前会自动回滚所有仍活跃的子事务。这意味着如果父事务先完成，尚未结束的子事务会被强制回滚。这与手动调用 `tx.commit()` 的行为不同——手动 `commit()` 不会自动回滚活跃子事务。

#### `engine.create(options?)`

手动创建根事务。你需要自行调用 `tx.commit()` 或 `tx.rollback()` 来结束事务。

> **与 `run` 的区别**：
> - `create` 不提供自动生命周期管理（不会在成功/失败时自动提交/回滚）
> - `create` 不会在提交前自动回滚活跃子事务
> - `create` 支持所有去重策略，包括 `reuse`（返回旧事务句柄）
> - 在异步场景中，建议在 `commit()`/`rollback()` 前手动检查 `tx.isStale()`

#### `engine.getTransaction(id)`

按 id 查找事务。返回 `TransactionHandle` 或 `undefined`。

### TransactionOptions

```ts
interface TransactionOptions {
  id?: string;                       // 事务 id，用于去重和查找
  onError?: OnErrorStrategy;         // "rollback" | "commit"，默认 "rollback"
  onDuplicate?: OnDuplicateStrategy; // "rollback" | "reuse" | "commit" | "reject"，默认 "rollback"
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

在事务内派发 action。如果事务已过期，静默忽略。

#### `tx.spawn(task, options?)`

创建子事务并自动管理生命周期（同 `run`）。如果父事务已过期，抛出错误。

子事务的 `id` 不会自动拼接父事务 id，由用户完全控制，需注意避免冲突。

#### `tx.commit()`

提交事务。如果事务已过期，静默忽略。

- **子事务提交**：仅标记为 `"committed"`，仍在父事务范围内。父事务回滚也会撤销已提交子事务的变更。
- **根事务提交**：将 action 永久化，清理事务记录。

#### `tx.rollback()`

回滚事务。如果事务已过期，静默忽略。参见[回滚算法](#回滚算法的六个阶段)。

#### `tx.isStale()`

检查句柄是否过期。过期条件：`transactionsRef` 中该 id 持有不同对象，或句柄 status 不再 `"active"`。

#### `tx.onCancel(callback)`

注册取消回调。如果事务已过期，回调立即执行。参见 [onCancel 触发时机](#oncancel-触发时机)。

### TransactionalReducerOptions

```ts
interface TransactionalReducerOptions<S> {
  idGenerator?: () => string;           // 自定义 id 生成器
  snapshot?: (state: S) => S;           // 自定义快照函数（默认 structuredClone）
  onDuplicate?: OnDuplicateStrategy;    // 全局去重策略默认值（默认 "rollback"）
}
```

### OnErrorStrategy

```ts
type OnErrorStrategy = "rollback" | "commit"
```

- `"rollback"`：任务抛错时回滚事务（默认）
- `"commit"`：任务抛错时保留变更（提交边界）

### OnDuplicateStrategy

```ts
type OnDuplicateStrategy = "rollback" | "reuse" | "commit" | "reject"
```

参见[去重策略](#去重--onduplicate-策略)。

---

## 使用指南

### 1. 普通 Dispatch

```ts
engine.dispatch({ type: "inc" }); // 不可回滚
```

### 2. 乐观更新 + 自动回滚

```ts
await engine.run(async (tx) => {
  tx.dispatch({ type: "setSaving", value: true });
  tx.dispatch({ type: "updateData", value: newData });
  await saveToServer(newData);
  // 成功 → 自动 commit
  // 失败 → 自动 rollback
});
```

### 3. 可取消的异步任务 + onCancel

给事务指定 `id`，相同 id 的新事务会自动取消（回滚）旧事务：

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

// 用户快速输入 "a"、"ab"、"abc"：
// - "a" 和 "ab" 的请求被自动回滚
// - 只有 "abc" 的结果保留
```

### 4. 手动管理事务生命周期

```ts
const tx = engine.create({ id: "edit-form" });
tx.dispatch({ type: "updateField", field: "name", value: "new" });

// 保存
await saveToServer(engine.state);
tx.commit();

// 或取消
tx.rollback();
```

### 5. 嵌套事务（spawn）

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

关键行为：

- 子事务提交后仍在父事务范围内——父事务回滚也会撤销子事务
- 子事务回滚不影响父事务
- 子事务 id 由用户指定，不会自动拼接

### 6. 提交边界（onError: "commit"）

`onError: "commit"` 创建提交边界——父事务回滚时保留该子事务：

```ts
await engine.run(async (tx) => {
  await tx.spawn(async (childTx) => {
    childTx.dispatch({ type: "updateCache", value: data });
  }, { id: "local-cache", onError: "commit" });

  await submitToServer(); // 失败 → 整个事务 rollback
  // 但 local-cache 的变更被保留
}, { id: "submit" });
```

提交边界的语义：

- 父事务回滚时，保留的子事务变为独立根事务（`parentId` 设为 `null`）
- 提交边界覆盖整个子树
- 保留的子事务可以继续操作

### 7. 混合 onError 策略

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
// placeOrder() 失败：
// - cart-update 保留
// - ui-effects 回滚
// - tx 自身回滚
```

### 8. 并发事务

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

每个事务独立管理，回滚其中一个不影响另一个。

### 9. 状态订阅

```ts
const unsubscribe = engine.subscribe((state) => {
  render(state);
});

// 在事务内每次 dispatch 都会触发通知
engine.run((tx) => {
  tx.dispatch({ type: "inc" }); // 触发通知
  tx.dispatch({ type: "inc" }); // 触发通知
  tx.rollback();                // 触发通知（恢复状态）
});
```

### 10. 自定义快照函数

默认使用 `structuredClone`。如果状态包含不可克隆对象：

```ts
const engine = new TransactionalReducer(reducer, initialState, {
  snapshot: (state) => ({
    ...state,
    data: [...state.data],
    ref: state.ref,
  }),
});
```

### 11. 自定义 ID 生成器

```ts
let counter = 0;
const engine = new TransactionalReducer(reducer, initialState, {
  idGenerator: () => `tx_${++counter}`,
});
```

---

## 核心机制详解

### Action Log + Snapshot + Replay

事务回滚不是简单的"恢复快照"，而是**快照 + 重放**：

1. 事务创建时，记录当前状态的快照（snapshot）和 action log 的起始位置（snapshotIndex）
2. 事务内的每次 dispatch 都记录到 action log 中，附带 `txId` 标识
3. 回滚时，从快照开始重放所有 action log 条目，**跳过属于回滚事务的条目**

这种设计确保回滚仅撤销目标事务的变更，同时保留：

- 事务期间发生的普通（非事务）dispatch
- 并发兄弟事务的 action
- `onError: "commit"` 的后代事务的 action

```
时间线：
  ┌─ snapshot ─┬─── tx1 dispatch ────┬─── 普通 dispatch ────┬─── tx2 dispatch ────┐
  │            │     inc              │       inc             │       dec            │
  └────────────┴──────────────────────┴───────────────────────┴──────────────────────┘

tx1 rollback → 从 snapshot 重放，跳过 tx1 的 inc，保留普通 dispatch 的 inc 和 tx2 的 dec
```

### Generation 机制与过期句柄

当相同 id 的事务被替换时（去重机制），旧句柄变为"过期"。过期检测通过 **generation** 实现：

1. 每次用相同 id 创建新事务时，`generationRef` 中该 id 的 generation 递增
2. 旧句柄闭包绑定的 generation 不再匹配 `generationRef` 中的新值
3. `isStale()` 检查两个条件：`transactionsRef` 中该 id 是否持有不同对象，或句柄的 status 是否不再是 `"active"`

过期句柄的操作行为：

- `dispatch` → 忽略
- `commit` / `rollback` → 忽略
- `spawn` → 抛出错误
- `onCancel` → 立即执行回调

这防止了异步回调在过期句柄上误操作（例如，旧的搜索请求完成后不会覆盖新的搜索结果）。

### 去重 / onDuplicate 策略

当创建事务时指定了 `id`，如果相同 id 的活跃事务已存在，会根据 `onDuplicate` 策略处理：

| 策略 | 行为 | 适用场景 |
|------|------|----------|
| `rollback`（默认） | 回滚旧事务，创建新的 | 搜索/验证——新请求取代旧请求 |
| `commit` | 提交旧事务（含回滚其活跃子事务），创建新的 | 旧任务视为已完成 |
| `reuse` | `create`：返回旧句柄；`run`/`spawn`：抛错 | 编辑表单——只允许一个实例 |
| `reject` | 抛错，拒绝创建 | 严格禁止并发 |

策略优先级：`TransactionOptions.onDuplicate` > `TransactionalReducerOptions.onDuplicate` > `"rollback"`

```ts
// rollback（默认行为）——新请求取代旧请求
engine.run(async (tx) => { ... }, { id: "search" });

// reuse——只允许一个实例，复用已有事务
const tx = engine.create({ id: "edit-form", onDuplicate: "reuse" });

// reject——严格禁止并发
engine.run(async (tx) => { ... }, { id: "save", onDuplicate: "reject" });

// commit——旧任务视为已完成
engine.run(async (tx) => { ... }, { id: "refresh", onDuplicate: "commit" });
```

> **注意**：`reuse` 对 `run` 和 `spawn` 无效——它们会抛错而非复用旧事务，因为 `run`/`spawn` 的自动生命周期管理无法安全地应用于已有事务。

### onCancel 触发时机

- 事务被去重替换（相同 id 的新事务回滚旧事务）→ 触发
- 事务被手动 `rollback()` → 触发
- 事务因父事务回滚而被回滚（在 rollbackSet 中）→ 触发
- 事务因父事务自动提交而被强制回滚（`run`/`spawn` 完成时回滚仍活跃的子事务）→ 触发
- 事务被 `commit()` → **不触发**
- `onError: "commit"` 的子事务在父事务回滚时被保留 → **不触发**

特殊行为：

- 如果事务已过期（`isStale()` 返回 true），回调立即执行
- 可以注册多个回调，依次执行
- 回调不会双重触发

### 子事务提交 vs 根事务提交

**子事务提交**：仅将 status 标记为 `"committed"`。记录保留在 `transactionsRef` 中，父事务仍可管理它。父事务回滚也会撤销已提交子事务的变更。

**根事务提交**：

1. 将此事务及其后代的 action log 条目重新标记为普通 dispatch（`txId: null`），使其永久化
2. 从 `transactionsRef` 中删除根事务记录
3. 清理已提交的后代记录
4. 如果没有活跃事务剩余，清空整个 action log 和事务映射

### 回滚算法的六个阶段

若事务句柄已过期，`_rollback()` 立即返回。以下仅描述句柄仍活跃时的行为：

1. **分类后代**：将后代分为 `preserveSet`（`onError: "commit"` 的子树）和 `rollbackSet`
2. **标记 skipped**：将 `rollbackSet` 的 action 标记为 `skipped`
3. **重新标记 preserveSet**：将已提交的保留子事务的 action 重新标记为普通 dispatch（`txId: null`）
4. **重放**：从快照重放，跳过 `skipped` 条目
5. **分离保留的事务**：已提交的保留事务被删除；活跃的保留事务 `parentId` 设为 `null`（变为独立根），并更新其 snapshot
6. **最终清理**：若无活跃事务剩余，清空所有数据

### 自动清理

当没有活跃事务时，action log、事务映射和 generation 映射会被清空。因为不可能再发生回滚，日志纯属开销。

---

## 常见场景

### 搜索自动取消

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

### 表单编辑 + 取消恢复

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

### 多步骤提交 + 部分保留

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

## 注意事项

1. **事务 id 冲突**：子事务的 id 不会自动拼接父事务 id，由用户完全控制。需注意避免不同父事务下的子事务使用相同 id。

2. **过期句柄安全**：对过期句柄的 `dispatch`/`commit`/`rollback` 会被静默忽略，`spawn` 会抛出错误。这是设计行为，防止异步回调干扰新事务。

3. **快照性能**：默认使用 `structuredClone`，对大型状态对象可能有性能开销。可通过 `snapshot` 选项提供更轻量的克隆函数。

4. **幂等性要求**：由于回滚使用"快照 + 重放"机制，reducer 应尽量保持幂等性——相同 action 在不同基础状态上应产生合理的结果。

5. **同步 vs 异步**：`run` 和 `spawn` 对同步任务和异步任务的生命周期管理略有不同。同步任务执行期间不可能过期，无需额外检查；异步任务的 Promise 回调中会检查过期状态。

6. **onCancel 与 AbortError**：使用 `onCancel` + `AbortController` 取消异步请求后，被取消事务的 Promise 会以 `AbortError` reject（而非静默跳过 commit 后 resolve）。这是预期行为——取消意味着任务中止，错误应传播给调用方。
