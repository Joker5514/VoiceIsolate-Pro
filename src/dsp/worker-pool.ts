/**
 * VoiceIsolate Pro v14.0 – WorkerPool
 * ─────────────────────────────────────────────────────────
 * Concurrency layer providing:
 *   • Dynamic thread allocation (min/max thread bounds)
 *   • Priority queue (0=critical, 1=high, 2=normal, 3=low)
 *   • Work-stealing between idle workers
 *   • Backpressure signalling
 *   • Typed task/result messages via SharedArrayBuffer transfer
 *   • Per-worker performance telemetry
 *   • Graceful scale-down with idle TTL
 *
 * Usage:
 *   const pool = new WorkerPool('/workers/dsp-worker.js', { min: 2, max: 8 });
 *   await pool.start();
 *   const result = await pool.submit({ ... }, Priority.HIGH);
 *   pool.dispose();
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export const enum Priority {
  CRITICAL = 0,
  HIGH     = 1,
  NORMAL   = 2,
  LOW      = 3,
}

export interface WorkerTask<TPayload = unknown> {
  id: string;
  priority: Priority;
  payload: TPayload;
  /** Transferable objects to move (zero-copy) */
  transfer?: Transferable[];
  /** Reject task if not started within this many ms */
  timeoutMs?: number;
  /** Set internally; epoch ms when enqueued */
  enqueuedAt?: number;
}

export interface WorkerResult<TResult = unknown> {
  taskId: string;
  result?: TResult;
  error?: string;
  workerIndex: number;
  processedMs: number;
}

export interface WorkerPoolOptions {
  /** Minimum resident threads (always alive) */
  min: number;
  /** Maximum threads (hard cap) */
  max: number;
  /** Spawn new thread when queue depth exceeds this */
  scaleUpThreshold: number;
  /** Kill idle thread after this many ms */
  idleTimeoutMs: number;
  /** Optional initialisation message sent to each worker on spawn */
  initMessage?: unknown;
  /** Worker constructor options (e.g. { type: 'module' }) */
  workerOptions?: WorkerOptions;
  /** Max tasks in queue before rejecting (backpressure) */
  maxQueueDepth: number;
}

interface WorkerSlot {
  index:       number;
  worker:      Worker;
  busy:        boolean;
  taskCount:   number;
  totalMs:     number;
  idleSince:   number;
  idleTimer:   ReturnType<typeof setTimeout> | null;
  currentTask: PendingTask | null;
}

interface PendingTask<T = unknown, R = unknown> {
  task:    WorkerTask<T>;
  resolve: (r: R) => void;
  reject:  (e: Error) => void;
  timer:   ReturnType<typeof setTimeout> | null;
}

// ─── Priority Queue ──────────────────────────────────────────────────────────

class PriorityQueue<T extends { task: WorkerTask }> {
  private buckets: T[][] = [[], [], [], []]; // one per priority level
  private heads: number[] = [0, 0, 0, 0]; // ⚡ Bolt: offset tracker to avoid O(N) shift()
  private _size = 0;

  enqueue(item: T): void {
    const p = item.task.priority;
    this.buckets[p].push(item);
    this._size++;
  }

  dequeue(): T | undefined {
    for (let p = 0; p <= 3; p++) {
      if (this.buckets[p].length > this.heads[p]) {
        this._size--;
        const item = this.buckets[p][this.heads[p]];
        this.buckets[p][this.heads[p]] = undefined as unknown as T; // allow GC
        this.heads[p]++;

        // Cleanup to prevent memory leak
        if (this.heads[p] > 256 && this.heads[p] > this.buckets[p].length / 2) {
          this.buckets[p] = this.buckets[p].slice(this.heads[p]);
          this.heads[p] = 0;
        }

        return item;
      }
    }
    return undefined;
  }

  /** Peek at next item without removing */
  peek(): T | undefined {
    for (let p = 0; p <= 3; p++) {
      if (this.buckets[p].length > this.heads[p]) {
        return this.buckets[p][this.heads[p]];
      }
    }
    return undefined;
  }

  get size(): number { return this._size; }

  /** Drain all items in priority order */
  drainAll(): T[] {
    const items: T[] = [];
    let item: T | undefined;
    while ((item = this.dequeue())) items.push(item);
    return items;
  }

