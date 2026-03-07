export interface PoolTask {
  type: string;
  payload?: any;
  transferables?: Transferable[];
}

export class WorkerPool {
  private workers: Worker[] = [];
  private poolSize: number;
  private workerScriptPath: string;
  private currentWorkerIndex = 0;
  private taskPromises: Map<string, { resolve: Function; reject: Function }> = new Map();

  constructor(workerScriptPath: string) {
    this.workerScriptPath = workerScriptPath;
    
    // Clamp between 4 and 8 workers based on hardware threads
    const cores = navigator.hardwareConcurrency || 4;
    this.poolSize = Math.max(4, Math.min(8, cores));
    
    this.initPool();
  }

  private initPool() {
    for (let i = 0; i < this.poolSize; i++) {
      this.spawnWorker(i);
    }
  }

  private spawnWorker(index: number) {
    const worker = new Worker(this.workerScriptPath, { type: 'module' });
    
    worker.onmessage = (e: MessageEvent) => {
      const { id, success, data, error } = e.data;
      const promiseHandlers = this.taskPromises.get(id);
      
      if (promiseHandlers) {
        if (success) {
          promiseHandlers.resolve(data);
        } else {
          promiseHandlers.reject(new Error(error));
        }
        this.taskPromises.delete(id);
      }
    };

    worker.onerror = (e: ErrorEvent) => {
      console.error(`Worker ${index} crashed. Restarting...`, e.message);
      worker.terminate();
      this.spawnWorker(index); // Auto-heal
    };

    this.workers[index] = worker;
  }

  public dispatch(task: PoolTask): Promise<any> {
    return new Promise((resolve, reject) => {
      const taskId = crypto.randomUUID();
      this.taskPromises.set(taskId, { resolve, reject });

      // Round-robin selection
      const worker = this.workers[this.currentWorkerIndex];
      this.currentWorkerIndex = (this.currentWorkerIndex + 1) % this.poolSize;

      // Note: If using SharedArrayBuffer in payload, omit from transferables array to utilize zero-copy
      worker.postMessage(
        { id: taskId, type: task.type, payload: task.payload },
        task.transferables || []
      );
    });
  }

  public broadcast(task: PoolTask): Promise<any[]> {
    const promises = this.workers.map((worker) => {
      return new Promise((resolve, reject) => {
        const taskId = crypto.randomUUID();
        this.taskPromises.set(taskId, { resolve, reject });
        worker.postMessage({ id: taskId, type: task.type, payload: task.payload });
      });
    });
    return Promise.all(promises);
  }

  public terminateAll() {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
  }
}
