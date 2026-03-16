import { randomUUID } from 'crypto';
import type { Response } from 'express';
import type { Workflow, ExecutionContext, WorkflowEvent, RunStatus, ExecutorServices } from '../types.js';
import { runWorkflow } from '../engine/graph-runner.js';

const RUN_TTL_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

interface RunRecord {
  id: string;
  workflowId: string;
  workflowName: string;
  startedAt: string;
  status: RunStatus;
  context: ExecutionContext;
  events: WorkflowEvent[];
}

/**
 * Manages active and recent workflow runs with in-memory storage and TTL cleanup.
 */
export class RunManager {
  private static instance: RunManager;
  private runs = new Map<string, RunRecord>();
  private clients = new Map<string, Set<Response>>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private executorServices: ExecutorServices = {};

  static getInstance(): RunManager {
    if (!RunManager.instance) {
      RunManager.instance = new RunManager();
    }
    return RunManager.instance;
  }

  /** Inject service providers for executor dependency injection. */
  setServices(services: ExecutorServices): void {
    this.executorServices = services;
  }

  startRun(workflow: Workflow, triggerPayload?: unknown): string {
    const runId = randomUUID();
    const now = new Date().toISOString();

    const context: ExecutionContext = {
      runId,
      workflowId: workflow.id,
      variables: new Map(),
      nodeStates: new Map(),
      status: 'running',
      startedAt: now,
      cancelled: false,
      services: this.executorServices,
    };

    const record: RunRecord = {
      id: runId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      startedAt: now,
      status: 'running',
      context,
      events: [],
    };

    this.runs.set(runId, record);

    const emitter = (event: WorkflowEvent) => this.emit(runId, event);

    runWorkflow(workflow, emitter, triggerPayload, undefined, this.executorServices).then((ctx) => {
      const rec = this.runs.get(runId);
      if (rec) {
        rec.status = ctx.status;
        rec.context = ctx;
      }
    }).catch((err) => {
      const rec = this.runs.get(runId);
      if (rec) {
        rec.status = 'failed';
        rec.context.status = 'failed';
        this.emit(runId, { type: 'error', message: String(err) });
        this.closeClients(runId);
      }
    });

    return runId;
  }

  cancelRun(runId: string): boolean {
    const record = this.runs.get(runId);
    if (!record) return false;
    record.context.cancelled = true;
    return true;
  }

  getRun(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  listRuns(): RunRecord[] {
    return [...this.runs.values()].sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
  }

  addClient(runId: string, res: Response): void {
    let clients = this.clients.get(runId);
    if (!clients) {
      clients = new Set();
      this.clients.set(runId, clients);
    }
    clients.add(res);
  }

  removeClient(runId: string, res: Response): void {
    const clients = this.clients.get(runId);
    if (!clients) return;
    clients.delete(res);
    if (clients.size === 0) {
      this.clients.delete(runId);
    }
  }

  startCleanup(): void {
    if (this.cleanupInterval) return;
    this.cleanupInterval = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  shutdown(): void {
    this.stopCleanup();
    for (const record of this.runs.values()) {
      if (record.status === 'running') {
        record.context.cancelled = true;
      }
    }
    this.clients.clear();
  }

  private emit(runId: string, event: WorkflowEvent): void {
    const record = this.runs.get(runId);
    if (record) {
      record.events.push(event);
    }

    const clients = this.clients.get(runId);
    if (!clients) return;

    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) {
      try {
        res.write(data);
      } catch {
        clients.delete(res);
      }
    }

    // Close SSE connections on terminal events to prevent resource leak
    if (event.type === 'done') {
      this.closeClients(runId);
    }
  }

  private closeClients(runId: string): void {
    const clients = this.clients.get(runId);
    if (!clients) return;
    for (const res of clients) {
      try { res.end(); } catch {}
    }
    this.clients.delete(runId);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, record] of this.runs) {
      if (record.status === 'running') continue;
      const age = now - new Date(record.startedAt).getTime();
      if (age > RUN_TTL_MS) {
        this.runs.delete(id);
        this.clients.delete(id);
      }
    }
  }
}