  /** Remove a specific task by id */
  remove(taskId: string): boolean {
    for (let p = 0; p < this.buckets.length; p++) {
      const bucket = this.buckets[p];
      const head = this.heads[p];
      for (let i = head; i < bucket.length; i++) {
        if (bucket[i]?.task.id === taskId) {
          bucket.splice(i, 1);
          this._size--;
          return true;
        }
      }
    }
    return false;
  }
}

// ─── WorkerPool ──────────────────────────────────────────────────────────────

export class WorkerPool<TPayload = unknown, TResult = unknown> {
  private readonly scriptUrl: string;
  private readonly opts: Required<WorkerPoolOptions>;
  private slots: WorkerSlot[] = [];
  private queue = new PriorityQueue<PendingTask<TPayload, TResult>>();
  private nextId = 0;
  private disposed = false;

  /** Telemetry snapshots */
  private metrics = {
    totalSubmitted:  0,
    totalCompleted:  0,
    totalRejected:   0,
    totalTimedOut:   0,
    totalDropped:    0,
    peakQueueDepth:  0,
    peakThreadCount: 0,
  };

  constructor(scriptUrl: string, options: Partial<WorkerPoolOptions> = {}) {
    this.scriptUrl = scriptUrl;
    this.opts = {
      min:               options.min              ?? 1,
      max:               options.max              ?? navigator.hardwareConcurrency ?? 4,
      scaleUpThreshold:  options.scaleUpThreshold ?? 3,
      idleTimeoutMs:     options.idleTimeoutMs    ?? 30_000,
      initMessage:       options.initMessage,
      workerOptions:     options.workerOptions    ?? {},
      maxQueueDepth:     options.maxQueueDepth    ?? 512,
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ────────────────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.disposed) throw new Error('WorkerPool already disposed');
    const spawns: Promise<void>[] = [];
    for (let i = 0; i < this.opts.min; i++) spawns.push(this.spawnWorker());
    await Promise.all(spawns);
  }

