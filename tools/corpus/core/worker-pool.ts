import { Worker } from "node:worker_threads";

import {
  canonicalizeBatch,
  type CanonicalizationBatchResult,
  type CanonicalizationInput
} from "./canonicalize-batch.js";

interface Task {
  readonly id: number;
  readonly inputs: readonly CanonicalizationInput[];
  readonly resolve: (result: CanonicalizationBatchResult) => void;
  readonly reject: (error: Error) => void;
}

interface WorkerState {
  readonly worker: Worker;
  task?: Task;
}

export class CanonicalizationWorkerPool {
  readonly size: number;
  readonly capacity: number;
  private nextTaskId = 1;
  private readonly workers: WorkerState[] = [];
  private readonly queue: Task[] = [];
  private failure: Error | undefined;

  constructor (size: number) {
    if (!Number.isInteger(size) || size < 0) throw new Error("Worker count must be non-negative");
    this.size = size;
    this.capacity = Math.max(1, size * 2);
    for (let index = 0; index < size; index += 1) {
      const worker = new Worker(new URL("./canonicalize-worker.ts", import.meta.url));
      const state: WorkerState = { worker };
      worker.on("message", (message: { id: number; result: CanonicalizationBatchResult }) => {
        if (state.task?.id !== message.id) {
          this.fail(new Error("Canonicalization worker returned an unexpected task ID"));
          return;
        }
        const task = state.task;
        delete state.task;
        task.resolve(message.result);
        this.dispatch();
      });
      worker.on("error", error => this.fail(error));
      worker.on("exit", code => {
        if (code !== 0 && this.failure === undefined) {
          this.fail(new Error(`Canonicalization worker exited with code ${code}`));
        }
      });
      this.workers.push(state);
    }
  }

  private fail (error: Error): void {
    if (this.failure !== undefined) return;
    this.failure = error;
    for (const task of this.queue.splice(0)) task.reject(error);
    for (const state of this.workers) {
      if (state.task !== undefined) {
        state.task.reject(error);
        delete state.task;
      }
    }
  }

  private dispatch (): void {
    if (this.failure !== undefined) return;
    for (const state of this.workers) {
      if (state.task !== undefined) continue;
      const task = this.queue.shift();
      if (task === undefined) break;
      state.task = task;
      state.worker.postMessage({ id: task.id, inputs: task.inputs });
    }
  }

  async run (inputs: readonly CanonicalizationInput[]): Promise<CanonicalizationBatchResult> {
    if (this.failure !== undefined) throw this.failure;
    if (this.size === 0) return canonicalizeBatch(inputs);
    return await new Promise<CanonicalizationBatchResult>((resolve, reject) => {
      this.queue.push({ id: this.nextTaskId++, inputs, resolve, reject });
      this.dispatch();
    });
  }

  async close (): Promise<void> {
    await Promise.all(this.workers.map(async state => await state.worker.terminate()));
  }
}
