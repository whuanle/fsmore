import { randomUUID } from "node:crypto";

/**
 * 轻量任务管理器：同步任务的进度/日志/错误，供 REST 轮询与 SSE 订阅。
 */

export type JobStatus = "running" | "done" | "error";

export type Job = {
  id: string;
  kind: string;
  label: string;
  status: JobStatus;
  total: number;
  done: number;
  changed: number;
  skipped: number;
  failed: number;
  errors: string[];
  logs: string[];
  startedAt: string;
  finishedAt?: string;
  result?: unknown;
};

type Listener = (event: string, payload: unknown) => void;

const MAX_LOGS = 500;
const MAX_ERRORS = 100;

export class JobManager {
  private jobs = new Map<string, Job>();
  private listeners = new Map<string, Set<Listener>>();

  create(kind: string, label: string, total = 0): Job {
    const job: Job = {
      id: randomUUID(),
      kind,
      label,
      status: "running",
      total,
      done: 0,
      changed: 0,
      skipped: 0,
      failed: 0,
      errors: [],
      logs: [],
      startedAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    // 防泄漏：只保留最近 50 个任务
    if (this.jobs.size > 50) {
      const oldest = this.jobs.keys().next().value;
      if (oldest) {
        this.jobs.delete(oldest);
        this.listeners.delete(oldest);
      }
    }
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  patch(id: string, patch: Partial<Job>): void {
    const job = this.jobs.get(id);
    if (!job) {
      return;
    }
    Object.assign(job, patch);
    this.emit(id, "progress", this.snapshot(job));
  }

  log(id: string, message: string): void {
    const job = this.jobs.get(id);
    if (!job) {
      return;
    }
    job.logs.push(`${new Date().toISOString()} ${message}`);
    if (job.logs.length > MAX_LOGS) {
      job.logs.splice(0, job.logs.length - MAX_LOGS);
    }
    this.emit(id, "log", { message });
  }

  addError(id: string, message: string): void {
    const job = this.jobs.get(id);
    if (!job) {
      return;
    }
    job.errors.push(message);
    if (job.errors.length > MAX_ERRORS) {
      job.errors.splice(0, job.errors.length - MAX_ERRORS);
    }
    this.emit(id, "error", { message });
  }

  finish(id: string, result?: unknown): void {
    const job = this.jobs.get(id);
    if (!job) {
      return;
    }
    job.status = "done";
    job.finishedAt = new Date().toISOString();
    job.result = result;
    this.emit(id, "done", this.snapshot(job));
  }

  fail(id: string, message: string): void {
    const job = this.jobs.get(id);
    if (!job) {
      return;
    }
    job.status = "error";
    job.finishedAt = new Date().toISOString();
    job.errors.push(message);
    this.emit(id, "done", this.snapshot(job));
  }

  snapshot(job: Job): Job {
    return { ...job, logs: job.logs.slice(-50), errors: job.errors.slice(-50) };
  }

  subscribe(id: string, listener: Listener): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  private emit(id: string, event: string, payload: unknown): void {
    const set = this.listeners.get(id);
    if (!set) {
      return;
    }
    for (const listener of set) {
      try {
        listener(event, payload);
      } catch {
        // 订阅方异常不影响任务
      }
    }
  }
}
