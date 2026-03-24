import path from "path";
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

interface Scenario {
  id: string;
  name?: string;
  description?: string;
  steps: TriggerStep[];
  target?: string;
  createdAt: string;
}

export interface ScenarioResult {
  id: string;
  status: "passed" | "failed";
  failedStep?: number;
  error?: string;
  duration?: number;
  target?: string;
  createdAt: string;
}

/**
 * In-memory scenario store with 5-minute auto-cleanup.
 */
export class ScenarioManager {
  private static instance: ScenarioManager;

  private scenariosByTarget = new Map<string, Scenario[]>();
  private scenarioTargets = new Map<string, string>();
  private results = new Map<string, ScenarioResult>();
  private knownTargets = new Set<string>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  static getInstance(): ScenarioManager {
    if (!ScenarioManager.instance) {
      ScenarioManager.instance = new ScenarioManager();
    }
    return ScenarioManager.instance;
  }

  submitScenario(body: {
    name?: string;
    description?: string;
    steps?: TriggerStep[];
    target?: string;
  }): Scenario {
    const scenario: Scenario = {
      id: uuidv4(),
      name: body.name,
      description: body.description,
      steps: body.steps || [],
      target: body.target,
      createdAt: new Date().toISOString(),
    };

    const key = this.targetKey(scenario.target);

    const queue = this.scenariosByTarget.get(key) || [];
    queue.push(scenario);
    this.scenariosByTarget.set(key, queue);

    if (scenario.target) {
      this.scenarioTargets.set(scenario.id, key);
    }

    return scenario;
  }

  setResult(id: string, result: Omit<ScenarioResult, "id" | "createdAt" | "target">): ScenarioResult {
    const entry: ScenarioResult = {
      id,
      ...result,
      target: this.scenarioTargets.get(id),
      createdAt: new Date().toISOString(),
    };
    this.results.set(id, entry);
    this.scenarioTargets.delete(id);
    return entry;
  }

  getResult(id: string): ScenarioResult | undefined {
    return this.results.get(id);
  }

  listResults(projectPath?: string | null): ScenarioResult[] {
    if (!projectPath) return [];
    const all = Array.from(this.results.values());
    const prefix = projectPath;
    const basename = path.basename(projectPath);
    return all.filter((r) => {
      if (!r.target) return false;
      return r.target.startsWith(prefix) || r.target === basename;
    });
  }

  dequeueScenario(target: string): Scenario | undefined {
    // Track every absolute path that browsers poll with
    if (path.isAbsolute(target)) {
      this.knownTargets.add(target);
    }

    const key = this.targetKey(target);
    const queue = this.scenariosByTarget.get(key);
    if (queue && queue.length > 0) {
      const scenario = queue.shift()!;
      if (queue.length === 0) this.scenariosByTarget.delete(key);
      return scenario;
    }

    // Fallback: browser polls with absolute path, check for unresolved app-name keys
    if (path.isAbsolute(target)) {
      const basename = path.basename(target);
      const fallbackQueue = this.scenariosByTarget.get(basename);
      if (fallbackQueue && fallbackQueue.length > 0) {
        const scenario = fallbackQueue.shift()!;
        if (fallbackQueue.length === 0) this.scenariosByTarget.delete(basename);
        return scenario;
      }
    }

    return undefined;
  }

