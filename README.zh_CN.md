# transactional-reducer

为 reducer 模式提供事务（Transaction）支持的状态管理库。允许你将一组 dispatch 操作包裹在事务中，支持**提交（commit）**和**回滚（rollback）**，就像数据库事务一样。

## 特性

- **乐观更新 + 自动回滚**：先乐观地更新状态，异步操作失败时自动撤销变更
- **可取消的异步任务**：相同 id 的事务自动取消前一个，避免竞态条件
- **灵活的去重策略**：`rollback`、`commit`、`reuse`、`reject` 四种策略
- **嵌套事务**：支持父子事务，子事务可独立提交或随父事务回滚
- **提交边界**：`onError: "commit"` 的子事务在父事务回滚时被保留
- **框架无关**：核心引擎可用于任何 JavaScript 环境

## 包

| 包 | 说明 |
|---|---|
| [`@transactional-reducer/core`](packages/core/README.md) | 核心引擎，框架无关 |
| [`@transactional-reducer/react`](packages/react/README.md) | React Hook（`useTransactionalReducer`） |

## 快速开始

```ts
import { TransactionalReducer } from "@transactional-reducer/core";

const reducer = (state, action) => {
  switch (action.type) {
    case "inc": return { count: state.count + 1 };
    case "dec": return { count: state.count - 1 };
  }
};

const engine = new TransactionalReducer(reducer, { count: 0 });

// 乐观更新 + 自动回滚
await engine.run(async (tx) => {
  tx.dispatch({ type: "inc" });
  await fetch("/api/inc");
  // 成功 → 自动 commit；失败 → 自动 rollback
});
```

React 用法：

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
      <button onClick={handleOptimisticInc}>+1 (乐观)</button>
    </div>
  );
}
```

## 开发

```bash
pnpm install
pnpm build
pnpm test
```

## License

MIT