  /** Submit a task. Returns promise that resolves with the result. */
  submit(
    task: Omit<WorkerTask<TPayload>, 'id' | 'enqueuedAt'> & { id?: string },
    priority: Priority = Priority.NORMAL
  ): Promise<TResult> {
    if (this.disposed) return Promise.reject(new Error('WorkerPool disposed'));

    if (this.queue.size >= this.opts.maxQueueDepth) {
      this.metrics.totalRejected++;
      return Promise.reject(new Error(`WorkerPool backpressure: queue depth ${this.queue.size}`));
    }

    const fullTask: WorkerTask<TPayload> = {
      ...task,
      id:          task.id ?? `task-${this.nextId++}`,
      priority:    priority ?? task.priority ?? Priority.NORMAL,
      enqueuedAt:  Date.now(),
    };

    this.metrics.totalSubmitted++;

    return new Promise<TResult>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;

      if (fullTask.timeoutMs) {
        timer = setTimeout(() => {
          this.queue.remove(fullTask.id);
          this.metrics.totalTimedOut++;
          reject(new Error(`Task ${fullTask.id} timed out after ${fullTask.timeoutMs}ms`));
        }, fullTask.timeoutMs);
      }

      const pending: PendingTask<TPayload, TResult> = {
        task: fullTask,
        resolve,
        reject,
        timer,
      };

      this.queue.enqueue(pending);
      if (this.queue.size > this.metrics.peakQueueDepth) {
        this.metrics.peakQueueDepth = this.queue.size;
      }

      this.scheduleDispatch();
    });
  }

  /** Cancel a queued (not yet dispatched) task */
  cancel(taskId: string): boolean {
    const removed = this.queue.remove(taskId);
    if (removed) this.metrics.totalDropped++;
    return removed;
  }

  /** Drain queue and wait for all active tasks to finish */
  async drain(): Promise<void> {
    const pending = this.slots
      .filter((s) => s.busy && s.currentTask)
      .map(
        (s) =>
          new Promise<void>((res) => {
            const orig = s.currentTask!.resolve;
            s.currentTask!.resolve = (r) => { orig(r); res(); };
          })
      );
    await Promise.allSettled(pending);
  }

  dispose(): void {
    this.disposed = true;
    // Reject all queued tasks
    const remaining = this.queue.drainAll();
    for (const p of remaining) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error('WorkerPool disposed'));
    }
    // Terminate all workers
    for (const slot of this.slots) {
      if (slot.idleTimer) clearTimeout(slot.idleTimer);
      slot.worker.terminate();
    }
    this.slots = [];
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Internal dispatch
  // ────────────────────────────────────────────────────────────────────────────

  private scheduleDispatch(): void {
    // Try immediate dispatch first
    const idleSlot = this.slots.find((s) => !s.busy);
    if (idleSlot) {
      this.dispatch(idleSlot);
      return;
    }

    // Scale up if below max and queue is deep enough
    if (
      this.slots.length < this.opts.max &&
      this.queue.size >= this.opts.scaleUpThreshold
    ) {
      this.spawnWorker().then(() => {
        const newSlot = this.slots[this.slots.length - 1];
        if (newSlot && !newSlot.busy) this.dispatch(newSlot);
      });
    }
  }

  private dispatch(slot: WorkerSlot): void {
    const pending = this.queue.dequeue();
    if (!pending) return;

    if (slot.idleTimer) { clearTimeout(slot.idleTimer); slot.idleTimer = null; }
    slot.busy = true;
    slot.currentTask = pending;

    const startedAt = Date.now();
    const msg = { taskId: pending.task.id, payload: pending.task.payload };
    const transfer = pending.task.transfer ?? [];
    slot.worker.postMessage(msg, transfer);

    // Set up result handler (one-shot listener per task)
    const onMessage = (ev: MessageEvent<WorkerResult<TResult>>) => {
      if (ev.data.taskId !== pending.task.id) return;
      slot.worker.removeEventListener('message', onMessage);
      slot.worker.removeEventListener('error', onError);

      const elapsed = Date.now() - startedAt;
      slot.taskCount++;
      slot.totalMs += elapsed;
      slot.busy = false;
      slot.currentTask = null;
      this.metrics.totalCompleted++;

      if (pending.timer) clearTimeout(pending.timer);

      if (ev.data.error) {
        pending.reject(new Error(ev.data.error));
      } else {
        pending.resolve(ev.data.result as TResult);
      }

      // Try to pick up the next task (work-stealing)
      this.onWorkerFree(slot);
    };

    const onError = (ev: ErrorEvent) => {
      slot.worker.removeEventListener('message', onMessage);
      slot.worker.removeEventListener('error', onError);
      slot.busy = false;
      slot.currentTask = null;
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error(ev.message));
      this.onWorkerFree(slot);
    };

    slot.worker.addEventListener('message', onMessage);
    slot.worker.addEventListener('error', onError);
  }

  private onWorkerFree(slot: WorkerSlot): void {
    const next = this.queue.peek();
    if (next) {
      this.dispatch(slot);
    } else {
      // Start idle TTL countdown for non-min workers
      slot.idleSince = Date.now();
      if (this.slots.length > this.opts.min) {
        slot.idleTimer = setTimeout(() => this.retireWorker(slot), this.opts.idleTimeoutMs);
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Worker lifecycle
  // ────────────────────────────────────────────────────────────────────────────

  private async spawnWorker(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const worker = new Worker(this.scriptUrl, this.opts.workerOptions);
      const idx = this.slots.length;

      const slot: WorkerSlot = {
        index:       idx,
        worker,
        busy:        false,
        taskCount:   0,
        totalMs:     0,
        idleSince:   Date.now(),
        idleTimer:   null,
        currentTask: null,
      };

      // Wait for worker ready signal
      const onReady = (ev: MessageEvent) => {
        if (ev.data?.type === 'ready') {
          worker.removeEventListener('message', onReady);
          this.slots.push(slot);
          if (this.slots.length > this.metrics.peakThreadCount) {
            this.metrics.peakThreadCount = this.slots.length;
          }
          resolve();
        }
      };

      const onInitError = (ev: ErrorEvent) => {
        worker.removeEventListener('error', onInitError);
        reject(new Error(`Worker spawn failed: ${ev.message}`));
      };

      worker.addEventListener('message', onReady);
      worker.addEventListener('error', onInitError);

      // Send init message if configured
      if (this.opts.initMessage) {
        worker.postMessage({ type: 'init', config: this.opts.initMessage });
      } else {
        // Workers that don't need init fire ready themselves; emit for simple workers
        // Emit a synthetic ready if no initMessage (worker must still post { type: 'ready' })
      }

      // Safety fallback: if worker doesn't ack within 5s, reject
      setTimeout(() => reject(new Error('Worker init timeout')), 5000);
    });
  }

  private retireWorker(slot: WorkerSlot): void {
    if (slot.busy || this.slots.length <= this.opts.min) return;
    slot.worker.terminate();
    this.slots = this.slots.filter((s) => s.index !== slot.index);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Telemetry
  // ────────────────────────────────────────────────────────────────────────────

  getMetrics() {
    return {
      ...this.metrics,
      activeThreads:  this.slots.filter((s) => s.busy).length,
      idleThreads:    this.slots.filter((s) => !s.busy).length,
      totalThreads:   this.slots.length,
      queueDepth:     this.queue.size,
      workerStats: this.slots.map((s) => ({
        index:     s.index,
        busy:      s.busy,
        taskCount: s.taskCount,
        avgMs:     s.taskCount ? s.totalMs / s.taskCount : 0,
        idleSince: s.idleSince,
      })),
    };
  }

  /** Get count of threads actively processing */
  get activeCount(): number {
    return this.slots.filter((s) => s.busy).length;
  }

  get queueDepth(): number {
    return this.queue.size;
  }
}

// ─── DSP-specific pool factory ───────────────────────────────────────────────

export interface DSPTaskPayload {
  type: 'processChunk' | 'analyzeNoise' | 'applyGain';
  audioData: Float32Array;
  sampleRate: number;
  config?: Record<string, number>;
}

export interface DSPTaskResult {
  audioData: Float32Array;
  metrics: { peakDB: number; rmsDB: number; processedMs: number };
}

/**
 * Create a WorkerPool pre-configured for DSP work.
 * Spawns up to `maxWorkers` threads, scales dynamically.
 */
export function createDSPWorkerPool(
  workerScript: string,
  maxWorkers = Math.min(navigator.hardwareConcurrency ?? 4, 8)
): WorkerPool<DSPTaskPayload, DSPTaskResult> {
  return new WorkerPool<DSPTaskPayload, DSPTaskResult>(workerScript, {
    min:               1,
    max:               maxWorkers,
    scaleUpThreshold:  2,
    idleTimeoutMs:     20_000,
    maxQueueDepth:     256,
    workerOptions:     { type: 'module' },
  });
}

// ─── Decode pool factory ─────────────────────────────────────────────────────

export interface DecodeTaskPayload {
  fileBuffer: ArrayBuffer;
  fileName:   string;
  outputSr:   number;
}

export interface DecodeTaskResult {
  pcm:        Float32Array;
  sampleRate: number;
  channels:   number;
  durationSec: number;
}

export function createDecodeWorkerPool(
  workerScript: string,
  maxWorkers = 2
): WorkerPool<DecodeTaskPayload, DecodeTaskResult> {
  return new WorkerPool<DecodeTaskPayload, DecodeTaskResult>(workerScript, {
    min:               1,
    max:               maxWorkers,
    scaleUpThreshold:  1,
    idleTimeoutMs:     60_000,
    maxQueueDepth:     32,
    workerOptions:     { type: 'module' },
  });
}

// ─── Shared-memory batch helper ───────────────────────────────────────────────

/**
 * Partition a large Float32Array into chunks and submit each as a task.
 * Results are stitched back in order.
 */
export async function submitBatch<R>(
  pool: WorkerPool,
  chunks: Float32Array[],
  makePayload: (chunk: Float32Array, idx: number) => unknown,
  priority = Priority.NORMAL
): Promise<R[]> {
  const promises = chunks.map((chunk, i) =>
    pool.submit(
      {
        payload:  makePayload(chunk, i),
        priority,
        transfer: [chunk.buffer],
      },
      priority
    ) as Promise<R>
  );
  return Promise.all(promises);
}
