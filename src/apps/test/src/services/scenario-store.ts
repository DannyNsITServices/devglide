import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const DATA_FILE = path.join(DATA_DIR, "scenarios.json");

/**
 * JSON file-backed store for saved test scenarios.
 */
export class ScenarioStore {
  private static instance: ScenarioStore;
  private scenarios: SavedScenario[] = [];
  private loaded = false;
  private persistQueue: Promise<void> = Promise.resolve();

  static getInstance(): ScenarioStore {
    if (!ScenarioStore.instance) {
      ScenarioStore.instance = new ScenarioStore();
    }
    return ScenarioStore.instance;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    await this.reload();
  }

  private async reload(): Promise<void> {
    try {
      const raw = await fs.readFile(DATA_FILE, "utf-8");
      this.scenarios = JSON.parse(raw);
    } catch {
      this.scenarios = [];
    }
    this.loaded = true;
  }

  private persist(): Promise<void> {
    const write = async () => {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(DATA_FILE, JSON.stringify(this.scenarios, null, 2));
    };
    // Serialize writes to prevent concurrent persist() from corrupting the file
    this.persistQueue = this.persistQueue.then(write, write);
    return this.persistQueue;
  }

  async list(target: string): Promise<SavedScenario[]> {
    await this.reload();
    return this.scenarios.filter((s) => s.target === target);
  }

  async listAll(): Promise<SavedScenario[]> {
    await this.reload();
    return [...this.scenarios];
  }

  async get(id: string): Promise<SavedScenario | undefined> {
    await this.reload();
    return this.scenarios.find((s) => s.id === id);
  }

  async save(input: {
    name: string;
    description?: string;
    target: string;
    steps: TriggerStep[];
  }): Promise<SavedScenario> {
    await this.load();
    const scenario: SavedScenario = {
      id: uuidv4(),
      name: input.name,
      description: input.description,
      target: input.target,
      steps: input.steps,
      createdAt: new Date().toISOString(),
      runCount: 0,
    };
    this.scenarios.push(scenario);
    await this.persist();
    return scenario;
  }

  async update(id: string, input: {
    name?: string;
    description?: string;
    target?: string;
    steps?: TriggerStep[];
  }): Promise<SavedScenario | undefined> {
    await this.load();
    const scenario = this.scenarios.find((s) => s.id === id);
    if (!scenario) return undefined;
    if (input.name !== undefined) scenario.name = input.name;
    if (input.description !== undefined) scenario.description = input.description;
    if (input.target !== undefined) scenario.target = input.target;
    if (input.steps !== undefined) scenario.steps = input.steps;
    await this.persist();
    return scenario;
  }

  async delete(id: string): Promise<boolean> {
    await this.load();
    const idx = this.scenarios.findIndex((s) => s.id === id);
    if (idx === -1) return false;
    this.scenarios.splice(idx, 1);
    await this.persist();
    return true;
  }

  async markRun(id: string): Promise<SavedScenario | undefined> {
    await this.load();
    const scenario = this.scenarios.find((s) => s.id === id);
    if (!scenario) return undefined;
    scenario.lastRunAt = new Date().toISOString();
    scenario.runCount++;
    await this.persist();
    return scenario;
  }
}
