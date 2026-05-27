export interface Ref<T> {
  current: T
}

export interface ActionLogEntry<A> {
  action: A;
  // null = 普通 dispatch 或已提交的根事务 action；
  // string = 在该事务内派发的 action
  txId: string | null;
  // 每个 txId 单调递增。spawn() 用它检测过期句柄：
  // 当 createTx 用相同 id 替换事务时，新的 generation
  // 不会匹配旧句柄闭包绑定的 generation，使旧句柄变为过期。
  generation: number;
  // 在回滚重放期间标记为 true。被跳过的条目不会参与
  // 回滚后重建状态的重放过程。
  skipped?: boolean;
}

export type OnErrorStrategy = "rollback" | "commit"
export type OnDuplicateStrategy = "rollback" | "reuse" | "commit" | "reject"

export interface TransactionOptions {
  id?: string
  onError?: OnErrorStrategy
  onDuplicate?: OnDuplicateStrategy
}

export type SpawnOptions = TransactionOptions

export interface TransactionHandle<A> {
  readonly id: string
  readonly parentId: string | null
  readonly onError: OnErrorStrategy
  dispatch(action: A): void
  spawn<R>(task: (tx: TransactionHandle<A>) => R, options?: SpawnOptions): R
  commit(): void
  rollback(): void
  isStale(): boolean
  onCancel(callback: () => void): void
}

export interface TransactionalReducerOptions<S = any> {
  idGenerator?: () => string
  snapshot?: (state: S) => S
  onDuplicate?: OnDuplicateStrategy
}

// Transaction 引擎接口，定义 Transaction 对引擎的依赖。
// 由 TransactionalReducer 类实现。
export interface TransactionEngine<S, A> {
  readonly reducer: (state: S, action: A) => S
  readonly options: TransactionalReducerOptions<S> | undefined
  readonly stateRef: Ref<S>
  readonly actionLogRef: Ref<ActionLogEntry<A>[]>
  readonly transactionsRef: Ref<Map<string, Transaction<S, A>>>
  readonly generationRef: Ref<Map<string, number>>
  _createTx(id: string | undefined, parentId: string | null, onError: OnErrorStrategy, onDuplicate: OnDuplicateStrategy): Transaction<S, A>
  _runWithTx<R>(tx: Transaction<S, A>, task: (tx: TransactionHandle<A>) => R): R
  _applyAction(action: A): void
  _notify(): void
}

