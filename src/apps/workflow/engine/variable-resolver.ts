import type { ExecutionContext } from '../types.js';

const PLACEHOLDER_RE = /\{\{\s*([\w.[\]]+)\s*\}\}/g;

export class VariableResolver {
  resolve(template: string, context: ExecutionContext): string {
    return template.replace(PLACEHOLDER_RE, (_match, path: string) => {
      const value = this.resolvePath(path, context);
      return value === undefined ? '' : String(value);
    });
  }

  resolveObject<T>(obj: T, context: ExecutionContext): T {
    return this.deepResolve(structuredClone(obj), context) as T;
  }

  private deepResolve(value: unknown, context: ExecutionContext): unknown {
    if (typeof value === 'string') {
      return this.resolve(value, context);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.deepResolve(item, context));
    }
    if (value !== null && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        result[key] = this.deepResolve(val, context);
      }
      return result;
    }
    return value;
  }

  private resolvePath(path: string, context: ExecutionContext): unknown {
    const segments = path.split('.');

    switch (segments[0]) {
      case 'steps':
        return this.resolveSteps(segments.slice(1), context);
      case 'project':
        return this.resolveProject(segments.slice(1), context);
      case 'loop':
        return this.resolveLoop(segments.slice(1), context);
      case 'trigger':
        return this.resolveTrigger(segments.slice(1), context);
      case 'env':
        return segments[1] ? process.env[segments[1]] : undefined;
      case 'variables':
        return segments[1] ? context.variables.get(segments[1]) : undefined;
      default:
        return undefined;
    }
  }

  private resolveSteps(segments: string[], context: ExecutionContext): unknown {
    if (segments.length < 2) return undefined;
    const nodeId = segments[0];
    const state = context.nodeStates.get(nodeId);
    if (!state) return undefined;

    const field = segments[1];
    switch (field) {
      case 'output':
        return state.output;
      case 'exitCode':
        return state.exitCode;
      case 'status':
        return state.status;
      case 'error':
        return state.error;
      default:
        return undefined;
    }
  }

  private resolveProject(segments: string[], context: ExecutionContext): unknown {
    if (!context.project || segments.length === 0) return undefined;
    switch (segments[0]) {
      case 'name':
        return context.project.name;
      case 'path':
        return context.project.path;
      case 'id':
        return context.project.id;
      default:
        return undefined;
    }
  }

  private resolveLoop(segments: string[], context: ExecutionContext): unknown {
    if (!context.loopContext || segments.length === 0) return undefined;
    switch (segments[0]) {
      case 'index':
        return context.loopContext.index;
      case 'item':
        return context.loopContext.item;
      default:
        return undefined;
    }
  }

  private resolveTrigger(segments: string[], context: ExecutionContext): unknown {
    if (segments.length === 0) return undefined;
    if (segments[0] === 'payload') {
      return context.variables.get('__triggerPayload');
    }
    return undefined;
  }
}
