import {
  Transaction,
  _generateId,
  _isDescendantOf,
  _cleanupCommittedDescendants,
  type Ref,
  type ActionLogEntry,
  type OnErrorStrategy,
  type OnDuplicateStrategy,
  type TransactionOptions,
  type TransactionHandle,
  type TransactionalReducerOptions,
  type TransactionEngine,
} from "./Transaction";

export type {
  Ref,
  ActionLogEntry,
  OnErrorStrategy,
  OnDuplicateStrategy,
  TransactionOptions,
  TransactionHandle,
  TransactionalReducerOptions,
};

export type { Transaction };

export class TransactionalReducer<S, A> implements TransactionEngine<S, A> {
  readonly reducer: (state: S, action: A) => S;
  readonly options: TransactionalReducerOptions<S> | undefined;
  readonly stateRef: Ref<S>;
  readonly actionLogRef: Ref<ActionLogEntry<A>[]>;
  readonly transactionsRef: Ref<Map<string, Transaction<S, A>>>;
  readonly generationRef: Ref<Map<string, number>>;

  private _listeners = new Set<(state: S) => void>();

  constructor(
    reducer: (state: S, action: A) => S,
    initialState: S,
    options?: TransactionalReducerOptions<S>,
  ) {
    this.reducer = reducer;
    this.options = options;
    this.stateRef = { current: initialState };
    this.actionLogRef = { current: [] };
    this.transactionsRef = { current: new Map() };
    this.generationRef = { current: new Map() };
  }

  get state(): S {
    return this.stateRef.current;
  }

  subscribe(listener: (state: S) => void): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  _notify(): void {
    const state = this.stateRef.current;
    for (const listener of this._listeners) {
      listener(state);
    }
  }

  // 非事务 dispatch 仅在有活跃事务时记录日志。
  // 这确保它们在回滚重放中被保留（txId:null，不在任何 rollbackSet 中）。
  // 无活跃事务时日志不必要——不可能发生回滚，因此跳过日志记录。
  dispatch(action: A): void {
    if (this._hasActiveTransactions()) {
      this.actionLogRef.current.push({ action, txId: null, generation: 0 });
    }
    this._applyAction(action);
  }

  run<R>(task: (tx: TransactionHandle<A>) => R, options?: TransactionOptions): R {
    const strategy = options?.onDuplicate ?? this.options?.onDuplicate ?? "rollback";
    if (strategy === "reuse" && options?.id) {
      const existing = this.transactionsRef.current.get(options.id);
      if (existing?.status === "active") {
        throw new Error(`Cannot run: transaction "${options.id}" is already active`);
      }
    }
    const tx = this._createTx(options?.id, null, options?.onError ?? "rollback", strategy);
    return this._runWithTx(tx, task);
  }

  create(options?: TransactionOptions): TransactionHandle<A> {
    const strategy = options?.onDuplicate ?? this.options?.onDuplicate ?? "rollback";
    if (strategy === "reuse" && options?.id) {
      const existing = this.transactionsRef.current.get(options.id);
      if (existing?.status === "active") return existing;
    }
    return this._createTx(options?.id, null, options?.onError ?? "rollback", strategy);
  }

  getTransaction(id: string): TransactionHandle<A> | undefined {
    return this.transactionsRef.current.get(id);
  }

  _applyAction(action: A): void {
    this.stateRef.current = this.reducer(this.stateRef.current, action);
    this._notify();
  }