export function _generateId(): string {
  return `tx_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

export function _getAllDescendants<S>(
  txId: string,
  transactions: Map<string, Transaction<S, any>>,
): string[] {
  const result: string[] = []
  for (const [, tx] of transactions) {
    if (tx.parentId === txId) {
      result.push(tx.id, ..._getAllDescendants(tx.id, transactions))
    }
  }
  return result
}

export function _isDescendantOf<S>(
  candidateTxId: string | null,
  ancestorTxId: string,
  transactions: Map<string, Transaction<S, any>>,
): boolean {
  if (candidateTxId === null) return false
  let current: string | null = candidateTxId
  while (current !== null) {
    if (current === ancestorTxId) return true
    const record = transactions.get(current)
    current = record?.parentId ?? null
  }
  return false
}

export function _cleanupCommittedDescendants<S>(
  parentId: string,
  transactions: Map<string, Transaction<S, any>>,
): void {
  for (const [id, tx] of transactions) {
    if (tx.parentId === parentId && tx.status === "committed") {
      transactions.delete(id)
      _cleanupCommittedDescendants(id, transactions)
    }
  }
}

// ─── Transaction ────────────────────────────────────────────────────────────
//
// 每个 Transaction 对象是一个句柄，闭包绑定到其 id 和 generation。
// 当 createTx 用相同 id 替换活跃事务时（去重机制），旧句柄变为"过期"——
// 其 generation 不再匹配 generationRef，transactionsRef 中该 id 对应的
// 对象也已替换。对过期句柄的所有操作会被静默忽略或抛出错误，防止过期
// 的异步回调干扰新事务。
//
// parentId 是故意可变的（非 readonly）。当父事务回滚且 onError:"commit"
// 的子事务被保留时，子事务的 parentId 被设为 null——它成为独立的根事务，
// 因为它的父事务已不存在。
// ────────────────────────────────────────────────────────────────────────────

export class Transaction<S, A> implements TransactionHandle<A> {
  readonly id: string
  parentId: string | null
  readonly onError: OnErrorStrategy
  readonly generation: number
  snapshot: S
  readonly snapshotIndex: number
  status: "active" | "committed" | "rolledback" = "active"
  cancelCallbacks: (() => void)[] = []

  private engine: TransactionEngine<S, A>

  constructor(
    engine: TransactionEngine<S, A>,
    id: string,
    parentId: string | null,
    onError: OnErrorStrategy,
    generation: number,
    snapshot: S,
    snapshotIndex: number,
  ) {
    this.engine = engine
    this.id = id
    this.parentId = parentId
    this.onError = onError
    this.generation = generation
    this.snapshot = snapshot
    this.snapshotIndex = snapshotIndex
  }

  // 句柄过期的条件：
  //   1. transactionsRef 中该 id 对应的是不同的对象（被 createTx 替换），
  //   2. 或该句柄的 status 不再是 "active"（已提交/已回滚）。
  // 两个条件都必须检查——回滚后句柄从 transactionsRef 中删除，
  // 所以 `current !== this` 为 true；提交后 status 变化，
  // 所以 `this.status !== "active"` 为 true。
  isStale(): boolean {
    const current = this.engine.transactionsRef.current.get(this.id)
    return current !== this || this.status !== "active"
  }

  onCancel(callback: () => void): void {
    if (this.isStale()) {
      callback()
      return
    }
    this.cancelCallbacks.push(callback)
  }

  dispatch(action: A): void {
    if (this.isStale()) return
    this.engine.actionLogRef.current.push({
      action,
      txId: this.id,
      generation: this.generation,
    })
    this.engine._applyAction(action)
  }

  // spawn 在创建子事务前执行三重过期检查：
  //   1. 身份检查：transactionsRef 中该 id 必须持有此对象本身
  //   2. 状态检查：此句柄的 status 必须仍为 "active"
  //   3. generation 检查：此句柄的 generation 必须匹配 generationRef
  // generation 检查至关重要：当 createTx 用相同 id 替换事务时，
  // 旧句柄的 generation 不匹配 generationRef 中的新 generation。
  // 没有此检查，过期句柄可能在新事务下派生子事务。
  spawn<R>(
    task: (tx: TransactionHandle<A>) => R,
    options?: SpawnOptions,
  ): R {
    const current = this.engine.transactionsRef.current.get(this.id)
    if (
      current !== this ||
      this.status !== "active" ||
      this.generation !== this.engine.generationRef.current.get(this.id)
    ) {
      throw new Error(
        `Cannot spawn from transaction "${this.id}": parent is no longer active`,
      )
    }
    // 子事务 id 就是用户传入的值——不与父事务 id 自动拼接。
    // 这意味着用户控制完整 id，并负责避免意外冲突。
    // 去重机制（createTx 回滚相同 id 的活跃事务）提供了
    // 有意的取消功能：例如 start({id:"validate_name"}) 会取消
    // 之前的 validate_name 任务。
    const childId = options?.id ?? _generateId()
    const childOnError = options?.onError ?? "rollback"
    const childOnDuplicate = options?.onDuplicate ?? this.engine.options?.onDuplicate ?? "rollback"
    if (childOnDuplicate === "reuse" && options?.id) {
      const existingChild = this.engine.transactionsRef.current.get(options.id)
      if (existingChild?.status === "active") {
        throw new Error(
          `Cannot spawn: transaction "${options.id}" is already active`,
        )
      }
    }
    const childTx = this.engine._createTx(childId, this.id, childOnError, childOnDuplicate)
    return this.engine._runWithTx(childTx, task)
  }

  commit(): void {
    if (this.isStale()) return
    this._commit()
  }

  rollback(): void {
    if (this.isStale()) return
    this._rollback()
  }

  // ─── _commit ──────────────────────────────────────────────────────────
  //
  // 子事务提交：仅将 status 标记为 "committed"。记录保留在
  // transactionsRef 中，父事务仍可管理它（父事务回滚也会回滚
  // 已提交的子事务）。父事务的 _commit 或 _rollback 最终会
  // 清理已提交子事务的记录。
  //
  // 根事务提交：通过以下步骤完成事务：
  //   1. 将此事务（及其后代）的所有 action log 条目重新标记为
  //      普通 dispatch（txId: null）。这使它们成为永久性的——
  //      在任何未来的回滚重放中都会保留。
  //   2. 从 transactionsRef 中删除根事务记录。
  //   3. 清理已提交的后代记录（根事务已消失，这些记录不再有意义）。
  //   4. 如果没有活跃事务剩余，清空整个 action log 和事务映射——
  //      不可能再发生回滚，日志是不必要的开销。
  // ────────────────────────────────────────────────────────────────────────
  _commit(): void {
    if (this.parentId !== null) {
      this.status = "committed"
    } else {
      this.status = "committed"

      for (
        let i = this.snapshotIndex;
        i < this.engine.actionLogRef.current.length;
        i++
      ) {
        const entry = this.engine.actionLogRef.current[i]!
        if (entry.skipped) continue
        if (
          entry.txId === this.id ||
          _isDescendantOf(entry.txId, this.id, this.engine.transactionsRef.current)
        ) {
          this.engine.actionLogRef.current[i] = {
            action: entry.action,
            txId: null,
            generation: 0,
          }
        }
      }

      this.engine.transactionsRef.current.delete(this.id)
      _cleanupCommittedDescendants(
        this.id,
        this.engine.transactionsRef.current,
      )

      if (!this._hasActiveTransactions()) {
        this.engine.actionLogRef.current = []
        this.engine.transactionsRef.current.clear()
        this.engine.generationRef.current.clear()
      }
    }
  }

  // ─── _rollback ────────────────────────────────────────────────────────
  //
  // 回滚不是简单的"恢复快照"——而是快照 + 重放。
  // 这确保回滚仅撤销目标事务的变更，同时保留以下变更：
  //   - 事务期间发生的普通（非事务）dispatch
  //   - 并发兄弟事务的 action
  //   - onError:"commit" 的后代（提交边界）
  //
  // 算法步骤：
  //   阶段 1：将后代分类为 preserveSet 和 rollbackSet
  //   阶段 2：在 action log 中将 rollbackSet 的 action 标记为 skipped
  //   阶段 3：将 preserveSet 的 action 重新标记为普通 dispatch（txId: null）
  //   阶段 4：从快照重放，跳过已回滚的 action
  //   阶段 5：更新状态、删除记录、分离保留的事务
  //   阶段 6：若无活跃事务剩余则最终清理
  //
  // ── 阶段 1：preserveSet 分类 ──────────────────────────────────────
  //
  // onError:"commit" 创建"提交边界"——其下的整个子树被保留。
  // 不能选择性回滚提交子树内的后代，因为它们的 dispatch 是基于
  // 父事务中间状态计算的；移除父事务的 action 会使后代的 dispatch
  // 不一致。
  //
  // `underPreserve` 遍历防止双重保留：如果 onError:"commit" 的后代
  // 有一个祖先已在 preserveSet 中，它已被该祖先的提交边界覆盖，
  // 不需要单独保留。这在菱形事务层级中很重要，同一后代可能通过
  // 多条路径到达。
  //
  // ── 阶段 3：重新标记 preserveSet ──────────────────────────────────
  //
  // 仅将已提交的保留子事务的 action 重新标记为普通 dispatch（txId: null）。
  // 活跃的保留子事务保持原 txId，以便后续回滚/提交时能识别自己的 action。
  // 已提交的保留子事务即将被删除，其 action 需变为永久性的。
  //
  // 必须在阶段 2 之后执行，以免保留的 action（txId 变为 null 后）
  // 被 rollbackSet 检查意外捕获。
  //
  // ── 阶段 5：分离保留的事务 ────────────────────────────────────────
  //
  // 回滚后，保留的事务需要变为独立的：
  //   - 已提交的保留事务：删除（其工作已完成，action 已成为日志中的
  //     普通 dispatch）
  //   - 活跃的保留事务：parentId 设为 null（成为根事务，
  //     因为已回滚的父事务不再存在），并更新 snapshot 为不含自身
  //     action 的正确基础状态（从回滚事务的 snapshot 重放，
  //     跳过 rollbackSet 和子事务自己的 action）
  //
  // 然后对每个活跃保留事务调用 _cleanupCommittedDescendants，
  // 清理其子树中已提交的子事务。现在安全了，因为保留事务已是独立根。
  // ────────────────────────────────────────────────────────────────────────
  _rollback(): void {
    if (this.isStale()) return

    const descendants = _getAllDescendants(
      this.id,
      this.engine.transactionsRef.current,
    )

    // 阶段 1：分类后代
    const preserveSet = new Set<string>()
    const visited = new Set<string>()
    for (const descId of descendants) {
      if (visited.has(descId)) continue
      const descTx = this.engine.transactionsRef.current.get(descId)
      if (descTx?.onError === "commit") {
        // 从 descTx 向上遍历到 this.id，检查是否有中间祖先
        // 已在 preserveSet 中。如果有，descTx 已被该祖先的
        // 提交边界覆盖。
        let underPreserve = false
        let current: string | null = descTx.parentId
        while (current !== null && current !== this.id) {
          if (preserveSet.has(current)) {
            underPreserve = true
            break
          }
          current =
            this.engine.transactionsRef.current.get(current)?.parentId ?? null
        }
        if (!underPreserve) {
          // 此后代是提交边界。保留它及其整个子树
          // （不能部分保留子树）。
          preserveSet.add(descId)
          const subDescendants = _getAllDescendants(
            descId,
            this.engine.transactionsRef.current,
          )
          for (const subId of subDescendants) {
            preserveSet.add(subId)
            visited.add(subId)
          }
        }
      }
      visited.add(descId)
    }

    const rollbackSet = new Set<string>()
    rollbackSet.add(this.id)
    for (const descId of descendants) {
      if (!preserveSet.has(descId)) {
        rollbackSet.add(descId)
      }
    }

    // 阶段 2：将回滚 action 标记为 skipped
    for (
      let i = this.snapshotIndex;
      i < this.engine.actionLogRef.current.length;
      i++
    ) {
      const entry = this.engine.actionLogRef.current[i]!
      if (entry.txId !== null && rollbackSet.has(entry.txId)) {
        entry.skipped = true
      }
    }

    // 阶段 3：将保留的 action 重新标记为普通 dispatch
    // 必须在阶段 2 之后执行，以免保留的 action（txId 变为 null 后）
    // 被 rollbackSet 检查意外捕获。
    for (
      let i = this.snapshotIndex;
      i < this.engine.actionLogRef.current.length;
      i++
    ) {
      const entry = this.engine.actionLogRef.current[i]!
      if (!entry.skipped && entry.txId !== null && preserveSet.has(entry.txId)) {
        const preservedTx = this.engine.transactionsRef.current.get(entry.txId)
        if (preservedTx?.status === "committed") {
          this.engine.actionLogRef.current[i] = {
            action: entry.action,
            txId: null,
            generation: 0,
          }
        }
      }
    }

    // 阶段 4：从快照重放，跳过已回滚的 action
    let replayState = this.snapshot
    for (
      let i = this.snapshotIndex;
      i < this.engine.actionLogRef.current.length;
      i++
    ) {
      const entry = this.engine.actionLogRef.current[i]!
      if (entry.skipped) continue
      replayState = this.engine.reducer(replayState, entry.action)
    }

    // 在删除前将回滚记录标记为 rolledback（可能被尚未完成的
    // 异步回调引用）
    for (const id of rollbackSet) {
      const record = this.engine.transactionsRef.current.get(id)
      if (record) record.status = "rolledback"
    }

    this.engine.stateRef.current = replayState
    this.engine._notify()

    // 触发 rollbackSet 中每个事务的 onCancel 回调。
    // 使用 copy-and-clear 模式防止双重触发和重入注册。
    for (const id of rollbackSet) {
      const record = this.engine.transactionsRef.current.get(id)
      if (record?.cancelCallbacks.length) {
        const callbacks = [...record.cancelCallbacks]
        record.cancelCallbacks = []
        for (const cb of callbacks) cb()
      }
    }

    // 从 transactionsRef 中删除已回滚的记录
    for (const id of rollbackSet) {
      this.engine.transactionsRef.current.delete(id)
    }

    // 阶段 5：分离保留的事务
    for (const id of preserveSet) {
      const record = this.engine.transactionsRef.current.get(id)
      if (record) {
        if (record.status === "committed") {
          this.engine.transactionsRef.current.delete(id)
        } else if (record.status === "active") {
          const needsDetach = record.parentId !== null && rollbackSet.has(record.parentId)
          if (needsDetach) {
            record.parentId = null
            const childDescendants = _getAllDescendants(id, this.engine.transactionsRef.current)
            const childOwnSet = new Set<string>()
            childOwnSet.add(id)
            for (const descId of childDescendants) {
              childOwnSet.add(descId)
            }
            let newSnapshot = this.snapshot
            for (
              let i = this.snapshotIndex;
              i < this.engine.actionLogRef.current.length;
              i++
            ) {
              const entry = this.engine.actionLogRef.current[i]!
              if (entry.skipped) continue
              if (entry.txId !== null && (rollbackSet.has(entry.txId) || childOwnSet.has(entry.txId))) continue
              newSnapshot = this.engine.reducer(newSnapshot, entry.action)
            }
            record.snapshot = newSnapshot
          }
        }
      }
    }

    // 清理每个活跃保留子树中已提交的后代。
    // 现在安全了，因为保留事务已是独立根。
    for (const id of preserveSet) {
      const record = this.engine.transactionsRef.current.get(id)
      if (record?.status === "active") {
        _cleanupCommittedDescendants(id, this.engine.transactionsRef.current)
      }
    }

    // 阶段 6：若无活跃事务剩余，清空所有内容。
    // action log 仅用于回滚重放；没有活跃事务就不可能回滚，
    // 日志纯属开销。
    if (!this._hasActiveTransactions()) {
      this.engine.actionLogRef.current = []
      this.engine.transactionsRef.current.clear()
      this.engine.generationRef.current.clear()
    }
  }

  // 仅回滚直接的活跃子事务，而非所有后代。
  // 每个子事务的 _rollback() 递归处理自己的子树，
  // 包括自己的 onError:"commit" 边界。
  _rollbackActiveDescendants(): void {
    const activeChildren: string[] = []
    for (const [, tx] of this.engine.transactionsRef.current) {
      if (tx.parentId === this.id && tx.status === "active") {
        activeChildren.push(tx.id)
      }
    }
    for (const id of activeChildren) {
      const tx = this.engine.transactionsRef.current.get(id)
      if (tx?.status === "active") {
        tx._rollback()
      }
    }
    let replayState = this.snapshot
    for (
      let i = this.snapshotIndex;
      i < this.engine.actionLogRef.current.length;
      i++
    ) {
      const entry = this.engine.actionLogRef.current[i]!
      if (entry.skipped) continue
      replayState = this.engine.reducer(replayState, entry.action)
    }
    this.engine.stateRef.current = replayState
    this.engine._notify()
  }

  private _hasActiveTransactions(): boolean {
    for (const tx of this.engine.transactionsRef.current.values()) {
      if (tx.status === "active") return true
    }
    return false
  }
}
