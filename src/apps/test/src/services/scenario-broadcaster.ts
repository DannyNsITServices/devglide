import type { Response } from 'express';

/**
 * Manages SSE client connections, heartbeats, and broadcast logic
 * for scenario delivery to browser targets.
 */
export class ScenarioBroadcaster {
  private static instance: ScenarioBroadcaster;
  private clients = new Map<string, Set<Response>>();
  private heartbeatTimer: ReturnType<typeof setInterval>;

  private constructor() {
    this.heartbeatTimer = setInterval(() => {
      for (const clientSet of this.clients.values()) {
        for (const res of clientSet) {
          try { res.write(': heartbeat\n\n'); } catch { /* cleaned up on close */ }
        }
      }
    }, 30_000);
    this.heartbeatTimer.unref();
  }

  static getInstance(): ScenarioBroadcaster {
    if (!ScenarioBroadcaster.instance) {
      ScenarioBroadcaster.instance = new ScenarioBroadcaster();
    }
    return ScenarioBroadcaster.instance;
  }

  /** Add an SSE client for a given target key. Returns a cleanup function. */
  addClient(key: string, res: Response): () => void {
    if (!this.clients.has(key)) {
      this.clients.set(key, new Set());
    }
    this.clients.get(key)!.add(res);

    return () => {
      const clientSet = this.clients.get(key);
      if (clientSet) {
        clientSet.delete(res);
        if (clientSet.size === 0) this.clients.delete(key);
      }
    };
  }

  /**
   * Broadcast a scenario payload to all SSE clients for a target key.
   * Returns true only if the payload was written to at least one client whose
   * socket is still writable — the caller drops the queued copy on `true`, so
   * counting a dead-but-not-yet-removed connection would lose the scenario.
   */
  broadcast(key: string, scenario: unknown): boolean {
    const clients = this.clients.get(key);
    if (!clients || clients.size === 0) return false;
    const payload = `data: ${JSON.stringify(scenario)}\n\n`;
    let delivered = false;
    for (const res of clients) {
      if (res.writableEnded || res.destroyed) continue;
      try {
        res.write(payload);
        delivered = true;
      } catch { /* cleaned up on close */ }
    }
    return delivered;
  }

  shutdown(): void {
    clearInterval(this.heartbeatTimer);
    this.clients.clear();
  }
}