  // ─── _createTx ────────────────────────────────────────────────────────
  //
  // 去重机制：如果相同 id 的活跃事务已存在，根据 onDuplicate 策略处理：
  //   - rollback：回滚旧事务再创建新的（默认，向后兼容）
  //   - commit：提交旧事务（含回滚其活跃子事务）再创建新的
  //   - reject：抛出错误，拒绝创建
  //   - reuse：不在 _createTx 内处理——由调用点（api.create/run/spawn）处理
  //
  // 回滚旧事务后，创建新的 Transaction 对象并赋予新的 generation。
  // 旧句柄变为过期，因为：
  //   - transactionsRef 中该 id 现在持有新对象
  //   - generationRef 中该 id 现有更高的 generation
  //
  // 关键：旧句柄的异步完成回调绝不能对过期句柄调用
  // _commit 或 _rollback，因为：
  //   - _commit 会从 transactionsRef 删除新事务（相同 id 键），
  //     破坏新事务的状态
  //   - _rollbackActiveDescendants 会找到新事务的子事务
  //     （parentId === this.id 匹配）并错误地回滚它们
  // 这就是 runWithTx 在 _commit/_rollback 前检查过期的原因。
  // ────────────────────────────────────────────────────────────────────────
  _createTx(
    id: string | undefined,
    parentId: string | null,
    onError: OnErrorStrategy,
    onDuplicate: OnDuplicateStrategy,
  ): Transaction<S, A> {
    const txId = id || this.options?.idGenerator?.() || _generateId();
    const existing = this.transactionsRef.current.get(txId);
    if (existing?.status === "active") {
      switch (onDuplicate) {
        case "rollback":
          existing._rollback();
          break;
        case "commit":
          existing._rollbackActiveDescendants();
          existing._commit();
          if (existing.parentId !== null) {
            for (let i = existing.snapshotIndex; i < this.actionLogRef.current.length; i++) {
              const entry = this.actionLogRef.current[i]!;
              if (entry.skipped) continue;
              if (
                entry.txId === existing.id ||
                _isDescendantOf(entry.txId, existing.id, this.transactionsRef.current)
              ) {
                this.actionLogRef.current[i] = {
                  action: entry.action,
                  txId: null,
                  generation: 0,
                };
              }
            }
            _cleanupCommittedDescendants(existing.id, this.transactionsRef.current);
          }
          break;
        case "reject":
          throw new Error(`Transaction "${txId}" is already active`);
        case "reuse":
          break;
      }
    }

    const generation = this._nextGeneration(txId);
    const snapshot = (this.options?.snapshot ?? structuredClone)(this.stateRef.current);
    const snapshotIndex = this.actionLogRef.current.length;

    const tx = new Transaction(this, txId, parentId, onError, generation, snapshot, snapshotIndex);

    this.transactionsRef.current.set(txId, tx);
    return tx;
  }

  // ─── _runWithTx ───────────────────────────────────────────────────────
  //
  // 包装任务函数，提供自动事务生命周期管理：
  //   - 成功 → 回滚活跃后代，然后提交
  //   - onError:"rollback" 的错误 → 回滚事务
  //   - onError:"commit" 的错误 → 回滚活跃后代，然后提交
  //
  // 对于异步任务，Promise 回调中的过期检查至关重要。
  // 在任务启动和 Promise resolve 之间，事务可能已过期
  // （例如 _createTx 用相同 id 替换了它）。过期句柄绝不能
  // 提交或回滚，因为：
  //   - 对过期根事务的 _commit 会从 transactionsRef 删除新事务
  //     （共享相同 id 键）
  //   - 对过期句柄的 _rollbackActiveDescendants 会找到新事务的
  //     子事务（parentId === this.id 匹配）并错误地回滚它们
  //
  // 对于同步任务，执行期间不可能过期（无异步暂停），无需检查。
  // ────────────────────────────────────────────────────────────────────────
  _runWithTx<R>(tx: Transaction<S, A>, task: (tx: TransactionHandle<A>) => R): R {
    try {
      const result = task(tx);
      if (result instanceof Promise) {
        return result.then(
          (r) => {
            // 过期检查：如果事务已被替换（例如第二次 run 使用相同 id），
            // 跳过提交——新事务现在拥有该 id。
            if (!tx.isStale()) {
              tx._rollbackActiveDescendants();
              tx._commit();
            }
            return r;
          },
          (e) => {
            if (tx.onError === "commit") {
              // onError:"commit" 表示出错时保留变更。
              // 仍需过期检查——过期句柄绝不能提交
              // （会从 transactionsRef 删除新事务）。
              if (!tx.isStale()) {
                tx._rollbackActiveDescendants();
                tx._commit();
              }
            } else {
              // _rollback 内部有自己的过期检查，
              // 此处无需额外检查。
              tx._rollback();
            }
            throw e;
          },
        ) as unknown as R;
      }
      // 同步成功：同步执行期间不可能过期
      tx._rollbackActiveDescendants();
      tx._commit();
      return result;
    } catch (e) {
      // 同步错误：同样不可能过期
      if (tx.onError === "commit") {
        tx._rollbackActiveDescendants();
        tx._commit();
      } else {
        tx._rollback();
      }
      throw e;
    }
  }

  private _nextGeneration(txId: string): number {
    const prev = this.generationRef.current.get(txId) ?? 0;
    const next = prev + 1;
    this.generationRef.current.set(txId, next);
    return next;
  }

  private _hasActiveTransactions(): boolean {
    for (const tx of this.transactionsRef.current.values()) {
      if (tx.status === "active") return true;
    }
    return false;
  }
}
