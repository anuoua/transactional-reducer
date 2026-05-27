# @transactional-reducer/react

为 React 的 `useReducer` 提供事务（Transaction）支持的 Hook。将 [`@transactional-reducer/core`](../core/README.md) 引擎封装为 React 友好的 API。

> 事务的核心概念（回滚算法、去重策略、提交边界、过期句柄等）均在 [`@transactional-reducer/core`](../core/README.md) 中详细说明。本文档仅描述 React Hook 的用法。

## 安装

```bash
npm install @transactional-reducer/react @transactional-reducer/core
```

## 快速开始

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
  const [state, api] = useTransactionalReducer(reducer, { count: 0 });

  // 普通 dispatch —— 不可回滚
  const handleInc = () => api.dispatch({ type: "inc" });

  // 事务性 dispatch —— 可回滚
  const handleOptimisticInc = () =>
    api.run(async (tx) => {
      tx.dispatch({ type: "inc" }); // 乐观更新 UI
      await fetch("/api/inc");       // 异步请求
      // 成功 → 自动 commit；失败 → 自动 rollback
    });

  return (
    <div>
      <p>Count: {state.count}</p>
      <button onClick={handleInc}>+1</button>
      <button onClick={handleOptimisticInc}>+1 (乐观)</button>
    </div>
  );
}
```

---

## API 参考

### 签名

```ts
function useTransactionalReducer<S, A>(
  reducer: (state: S, action: A) => S,
  initialState: S,
  options?: TransactionalReducerOptions<S>,
): [
  S,
  {
    dispatch: (action: A) => void;
    run<R>(task: (tx: TransactionHandle<A>) => R, options?: TransactionOptions): R;
    create(options?: TransactionOptions): TransactionHandle<A>;
    getDraft(): S;
    getTransaction(id: string): TransactionHandle<A> | undefined;
  },
];
```

`TransactionalReducerOptions`、`TransactionOptions`、`TransactionHandle` 等类型均从 [`@transactional-reducer/core`](../core/README.md#api-参考) 导出。

### 返回值

返回一个元组 `[state, api]`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `state` | `S` | 当前状态（由 React 渲染周期驱动） |
| `api.dispatch` | `(action: A) => void` | 普通 dispatch，不可回滚 |
| `api.run` | 见下方 | 启动根事务，自动管理生命周期 |
| `api.create` | 见下方 | 手动创建根事务 |
| `api.getDraft` | `() => S` | 获取最新 draft 状态（绕过 React 批处理延迟） |
| `api.getTransaction` | `(id: string) => TransactionHandle \| undefined` | 按 id 查找事务 |

### `api.run(task, options?)`

启动根事务并自动管理生命周期。行为与 [`engine.run()`](../core/README.md#engineruntask-options) 一致。

### `api.create(options?)`

手动创建根事务。行为与 [`engine.create()`](../core/README.md#enginecreateoptions) 一致。

### `api.getDraft()`

返回引擎的即时状态。React 的状态更新可能被批处理或延迟，在异步回调中 `state` 可能不是最新的。`getDraft()` 始终返回最新值。

```tsx
await api.run(async (tx) => {
  tx.dispatch({ type: "inc" });
  // state.count 可能还是旧值（React 批处理）
  const currentCount = api.getDraft().count; // 最新值
  tx.dispatch({ type: "set", value: currentCount * 2 });
});
```

### `api.getTransaction(id)`

按 id 查找事务，等同于 [`engine.getTransaction()`](../core/README.md#enginegettransactionid)。

---

## 使用指南

### 1. 乐观更新 + 自动回滚

```tsx
async function handleSave() {
  await api.run(async (tx) => {
    tx.dispatch({ type: "setSaving", value: true });
    tx.dispatch({ type: "updateData", value: newData });
    await saveToServer(newData);
    // 成功 → 自动 commit；失败 → 自动 rollback
  });
}
```

### 2. 可取消的异步任务

给事务指定 `id`，相同 id 的新事务会自动取消旧事务（[去重策略](../core/README.md#去重--onduplicate-策略)）：

```tsx
async function handleSearch(query: string) {
  await api.run(async (tx) => {
    const ac = new AbortController();
    tx.onCancel(() => ac.abort());
    tx.dispatch({ type: "setLoading", value: true });
    const results = await fetchResults(query, { signal: ac.signal });
    tx.dispatch({ type: "setResults", value: results });
  }, { id: "search" });
}
```

### 3. 手动管理事务生命周期

```tsx
function EditForm() {
  const [state, api] = useTransactionalReducer(reducer, initialState);
  const txRef = useRef<TransactionHandle<Action>>();

  const startEditing = () => {
    txRef.current = api.create({ id: "edit-form" });
  };

  const updateField = (field: string, value: string) => {
    txRef.current?.dispatch({ type: "updateField", field, value });
  };

  const save = async () => {
    try {
      await saveProfile(api.getDraft());
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

### 4. 嵌套事务（spawn）

```tsx
await api.run(async (tx) => {
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

### 5. 并发事务

```tsx
const [result1, result2] = await Promise.all([
  api.run(async (tx) => {
    tx.dispatch({ type: "setUsersLoading", value: true });
    const users = await fetchUsers();
    tx.dispatch({ type: "setUsers", value: users });
  }, { id: "fetch-users" }),
  api.run(async (tx) => {
    tx.dispatch({ type: "setPostsLoading", value: true });
    const posts = await fetchPosts();
    tx.dispatch({ type: "setPosts", value: posts });
  }, { id: "fetch-posts" }),
]);
```

---

## 更多

- **核心概念**（回滚算法、generation 机制、去重策略、提交边界、onCancel 等）：参见 [`@transactional-reducer/core`](../core/README.md#核心机制详解)
- **常见场景**（搜索自动取消、多步骤提交 + 部分保留）：参见 [`@transactional-reducer/core`](../core/README.md#常见场景)
- **注意事项**：参见 [`@transactional-reducer/core`](../core/README.md#注意事项)

---

## React 特有注意事项

1. **React 批处理**：在异步回调中，React 的 `state` 可能不是最新的。使用 `api.getDraft()` 获取即时状态。

2. **API 稳定性**：`api` 对象及其方法（`dispatch`、`run` 等）在组件整个生命周期中引用稳定，可安全地省略 `useEffect`/`useCallback` 的依赖项。

3. **组件隔离**：每个组件实例持有独立的引擎实例（通过 `useRef`），状态不会跨组件共享。
