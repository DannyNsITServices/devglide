import type { ExecutorFunction, ExecutorResult, NodeConfig, ExecutionContext, SSEEmitter, KanbanConfig } from '../../types.js';
import { getDb, nowIso, appendVersionedEntry } from '../../../../apps/kanban/src/db.js';
import { createKanbanItem, resolveColumnId } from '../../../../apps/kanban/src/kanban-create-helper.js';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const kanbanExecutor: ExecutorFunction = async (
  config: NodeConfig,
  _context: ExecutionContext,
  _emit: SSEEmitter,
): Promise<ExecutorResult> => {
  const cfg = config as KanbanConfig;
  const db = getDb(_context.project?.id);

  try {
    switch (cfg.operation) {
      case 'create': {
        if (!cfg.featureId || !cfg.title) {
          return { status: 'failed', error: 'featureId and title are required for create' };
        }

        const result = createKanbanItem(db, {
          title: cfg.title,
          description: cfg.description,
          featureId: cfg.featureId,
          columnName: cfg.columnName,
          priority: cfg.priority,
          type: cfg.type,
        });

        if (!result.ok) return { status: 'failed', error: result.error };
        return { status: 'passed', output: result.item };
      }

      case 'move': {
        if (!cfg.itemId || !cfg.columnName) {
          return { status: 'failed', error: 'itemId and columnName are required for move' };
        }

        const item = db.prepare(`SELECT * FROM "Issue" WHERE "id" = ?`).get(cfg.itemId) as { projectId: string } | undefined;
        if (!item) {
          return { status: 'failed', error: `Issue ${cfg.itemId} not found` };
        }

        const columnId = resolveColumnId(db, item.projectId, cfg.columnName);
        if (!columnId) {
          return { status: 'failed', error: `Column "${cfg.columnName}" not found` };
        }

        const maxOrder = db.prepare(
          `SELECT MAX("order") AS maxOrd FROM "Issue" WHERE "columnId" = ?`
        ).get(columnId) as { maxOrd: number | null } | undefined;

        const order = (maxOrder?.maxOrd ?? -1) + 1;

        db.prepare(
          `UPDATE "Issue" SET "columnId" = ?, "order" = ?, "updatedAt" = ? WHERE "id" = ?`
        ).run(columnId, order, nowIso(), cfg.itemId);

        const updated = db.prepare(`SELECT * FROM "Issue" WHERE "id" = ?`).get(cfg.itemId);
        return { status: 'passed', output: updated };
      }

      case 'update': {
        if (!cfg.itemId) {
          return { status: 'failed', error: 'itemId is required for update' };
        }

        const sets: string[] = [];
        const params: unknown[] = [];

        if (cfg.title) { sets.push(`"title" = ?`); params.push(cfg.title); }
        if (cfg.description !== undefined) { sets.push(`"description" = ?`); params.push(cfg.description); }

        if (sets.length === 0) {
          return { status: 'failed', error: 'No fields to update' };
        }

        sets.push(`"updatedAt" = ?`);
        params.push(nowIso());
        params.push(cfg.itemId);

        db.prepare(`UPDATE "Issue" SET ${sets.join(', ')} WHERE "id" = ?`).run(...params);

        const updated = db.prepare(`SELECT * FROM "Issue" WHERE "id" = ?`).get(cfg.itemId);
        return { status: 'passed', output: updated };
      }

      case 'append-work-log': {
        if (!cfg.itemId || !cfg.content) {
          return { status: 'failed', error: 'itemId and content are required for append-work-log' };
        }
        const entry = appendVersionedEntry(db, cfg.itemId, 'work_log', cfg.content);
        return { status: 'passed', output: entry };
      }

      case 'append-review': {
        if (!cfg.itemId || !cfg.content) {
          return { status: 'failed', error: 'itemId and content are required for append-review' };
        }
        const entry = appendVersionedEntry(db, cfg.itemId, 'review', cfg.content);
        return { status: 'passed', output: entry };
      }

      case 'list': {
        let query = `SELECT * FROM "Issue" WHERE 1=1`;
        const params: unknown[] = [];

        if (cfg.featureId) {
          query += ` AND "projectId" = ?`;
          params.push(cfg.featureId);
        }

        if (cfg.columnName && cfg.featureId) {
          const columnId = resolveColumnId(db, cfg.featureId, cfg.columnName);
          if (columnId) {
            query += ` AND "columnId" = ?`;
            params.push(columnId);
          }
        }

        query += ` ORDER BY "order" ASC`;
        const issues = db.prepare(query).all(...params);
        return { status: 'passed', output: issues };
      }

      default:
        return { status: 'failed', error: `Unknown kanban operation: ${(cfg as KanbanConfig).operation}` };
    }
  } catch (err) {
    return { status: 'failed', error: errorMessage(err) };
  }
};
