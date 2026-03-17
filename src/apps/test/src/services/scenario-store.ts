import fs from "fs/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { projectDataDir, DEVGLIDE_DIR, PROJECTS_DIR } from "../../../../packages/paths.js";
import { readActiveProjectId } from "../../../../packages/project-store.js";
import { getActiveProject } from "../../../../project-context.js";

interface TriggerStep {
  command: string;
  selector?: string;
  text?: string;
  value?: string;
  timeout?: number;
  ms?: number;
  clear?: boolean;
  contains?: boolean;
  path?: string;
}

export interface SavedScenario {
  id: string;
  name: string;
  description?: string;
  target: string;
  steps: TriggerStep[];
  createdAt: string;
  lastRunAt?: string;
  runCount: number;
}

/** Resolve scenarios.json path for the given project ID (or fallback). */
function getScenariosFile(projectId: string): string {
  return projectDataDir(projectId, 'scenarios.json');
}

/** Global fallback when no project is active. */
const GLOBAL_SCENARIOS_FILE = path.join(DEVGLIDE_DIR, 'scenarios.json');

/**
 * JSON file-backed store for saved test scenarios.
 * Scenarios are stored per-project: ~/.devglide/projects/{projectId}/scenarios.json
 * Falls back to ~/.devglide/scenarios.json when no project is active.
 */
export class ScenarioStore {
  private static instance: ScenarioStore;
  // Cache: dataFile → loaded scenarios
  private cache = new Map<string, SavedScenario[]>();
  private persistQueues = new Map<string, Promise<void>>();

  static getInstance(): ScenarioStore {
    if (!ScenarioStore.instance) {
      ScenarioStore.instance = new ScenarioStore();
    }
    return ScenarioStore.instance;
  }

  private getDataFile(projectId?: string): string {
    const id = projectId ?? getActiveProject()?.id ?? readActiveProjectId();
    return id ? getScenariosFile(id) : GLOBAL_SCENARIOS_FILE;
  }

  /** Pre-warm the cache for the active project. Called at startup. */
  async init(): Promise<void> {
    const dataFile = this.getDataFile();
    await this.load(dataFile);
  }

  private async load(dataFile: string): Promise<SavedScenario[]> {
    try {
      const raw = await fs.readFile(dataFile, "utf-8");
      const parsed = JSON.parse(raw);
      this.cache.set(dataFile, parsed);
      return parsed;
    } catch {
      this.cache.set(dataFile, []);
      return [];
    }
  }

  private async getScenarios(dataFile: string): Promise<SavedScenario[]> {
    await this.load(dataFile);
    return this.cache.get(dataFile)!;
  }

  private persist(dataFile: string, scenarios: SavedScenario[]): Promise<void> {
    const write = async () => {
      await fs.mkdir(path.dirname(dataFile), { recursive: true });
      await fs.writeFile(dataFile, JSON.stringify(scenarios, null, 2));
    };
    const prev = this.persistQueues.get(dataFile) ?? Promise.resolve();
    const next = prev.then(write, write);
    this.persistQueues.set(dataFile, next);
    return next;
  }

  async list(target: string): Promise<SavedScenario[]> {
    const dataFile = this.getDataFile();
    const scenarios = await this.getScenarios(dataFile);
    return scenarios.filter((s) => s.target === target || s.target === '');
  }

  async listAll(projectId?: string): Promise<SavedScenario[]> {
    if (!projectId) {
      // Collect from all project files + global
      const all: SavedScenario[] = [];
      const seen = new Set<string>();
      let ids: string[] = [];
      try { ids = await fs.readdir(PROJECTS_DIR); } catch { /* none */ }
      for (const id of ids) {
        const file = getScenariosFile(id);
        for (const s of await this.getScenarios(file)) {
          if (!seen.has(s.id)) { seen.add(s.id); all.push(s); }
        }
      }
      // Global fallback file
      for (const s of await this.getScenarios(GLOBAL_SCENARIOS_FILE)) {
        if (!seen.has(s.id)) { seen.add(s.id); all.push(s); }
      }
      return all;
    }
    return this.getScenarios(getScenariosFile(projectId));
  }

  async get(id: string): Promise<SavedScenario | undefined> {
    const dataFile = this.getDataFile();
    const scenarios = await this.getScenarios(dataFile);
    return scenarios.find((s) => s.id === id);
  }

  async save(input: {
    name: string;
    description?: string;
    target: string;
    steps: TriggerStep[];
    projectId?: string;
  }): Promise<SavedScenario> {
    const dataFile = this.getDataFile(input.projectId);
    const scenarios = await this.getScenarios(dataFile);
    const scenario: SavedScenario = {
      id: uuidv4(),
      name: input.name,
      description: input.description,
      target: input.target,
      steps: input.steps,
      createdAt: new Date().toISOString(),
      runCount: 0,
    };
    scenarios.push(scenario);
    await this.persist(dataFile, scenarios);
    return scenario;
  }

  async update(id: string, input: {
    name?: string;
    description?: string;
    target?: string;
    steps?: TriggerStep[];
  }): Promise<SavedScenario | undefined> {
    const dataFile = this.getDataFile();
    const scenarios = await this.getScenarios(dataFile);
    const scenario = scenarios.find((s) => s.id === id);
    if (!scenario) return undefined;
    if (input.name !== undefined) scenario.name = input.name;
    if (input.description !== undefined) scenario.description = input.description;
    if (input.target !== undefined) scenario.target = input.target;
    if (input.steps !== undefined) scenario.steps = input.steps;
    await this.persist(dataFile, scenarios);
    return scenario;
  }

  async delete(id: string): Promise<boolean> {
    const dataFile = this.getDataFile();
    const scenarios = await this.getScenarios(dataFile);
    const idx = scenarios.findIndex((s) => s.id === id);
    if (idx === -1) return false;
    scenarios.splice(idx, 1);
    await this.persist(dataFile, scenarios);
    return true;
  }

  async markRun(id: string): Promise<SavedScenario | undefined> {
    const dataFile = this.getDataFile();
    const scenarios = await this.getScenarios(dataFile);
    const scenario = scenarios.find((s) => s.id === id);
    if (!scenario) return undefined;
    scenario.lastRunAt = new Date().toISOString();
    scenario.runCount++;
    await this.persist(dataFile, scenarios);
    return scenario;
  }
}