  startCleanup(): void {
    if (this.cleanupInterval) return;
    this.cleanupInterval = setInterval(() => this.cleanupStale(), 60_000);
  }

  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  private cleanupStale(): void {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [key, queue] of this.scenariosByTarget) {
      const filtered = queue.filter(
        (s) => new Date(s.createdAt).getTime() >= cutoff
      );
      if (filtered.length === 0) {
        this.scenariosByTarget.delete(key);
      } else {
        this.scenariosByTarget.set(key, filtered);
      }
    }
    for (const [id, result] of this.results) {
      if (new Date(result.createdAt).getTime() < cutoff) {
        this.results.delete(id);
      }
    }
    // Clean orphaned target mappings (scenario submitted but never completed)
    for (const id of this.scenarioTargets.keys()) {
      if (!this.results.has(id)) {
        // Check if scenario is still queued
        let found = false;
        for (const queue of this.scenariosByTarget.values()) {
          if (queue.some((s) => s.id === id)) { found = true; break; }
        }
        if (!found) this.scenarioTargets.delete(id);
      }
    }
  }

  /**
   * Public wrapper for targetKey — used by the SSE broadcast layer
   * to resolve a target string to its canonical key.
   */
  resolveTargetKey(target?: string): string {
    return this.targetKey(target);
  }

  /**
   * Register an absolute target path as known (normally done by dequeue,
   * but SSE clients also need to register themselves).
   */
  registerTarget(target: string): void {
    if (path.isAbsolute(target)) {
      this.knownTargets.add(target);
    }
  }

  private targetKey(target?: string): string {
    if (!target) return "";
    // Already an absolute path — use as-is
    if (path.isAbsolute(target)) return target;
    // App name — find a known target whose basename matches
    for (const known of this.knownTargets) {
      if (path.basename(known) === target) return known;
    }
    // No match yet — return the app name as-is (fallback at dequeue time)
    return target;
  }

  getPendingCount(): number {
    let total = 0;
    for (const queue of this.scenariosByTarget.values()) {
      total += queue.length;
    }
    return total;
  }

  getPendingCountForProject(projectPath: string | null): number {
    if (!projectPath) return 0;
    let count = 0;
    for (const [target, scenarios] of this.scenariosByTarget) {
      if (target.startsWith(projectPath)) count += scenarios.length;
    }
    return count;
  }

  getCommandsCatalog(): Record<string, unknown> {
    return {
      description:
        "Console Trigger DSL — commands for browser UI automation via POST /api/test/trigger/scenarios",
      usage:
        "POST a JSON object with 'name' (string), optional 'description' (string), " +
        "optional 'target' (string), and 'steps' (array of command objects). Each step " +
        "must have a 'command' field plus the required parameters listed below. Steps " +
        "execute sequentially; execution stops on first failure. The 'target' field " +
        "identifies which browser should run the scenario — it defaults to the active project " +
        "when omitted. It can be an absolute filesystem path " +
        "(e.g. \"/home/user/devglide/apps/kanban\") or a simple app name " +
        "(e.g. \"kanban\", \"dashboard\") which is automatically resolved to the " +
        "full path once the browser has polled at least once. " +
        "External apps enable automation via a bare <script src=\"http://localhost:7000/devtools.js\"></script> include. " +
        "Use 'logPath' to check the current URL, 'logBody' and 'logHead' to inspect " +
        "the rendered HTML (captured by console-sniffer from devglide-log). " +
        "IMPORTANT: Prefer interacting with HTML elements (clicking links, buttons, nav items) " +
        "over using 'navigate'. The 'navigate' command should only be used when there is no " +
        "interactive element available — e.g. for the initial deep-link to a URL before the " +
        "test starts. Normal in-app navigation must be done via click/type/select on real UI " +
        "elements, because this reflects actual user behaviour. Overusing 'navigate' bypasses " +
        "the UI interaction layer and can cause false positives where the scenario passes but " +
        "the UI flow was never actually tested. " +
        "When 'navigate' is used, scenario state is automatically persisted to localStorage " +
        "and resumed after page reload. " +
        "It is recommended to use persistent=true on the console-sniffer script tag when using 'navigate'.",
      commands: [
        cmd("click", "Click a DOM element", {
          selector: param("string", true, "CSS selector for the target element"),
        }),
        cmd("dblclick", "Double-click a DOM element", {
          selector: param("string", true, "CSS selector for the target element"),
        }),
        cmd(
          "type",
          "Type text into an input or textarea. Clears the field first by default.",
          {
            selector: param("string", true, "CSS selector for the input element"),
            text: param("string", true, "Text to type"),
            clear: param("boolean", false, "Clear the field before typing (default: true)"),
          }
        ),
        cmd("select", "Select an option in a <select> dropdown by its value attribute", {
          selector: param("string", true, "CSS selector for the <select> element"),
          value: param("string", true, "The option value to select"),
        }),
        cmd("wait", "Pause execution for a fixed number of milliseconds", {
          ms: param("integer", true, "Number of milliseconds to wait"),
        }),
        cmd(
          "waitFor",
          "Wait until an element appears in the DOM (polls until found or timeout)",
          {
            selector: param("string", true, "CSS selector to wait for"),
            timeout: param("integer", false, "Max wait time in ms (default: 5000)"),
          }
        ),
        cmd(
          "waitForHidden",
          "Wait until an element disappears from the DOM or becomes hidden",
          {
            selector: param("string", true, "CSS selector to wait for disappearance"),
            timeout: param("integer", false, "Max wait time in ms (default: 5000)"),
          }
        ),
        cmd(
          "find",
          "Alias for waitFor — locate a DOM element, retrying until found or timeout.",
          {
            selector: param("string", true, "CSS selector for the element"),
            timeout: param("integer", false, "Max wait time in ms (default: 5000)"),
          }
        ),
        cmd(
          "assertExists",
          "Assert that an element currently exists in the DOM. Fails immediately if not found.",
          {
            selector: param("string", true, "CSS selector to check"),
          }
        ),
        cmd(
          "assertNotExists",
          "Assert that an element does NOT exist in the DOM. Fails if the element is found.",
          {
            selector: param("string", true, "CSS selector to check"),
          }
        ),
        cmd(
          "assertText",
          "Assert that an element's text content matches or contains the expected text",
          {
            selector: param("string", true, "CSS selector for the element"),
            text: param("string", true, "Expected text"),
            contains: param(
              "boolean",
              false,
              "If true (default), checks substring match. If false, checks exact match."
            ),
          }
        ),
        cmd(
          "logPath",
          "Log the current page URL to the console. Captured by console-sniffer so the backend can check the URL from the log file.",
          {}
        ),
        cmd(
          "logBody",
          "Log the current page body HTML to the console. Captured by console-sniffer so the backend can inspect the rendered DOM body.",
          {}
        ),
        cmd(
          "logHead",
          "Log the current page head HTML to the console. Captured by console-sniffer so the backend can inspect the page head element.",
          {}
        ),
        cmd(
          "navigate",
          "Navigate the browser to a given path. Use sparingly — only when no clickable " +
            "element can achieve the navigation (e.g. initial page load or deep-linking " +
            "before a test begins). For normal in-app navigation, prefer clicking links " +
            "or buttons instead, as this better reflects real user behaviour and avoids " +
            "false positives.",
          {
            path: param("string", true, "The URL path to navigate to (e.g. /dashboard, /users/123)"),
          }
        ),
      ],
    };
  }
}

function param(type: string, required: boolean, description: string) {
  return { type, required, description };
}

function cmd(
  command: string,
  description: string,
  parameters: Record<string, { type: string; required: boolean; description: string }>
) {
  return { command, description, parameters };
}
