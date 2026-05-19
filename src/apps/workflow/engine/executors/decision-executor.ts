import type { ExecutorFunction, ExecutorResult, NodeConfig, ExecutionContext, SSEEmitter, DecisionConfig } from '../../types.js';
import { evaluate } from '../expression-evaluator.js';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Decision executor evaluates conditions and sets __decision_port.
 * The graph-runner's handleDecision() reads __decision_port to route edges —
 * this is the single source of truth for decision routing.
 */
export const decisionExecutor: ExecutorFunction = async (
  config: NodeConfig,
  context: ExecutionContext,
  _emit: SSEEmitter,
): Promise<ExecutorResult> => {
  const cfg = config as DecisionConfig;

  try {
    let selectedPort: string | undefined;

    switch (cfg.conditionType) {
      case 'exit-code': {
        // Use actual predecessors (set by graph-runner before execution)
        // rather than sorting all node states globally
        const predecessorIds = context.variables.get('__predecessor_ids') as string[] | undefined;
        let exitCode: number | undefined;

        if (predecessorIds && predecessorIds.length > 0) {
          // Use the most recently completed predecessor
          const predecessorStates = predecessorIds
            .map((id) => context.nodeStates.get(id))
            .filter((s) => s?.completedAt)
            .sort((a, b) => (b!.completedAt ?? '').localeCompare(a!.completedAt ?? ''));
          exitCode = predecessorStates[0]?.exitCode;
        }

        const code = exitCode ?? -1;
        for (const port of cfg.ports) {
          if (port.condition && String(code) === port.condition) {
            selectedPort = port.id;
            break;
          }
        }
        break;
      }

      case 'variable': {
        if (!cfg.variable) {
          return { status: 'failed', error: 'variable is required for variable condition type' };
        }
        const value = String(context.variables.get(cfg.variable) ?? '');

        for (const port of cfg.ports) {
          if (port.condition && value === port.condition) {
            selectedPort = port.id;
            break;
          }
        }
        break;
      }

      case 'expression': {
        for (const port of cfg.ports) {
          if (port.condition) {
            const match = evaluate(port.condition, context);
            if (match) {
              selectedPort = port.id;
              break;
            }
          }
        }
        break;
      }
    }

    if (!selectedPort && cfg.ports.length > 0) {
      const defaultPort = cfg.ports.find((p) => !p.condition) ?? cfg.ports[cfg.ports.length - 1];
      selectedPort = defaultPort.id;
    }

    return {
      status: 'passed',
      output: selectedPort,
      variables: { __decision_port: selectedPort },
    };
  } catch (err) {
    return { status: 'failed', error: errorMessage(err) };
  }
};
