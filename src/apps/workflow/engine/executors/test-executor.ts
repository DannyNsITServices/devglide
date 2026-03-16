import type { ExecutorFunction, ExecutorResult, NodeConfig, ExecutionContext, SSEEmitter, TestConfig } from '../../types.js';

export const testExecutor: ExecutorFunction = async (
  config: NodeConfig,
  context: ExecutionContext,
  _emit: SSEEmitter,
): Promise<ExecutorResult> => {
  const cfg = config as TestConfig;
  const testService = context.services.test;

  if (!testService) {
    return { status: 'failed', error: 'Test services not available — ensure test module is initialized' };
  }

  try {
    switch (cfg.operation) {
      case 'run-scenario': {
        if (!cfg.steps || cfg.steps.length === 0) {
          return { status: 'failed', error: 'steps are required for run-scenario' };
        }
        const scenario = testService.submitScenario({
          name: 'workflow-test',
          steps: cfg.steps,
          target: cfg.target,
        });
        return { status: 'passed', output: scenario };
      }

      case 'run-saved': {
        if (!cfg.scenarioId) {
          return { status: 'failed', error: 'scenarioId is required for run-saved' };
        }
        const saved = await testService.getSavedScenario(cfg.scenarioId);
        if (!saved) {
          return { status: 'failed', error: `Scenario ${cfg.scenarioId} not found` };
        }
        const scenario = testService.submitScenario({
          name: saved.name,
          steps: saved.steps,
          target: saved.target,
        });
        await testService.markRun(cfg.scenarioId);
        return { status: 'passed', output: scenario };
      }

      case 'save-scenario': {
        if (!cfg.steps || !cfg.target) {
          return { status: 'failed', error: 'steps and target are required for save-scenario' };
        }
        const description = cfg.linkedItemId
          ? `Linked to kanban item: ${cfg.linkedItemId}`
          : undefined;
        const saved = await testService.saveScenario({
          name: 'workflow-test',
          description,
          target: cfg.target,
          steps: cfg.steps,
        });
        return { status: 'passed', output: saved };
      }

      case 'list-saved': {
        const list = await testService.listSaved();
        return { status: 'passed', output: list };
      }

      default:
        return { status: 'failed', error: `Unknown test operation: ${(cfg as TestConfig).operation}` };
    }
  } catch (err: unknown) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
};
