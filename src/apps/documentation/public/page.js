// ── Documentation App — Product Documentation ───────────────────────
// Static product docs with multiple views.
// ES module: mount(container, ctx), unmount(container), onProjectChange(project).

let _container = null;
let _activeView = 'home';
let _hasProject = false;

// ── Onboarding banner (shown when no project is active) ─────────────

const ONBOARDING_HTML = `
  <div class="dc-onboarding">
    <div class="dc-onboarding-header">
      <div class="dc-onboarding-icon">\u2192</div>
      <div>
        <h2 class="dc-onboarding-title">Welcome to devglide</h2>
        <p class="dc-onboarding-subtitle">Create a project to get started</p>
      </div>
    </div>
    <p class="dc-onboarding-desc">
      Project-scoped apps (Kanban, Shell, Test, Workflow, and more) are disabled
      until you select a project. Click the <strong>project selector</strong> in
      the sidebar to create or activate one.
    </p>
    <div class="dc-onboarding-steps">
      <div class="dc-onboarding-step">
        <span class="dc-onboarding-step-num">1</span>
        <div>
          <strong>Open the project selector</strong>
          <p>Click the dropdown at the top of the sidebar (shows "No project")</p>
        </div>
      </div>
      <div class="dc-onboarding-step">
        <span class="dc-onboarding-step-num">2</span>
        <div>
          <strong>Add a project</strong>
          <p>Click "+ Add Project", give it a name, and browse to its folder</p>
        </div>
      </div>
      <div class="dc-onboarding-step">
        <span class="dc-onboarding-step-num">3</span>
        <div>
          <strong>Start building</strong>
          <p>All 8 project apps unlock &mdash; create tasks, run tests, automate workflows</p>
        </div>
      </div>
    </div>
  </div>
`;

function updateOnboardingBanner() {
  if (!_container) return;
  const existing = _container.querySelector('.dc-onboarding');
  const content = _container.querySelector('#dc-view-content');
  if (!content) return;

  if (_hasProject && existing) {
    existing.remove();
  } else if (!_hasProject && !existing) {
    content.insertAdjacentHTML('afterbegin', ONBOARDING_HTML);
  }
}

// ── View: Home ──────────────────────────────────────────────────────

const HOME_HTML = `
  <!-- Hero -->
  <section class="dc-hero">
    <div class="dc-hero-badge">Open Source</div>
    <h1 class="dc-hero-title">devglide</h1>
    <p class="dc-hero-tagline">AI-native development environment for Claude Code</p>
    <p class="dc-hero-desc">
      A modular toolkit that gives your AI coding assistant project management,
      browser testing, workflow automation, and more &mdash; all through
      <strong>MCP tools</strong> and a unified dashboard.
    </p>
    <div class="dc-hero-stats">
      <div class="dc-stat"><span class="dc-stat-value">10</span><span class="dc-stat-label">App Modules</span></div>
      <div class="dc-stat"><span class="dc-stat-value">51</span><span class="dc-stat-label">MCP Tools</span></div>
      <div class="dc-stat"><span class="dc-stat-value">8</span><span class="dc-stat-label">MCP Servers</span></div>
    </div>
  </section>

  <!-- What is devglide -->
  <section class="dc-section">
    <h2 class="dc-section-title">What is devglide?</h2>
    <p class="dc-section-desc">
      Claude Code is powerful on its own, but it operates in a text-only terminal.
      devglide gives it <strong>eyes, hands, and memory</strong> &mdash; a browser dashboard
      with visual tools that Claude controls through MCP.
    </p>
    <div class="dc-pillars">
      <div class="dc-pillar">
        <div class="dc-pillar-icon">\u25A6</div>
        <h3>Plan</h3>
        <p>Kanban boards with features, tasks, bugs, work logs, and review feedback. Claude picks up tasks and reports progress.</p>
      </div>
      <div class="dc-pillar">
        <div class="dc-pillar-icon">\u2713</div>
        <h3>Test</h3>
        <p>Describe what to test in plain English — Claude generates and runs browser automation scenarios automatically. Build regression suites before every commit.</p>
      </div>
      <div class="dc-pillar">
        <div class="dc-pillar-icon">\u2942</div>
        <h3>Automate</h3>
        <p>Visual DAG workflows with decisions, loops, and integrations. Define processes once, trigger them by prompt or event.</p>
      </div>
    </div>
  </section>

  <!-- Module Grid -->
  <section class="dc-section">
    <h2 class="dc-section-title">10 Integrated Modules</h2>
    <p class="dc-section-desc">Every module exposes MCP tools that Claude Code calls directly. The dashboard shows the same data visually.</p>
    <div class="dc-modules">
      <div class="dc-module"><div class="dc-module-icon">\u25A6</div><h3>Kanban</h3><p>Features, tasks, bugs, columns, work logs, review feedback. 14 MCP tools.</p></div>
      <div class="dc-module"><div class="dc-module-icon">\u2713</div><h3>Test</h3><p>AI-driven browser test automation with saved scenarios and regression suites. 7 MCP tools.</p></div>
      <div class="dc-module"><div class="dc-module-icon">\u2942</div><h3>Workflow</h3><p>Visual DAG builder with 12 node types, prompt matching, compiled instructions. 6 tools.</p></div>
      <div class="dc-module"><div class="dc-module-icon">\u276F</div><h3>Shell</h3><p>Terminal multiplexer with named panes, scrollback capture, command execution. 5 tools.</p></div>
      <div class="dc-module"><div class="dc-module-icon">\u2261</div><h3>Log</h3><p>Real-time browser console capture with JSONL session storage. 4 MCP tools.</p></div>
      <div class="dc-module"><div class="dc-module-icon">\u2039\u203A</div><h3>Coder</h3><p>In-browser code editor with file tree, tabs, and live preview.</p></div>
      <div class="dc-module"><div class="dc-module-icon">\u270E</div><h3>Prompts</h3><p>Reusable prompt templates with variables, categories, and ratings. 7 MCP tools.</p></div>
      <div class="dc-module"><div class="dc-module-icon">\u2338</div><h3>Vocabulary</h3><p>Domain-specific term dictionary with aliases and context injection. 6 MCP tools.</p></div>
      <div class="dc-module"><div class="dc-module-icon">\u25C9</div><h3>Voice</h3><p>Speech-to-text transcription for hands-free interaction. 2 MCP tools.</p></div>
      <div class="dc-module"><div class="dc-module-icon">\u2328</div><h3>Keymap</h3><p>Configurable keyboard shortcuts for dashboard navigation and actions.</p></div>
    </div>
  </section>

  <!-- How It Works -->
  <section class="dc-section dc-section-alt">
    <h2 class="dc-section-title">How It Works</h2>
    <div class="dc-steps">
      <div class="dc-step">
        <div class="dc-step-num">1</div>
        <h3>Install &amp; Start</h3>
        <p>Install devglide globally or clone the repo. Run <code>devglide start</code> from your project directory.</p>
      </div>
      <div class="dc-step-arrow">\u2192</div>
      <div class="dc-step">
        <div class="dc-step-num">2</div>
        <h3>Connect Claude Code</h3>
        <p>devglide writes a <code>.mcp.json</code> file that Claude Code auto-discovers. All 51 MCP tools become available.</p>
      </div>
      <div class="dc-step-arrow">\u2192</div>
      <div class="dc-step">
        <div class="dc-step-num">3</div>
        <h3>Build Together</h3>
        <p>Claude manages tasks, runs tests, executes commands, and follows workflows &mdash; you see everything live.</p>
      </div>
    </div>
  </section>

  <!-- Footer -->
  <footer class="dc-footer">
    <p>Built with Claude Code &middot; Powered by MCP &middot; Open Source</p>
  </footer>
`;

// ── View: Getting Started ───────────────────────────────────────────

const GETTING_STARTED_HTML = `
  <section class="dc-content">
    <h1 class="dc-content-title">Getting Started</h1>
    <p class="dc-content-lead">Get devglide running and connected to Claude Code in under 5 minutes.</p>

    <div class="dc-card">
      <h2>Prerequisites</h2>
      <ul class="dc-list">
        <li><strong>Node.js</strong> 18 or later</li>
        <li><strong>Claude Code</strong> CLI installed and configured</li>
        <li>A modern browser (Chrome, Firefox, Edge)</li>
      </ul>
    </div>

    <div class="dc-card">
      <h2>Installation</h2>
      <p>Install globally from npm:</p>
      <div class="dc-codeblock"><code>pnpm install -g devglide</code></div>
      <p>Or clone the repository:</p>
      <div class="dc-codeblock"><code>git clone https://github.com/DannyNsITServices/devglide.git<br>cd devglide<br>pnpm install<br>pnpm build</code></div>
      <p><code>pnpm build</code> is required to compile design tokens and shared packages.</p>
    </div>

    <div class="dc-card">
      <h2>Starting the Server</h2>
      <p>Launch devglide from your project directory:</p>
      <div class="dc-codeblock"><code>devglide start</code></div>
      <p>This starts the HTTP server on port 3000 and opens the dashboard in your browser.</p>
    </div>

    <div class="dc-card">
      <h2>Connecting to Claude Code</h2>
      <p>devglide writes a <code>.mcp.json</code> in your project root. Claude Code auto-discovers it and all 51 MCP tools become available immediately. No configuration needed.</p>
      <p>Once connected, Claude Code can:</p>
      <ul class="dc-list">
        <li>Manage tasks and features on the <strong>Kanban</strong> board</li>
        <li>Generate and run <strong>browser tests</strong> from natural language descriptions</li>
        <li>Execute <strong>shell commands</strong> in managed terminal panes</li>
        <li>Build and run <strong>workflows</strong> (multi-step DAG automations)</li>
        <li>Capture and read <strong>browser console logs</strong></li>
        <li>Use <strong>voice transcription</strong> for hands-free interaction</li>
        <li>Look up <strong>domain vocabulary</strong> for project-specific terminology</li>
        <li>Store and render <strong>reusable prompt templates</strong></li>
      </ul>
    </div>

    <div class="dc-card">
      <h2>Creating Your First Project</h2>
      <div class="dc-numbered-steps">
        <div class="dc-ns"><span class="dc-ns-num">1</span><p>Open the dashboard at <code>http://localhost:3000</code></p></div>
        <div class="dc-ns"><span class="dc-ns-num">2</span><p>Click the <strong>project selector</strong> in the sidebar header</p></div>
        <div class="dc-ns"><span class="dc-ns-num">3</span><p>Select <strong>New Project</strong> and give it a name</p></div>
        <div class="dc-ns"><span class="dc-ns-num">4</span><p>The sidebar now shows project-scoped apps (Kanban, Log, Test, etc.)</p></div>
      </div>
    </div>

    <div class="dc-card">
      <h2>Your First Kanban Board</h2>
      <div class="dc-numbered-steps">
        <div class="dc-ns"><span class="dc-ns-num">1</span><p>Click <strong>Kanban</strong> in the sidebar</p></div>
        <div class="dc-ns"><span class="dc-ns-num">2</span><p>Click <strong>+ New Feature</strong> to create a feature board</p></div>
        <div class="dc-ns"><span class="dc-ns-num">3</span><p>Each feature gets columns: Backlog, Todo, In Progress, In Review, Testing, Done</p></div>
        <div class="dc-ns"><span class="dc-ns-num">4</span><p>Add tasks with priorities, labels, and due dates</p></div>
      </div>
    </div>

    <div class="dc-card">
      <h2>Your First Test Scenario</h2>
      <div class="dc-numbered-steps">
        <div class="dc-ns"><span class="dc-ns-num">1</span><p>Click <strong>Test</strong> in the sidebar</p></div>
        <div class="dc-ns"><span class="dc-ns-num">2</span><p>Ask Claude to write a test: <em>"Write a test that creates a task and verifies it appears"</em></p></div>
        <div class="dc-ns"><span class="dc-ns-num">3</span><p>Claude generates a scenario with commands like <code>click</code>, <code>waitFor</code>, <code>assertText</code> and runs it</p></div>
        <div class="dc-ns"><span class="dc-ns-num">4</span><p>Save scenarios to build a regression suite that runs before every commit</p></div>
      </div>
    </div>
  </section>
`;

// ── View: Modules ───────────────────────────────────────────────────

const MODULES_HTML = `
  <section class="dc-content">
    <h1 class="dc-content-title">Modules</h1>
    <p class="dc-content-lead">Deep dive into each of devglide's 10 integrated modules.</p>

    <div class="dc-card" id="mod-kanban">
      <div class="dc-card-header"><span class="dc-card-icon">\u25A6</span><h2>Kanban</h2><span class="dc-tool-count">14 tools</span></div>
      <p>Full project management with features, columns, tasks, bugs, work logs, and review feedback.</p>
      <h3>Key Concepts</h3>
      <ul class="dc-list">
        <li><strong>Features</strong> &mdash; Top-level containers representing product initiatives. Each gets its own board.</li>
        <li><strong>Items</strong> &mdash; Tasks or bugs with priority (LOW/MEDIUM/HIGH/URGENT), labels, and due dates.</li>
        <li><strong>Columns</strong> &mdash; Workflow stages: Backlog \u2192 Todo \u2192 In Progress \u2192 In Review \u2192 Testing \u2192 Done.</li>
        <li><strong>Work Log</strong> &mdash; Append-only versioned log of what was done on a task.</li>
        <li><strong>Review Feedback</strong> &mdash; Append-only versioned notes from reviews.</li>
      </ul>
      <h3>MCP Tools</h3>
      <p class="dc-tools-list">kanban_list_features, kanban_create_feature, kanban_get_feature, kanban_update_feature, kanban_delete_feature, kanban_list_items, kanban_create_item, kanban_get_item, kanban_update_item, kanban_move_item, kanban_delete_item, kanban_append_work_log, kanban_get_work_log, kanban_append_review</p>
    </div>

    <div class="dc-card" id="mod-test">
      <div class="dc-card-header"><span class="dc-card-icon">\u2713</span><h2>Test</h2><span class="dc-tool-count">7 tools</span></div>
      <p>AI-driven browser test automation. Describe what to test in natural language and Claude generates scenarios automatically.</p>
      <h3>How to Use</h3>
      <ul class="dc-list">
        <li><strong>Ask Claude</strong> &mdash; "Write a test that creates a kanban task and verifies it appears in the Todo column"</li>
        <li><strong>Save &amp; reuse</strong> &mdash; Build a library of saved scenarios for regression testing before commits.</li>
        <li><strong>Run manually</strong> &mdash; Use <code>test_run_saved</code> or the Run button in the dashboard.</li>
      </ul>
      <h3>Key Concepts</h3>
      <ul class="dc-list">
        <li><strong>Scenarios</strong> &mdash; Named sequences of browser automation steps targeting a specific app.</li>
        <li><strong>Commands</strong> &mdash; click, type, waitFor, waitForHidden, assertExists, assertText, navigate, wait, select, dblclick.</li>
        <li><strong>Targets</strong> &mdash; Which browser tab runs the scenario (matched by app name or path).</li>
        <li><strong>Results</strong> &mdash; Pass/fail status with failed step index, error message, and duration.</li>
      </ul>
      <h3>MCP Tools</h3>
      <p class="dc-tools-list">test_commands, test_run_scenario, test_save_scenario, test_list_saved, test_run_saved, test_delete_saved, test_get_result</p>
    </div>

    <div class="dc-card" id="mod-workflow">
      <div class="dc-card-header"><span class="dc-card-icon">\u2942</span><h2>Workflow</h2><span class="dc-tool-count">6 tools</span></div>
      <p>Visual DAG workflow builder for multi-step automations with decisions, loops, and integrations.</p>
      <h3>Node Types</h3>
      <div class="dc-tag-grid">
        <span class="dc-tag">trigger</span><span class="dc-tag">action:shell</span><span class="dc-tag">action:kanban</span>
        <span class="dc-tag">action:git</span><span class="dc-tag">action:test</span><span class="dc-tag">action:log</span>
        <span class="dc-tag">action:file</span><span class="dc-tag">action:llm</span><span class="dc-tag">action:http</span>
        <span class="dc-tag">decision</span><span class="dc-tag">loop</span><span class="dc-tag">sub-workflow</span>
      </div>
      <h3>How Matching Works</h3>
      <p>When Claude Code receives a prompt, it calls <code>workflow_match</code> to check if any enabled workflow applies. Matching workflows return compiled step-by-step instructions that Claude follows.</p>
      <h3>MCP Tools</h3>
      <p class="dc-tools-list">workflow_list, workflow_get, workflow_create, workflow_get_instructions, workflow_match, workflow_toggle</p>
    </div>

    <div class="dc-card" id="mod-shell">
      <div class="dc-card-header"><span class="dc-card-icon">\u276F</span><h2>Shell</h2><span class="dc-tool-count">5 tools</span></div>
      <p>Terminal multiplexer with named panes, scrollback capture, and MCP command execution.</p>
      <h3>Key Concepts</h3>
      <ul class="dc-list">
        <li><strong>Panes</strong> &mdash; Independent terminal sessions, each running a shell process.</li>
        <li><strong>Scrollback</strong> &mdash; Captured output buffer that MCP tools can read.</li>
        <li><strong>CWD</strong> &mdash; Each pane tracks its current working directory.</li>
      </ul>
      <p>Claude creates panes to start dev servers, run tests, and execute git operations concurrently.</p>
      <h3>MCP Tools</h3>
      <p class="dc-tools-list">shell_list_panes, shell_create_pane, shell_run_command, shell_get_scrollback, shell_close_pane</p>
    </div>

    <div class="dc-card" id="mod-log">
      <div class="dc-card-header"><span class="dc-card-icon">\u2261</span><h2>Log</h2><span class="dc-tool-count">4 tools</span></div>
      <p>Real-time browser console capture &mdash; monitor logs, errors, and network activity.</p>
      <h3>Key Concepts</h3>
      <ul class="dc-list">
        <li><strong>Sessions</strong> &mdash; Each browser tab gets its own log session identified by target path.</li>
        <li><strong>JSONL files</strong> &mdash; Logs stored as newline-delimited JSON for efficient streaming.</li>
        <li><strong>Console sniffer</strong> &mdash; The <code>__devtools.js</code> script captures browser output.</li>
      </ul>
      <h3>MCP Tools</h3>
      <p class="dc-tools-list">log_read, log_write, log_clear, log_clear_all</p>
    </div>

    <div class="dc-card" id="mod-prompts">
      <div class="dc-card-header"><span class="dc-card-icon">\u270E</span><h2>Prompts</h2><span class="dc-tool-count">7 tools</span></div>
      <p>Reusable prompt template library with variables, categories, and quality ratings.</p>
      <h3>Key Concepts</h3>
      <ul class="dc-list">
        <li><strong>Templates</strong> &mdash; Prompt text with <code>{{variableName}}</code> placeholders.</li>
        <li><strong>Variables</strong> &mdash; Auto-detected from <code>{{ }}</code> syntax in content.</li>
        <li><strong>Categories</strong> &mdash; Group prompts by purpose (code-review, refactor, testing).</li>
        <li><strong>Ratings</strong> &mdash; 1&ndash;5 star quality ratings for tracking effectiveness.</li>
      </ul>
      <h3>MCP Tools</h3>
      <p class="dc-tools-list">prompts_list, prompts_get, prompts_render, prompts_add, prompts_update, prompts_remove, prompts_context</p>
    </div>

    <div class="dc-card" id="mod-vocabulary">
      <div class="dc-card-header"><span class="dc-card-icon">\u2338</span><h2>Vocabulary</h2><span class="dc-tool-count">6 tools</span></div>
      <p>Domain-specific term dictionary so your AI assistant speaks your language.</p>
      <h3>Key Concepts</h3>
      <ul class="dc-list">
        <li><strong>Terms</strong> &mdash; Named entries with definitions, aliases, and optional categories.</li>
        <li><strong>Aliases</strong> &mdash; Alternative names that resolve to the same term.</li>
        <li><strong>Context injection</strong> &mdash; All terms compiled to markdown for LLM context.</li>
      </ul>
      <p>Define entries for project acronyms, internal tool names, and domain jargon. <code>vocabulary_lookup</code> is called automatically when Claude encounters unfamiliar terms.</p>
      <h3>MCP Tools</h3>
      <p class="dc-tools-list">vocabulary_list, vocabulary_lookup, vocabulary_add, vocabulary_update, vocabulary_remove, vocabulary_context</p>
    </div>

    <div class="dc-card" id="mod-coder">
      <div class="dc-card-header"><span class="dc-card-icon">\u2039\u203A</span><h2>Coder</h2></div>
      <p>In-browser code editor with a file tree, tabbed editing, and live preview. Useful for quick manual edits, reviewing generated code, and previewing HTML output.</p>
    </div>

    <div class="dc-card" id="mod-voice">
      <div class="dc-card-header"><span class="dc-card-icon">\u25C9</span><h2>Voice</h2><span class="dc-tool-count">2 tools</span></div>
      <p>Speech-to-text transcription for hands-free interaction and dictation. Click the microphone widget in the sidebar to record. Audio is sent to the configured STT provider for transcription.</p>
      <h3>MCP Tools</h3>
      <p class="dc-tools-list">voice_transcribe, voice_status</p>
    </div>

    <div class="dc-card" id="mod-keymap">
      <div class="dc-card-header"><span class="dc-card-icon">\u2328</span><h2>Keymap</h2></div>
      <p>Configurable keyboard shortcuts for dashboard navigation and actions. Customize bindings for switching between apps, triggering actions, and navigating the UI efficiently.</p>
    </div>
  </section>
`;

// ── View: API Reference ─────────────────────────────────────────────

const API_HTML = `
  <section class="dc-content">
    <h1 class="dc-content-title">API Reference</h1>
    <p class="dc-content-lead">Complete catalog of all 51 MCP tools across 8 servers.</p>
    <p class="dc-content-note">Each server runs as a stdio process auto-discovered by Claude Code via <code>.mcp.json</code>. Tools are also available as REST endpoints at <code>/api/{module}/</code>.</p>

    <div class="dc-card">
      <div class="dc-card-header"><h2>devglide-kanban</h2><span class="dc-tool-count">14 tools</span></div>
      <table class="dc-api-table">
        <tbody>
          <tr><td><code>kanban_list_features</code></td><td>List all features in the current project</td></tr>
          <tr><td><code>kanban_create_feature</code></td><td>Create a new feature with default kanban columns</td></tr>
          <tr><td><code>kanban_get_feature</code></td><td>Get full feature details including columns, tasks, and bugs</td></tr>
          <tr><td><code>kanban_update_feature</code></td><td>Update a feature's name, description, or color</td></tr>
          <tr><td><code>kanban_delete_feature</code></td><td>Delete a feature and all its tasks and bugs</td></tr>
          <tr><td><code>kanban_list_items</code></td><td>List tasks/bugs with filtering by feature, column, priority, type</td></tr>
          <tr><td><code>kanban_create_item</code></td><td>Create a new task or bug (defaults to Backlog column)</td></tr>
          <tr><td><code>kanban_get_item</code></td><td>Get full details of a single task or bug</td></tr>
          <tr><td><code>kanban_update_item</code></td><td>Update an existing task or bug</td></tr>
          <tr><td><code>kanban_move_item</code></td><td>Move a task/bug to a different column</td></tr>
          <tr><td><code>kanban_delete_item</code></td><td>Delete a task or bug</td></tr>
          <tr><td><code>kanban_append_work_log</code></td><td>Append a versioned work log entry to a task</td></tr>
          <tr><td><code>kanban_get_work_log</code></td><td>Get the full work log history for a task</td></tr>
          <tr><td><code>kanban_append_review</code></td><td>Append versioned review feedback to a task</td></tr>
        </tbody>
      </table>
    </div>

    <div class="dc-card">
      <div class="dc-card-header"><h2>devglide-test</h2><span class="dc-tool-count">7 tools</span></div>
      <table class="dc-api-table">
        <tbody>
          <tr><td><code>test_commands</code></td><td>List available browser automation commands</td></tr>
          <tr><td><code>test_run_scenario</code></td><td>Submit a UI automation scenario for browser execution</td></tr>
          <tr><td><code>test_save_scenario</code></td><td>Save a scenario to the library for reuse</td></tr>
          <tr><td><code>test_list_saved</code></td><td>List all saved scenarios</td></tr>
          <tr><td><code>test_run_saved</code></td><td>Run a saved scenario by ID</td></tr>
          <tr><td><code>test_delete_saved</code></td><td>Delete a saved scenario</td></tr>
          <tr><td><code>test_get_result</code></td><td>Get execution result (passed/failed, error, duration)</td></tr>
        </tbody>
      </table>
    </div>

    <div class="dc-card">
      <div class="dc-card-header"><h2>devglide-workflow</h2><span class="dc-tool-count">6 tools</span></div>
      <table class="dc-api-table">
        <tbody>
          <tr><td><code>workflow_list</code></td><td>List workflows (project-scoped + global)</td></tr>
          <tr><td><code>workflow_get</code></td><td>Get full workflow graph with nodes, edges, variables</td></tr>
          <tr><td><code>workflow_create</code></td><td>Create a new workflow from nodes and edges JSON</td></tr>
          <tr><td><code>workflow_get_instructions</code></td><td>Get compiled instructions as markdown</td></tr>
          <tr><td><code>workflow_match</code></td><td>Match user prompt against enabled workflows</td></tr>
          <tr><td><code>workflow_toggle</code></td><td>Enable or disable a workflow</td></tr>
        </tbody>
      </table>
    </div>

    <div class="dc-card">
      <div class="dc-card-header"><h2>devglide-shell</h2><span class="dc-tool-count">5 tools</span></div>
      <table class="dc-api-table">
        <tbody>
          <tr><td><code>shell_list_panes</code></td><td>List active terminal panes with CWD</td></tr>
          <tr><td><code>shell_create_pane</code></td><td>Create a new terminal pane</td></tr>
          <tr><td><code>shell_run_command</code></td><td>Send command and capture output after timeout</td></tr>
          <tr><td><code>shell_get_scrollback</code></td><td>Get recent scrollback buffer</td></tr>
          <tr><td><code>shell_close_pane</code></td><td>Close a terminal pane</td></tr>
        </tbody>
      </table>
    </div>

    <div class="dc-card">
      <div class="dc-card-header"><h2>devglide-prompts</h2><span class="dc-tool-count">7 tools</span></div>
      <table class="dc-api-table">
        <tbody>
          <tr><td><code>prompts_list</code></td><td>List prompts with optional category/tag/search filter</td></tr>
          <tr><td><code>prompts_get</code></td><td>Get full prompt including content and variables</td></tr>
          <tr><td><code>prompts_render</code></td><td>Render template by substituting variables</td></tr>
          <tr><td><code>prompts_add</code></td><td>Save a new prompt template</td></tr>
          <tr><td><code>prompts_update</code></td><td>Modify an existing prompt</td></tr>
          <tr><td><code>prompts_remove</code></td><td>Delete a prompt</td></tr>
          <tr><td><code>prompts_context</code></td><td>Compile all prompts as markdown context</td></tr>
        </tbody>
      </table>
    </div>

    <div class="dc-card">
      <div class="dc-card-header"><h2>devglide-vocabulary</h2><span class="dc-tool-count">6 tools</span></div>
      <table class="dc-api-table">
        <tbody>
          <tr><td><code>vocabulary_list</code></td><td>List entries, filter by category/tag</td></tr>
          <tr><td><code>vocabulary_lookup</code></td><td>Look up a term by name or alias</td></tr>
          <tr><td><code>vocabulary_add</code></td><td>Define a new domain term</td></tr>
          <tr><td><code>vocabulary_update</code></td><td>Modify an entry</td></tr>
          <tr><td><code>vocabulary_remove</code></td><td>Delete an entry</td></tr>
          <tr><td><code>vocabulary_context</code></td><td>Compile all terms as markdown context</td></tr>
        </tbody>
      </table>
    </div>

    <div class="dc-card">
      <div class="dc-card-header"><h2>devglide-log</h2><span class="dc-tool-count">4 tools</span></div>
      <table class="dc-api-table">
        <tbody>
          <tr><td><code>log_read</code></td><td>Read recent log entries from a JSONL file</td></tr>
          <tr><td><code>log_write</code></td><td>Append a log entry</td></tr>
          <tr><td><code>log_clear</code></td><td>Truncate a log file</td></tr>
          <tr><td><code>log_clear_all</code></td><td>Truncate all tracked session logs</td></tr>
        </tbody>
      </table>
    </div>

    <div class="dc-card">
      <div class="dc-card-header"><h2>devglide-voice</h2><span class="dc-tool-count">2 tools</span></div>
      <table class="dc-api-table">
        <tbody>
          <tr><td><code>voice_transcribe</code></td><td>Transcribe base64-encoded audio data</td></tr>
          <tr><td><code>voice_status</code></td><td>Check service status and transcription stats</td></tr>
        </tbody>
      </table>
    </div>
  </section>
`;

// ── View: Changelog ─────────────────────────────────────────────────

const CHANGELOG_HTML = `
  <section class="dc-content">
    <h1 class="dc-content-title">Changelog</h1>
    <p class="dc-content-lead">Release history and notable changes.</p>

    <div class="dc-card dc-changelog-entry">
      <div class="dc-card-header">
        <h2>v0.1.0</h2>
        <span class="dc-release-date">March 2026</span>
      </div>
      <div class="dc-release-badge">Initial Release</div>

      <h3>New Features</h3>
      <ul class="dc-list">
        <li><strong>Kanban</strong> &mdash; Full project management with features, columns, tasks, bugs, work logs, and review feedback. 14 MCP tools.</li>
        <li><strong>Test</strong> &mdash; AI-driven browser test automation with saved scenarios, regression suites, and execution results. 7 MCP tools.</li>
        <li><strong>Workflow</strong> &mdash; Visual DAG workflow builder with 12 node types, prompt matching, and compiled instructions. 6 MCP tools.</li>
        <li><strong>Shell</strong> &mdash; Terminal multiplexer with named panes, scrollback capture, and command execution. 5 MCP tools.</li>
        <li><strong>Log</strong> &mdash; Real-time browser console capture with JSONL session storage. 4 MCP tools.</li>
        <li><strong>Voice</strong> &mdash; Speech-to-text transcription with pluggable providers. 2 MCP tools.</li>
        <li><strong>Vocabulary</strong> &mdash; Domain-specific term dictionary with aliases and context injection. 6 MCP tools.</li>
        <li><strong>Prompts</strong> &mdash; Reusable prompt template library with variables, categories, and ratings. 7 MCP tools.</li>
        <li><strong>Coder</strong> &mdash; In-browser code editor with file tree and tabs.</li>
        <li><strong>Keymap</strong> &mdash; Configurable keyboard shortcuts.</li>
      </ul>

      <h3>Architecture</h3>
      <ul class="dc-list">
        <li>Unified SPA dashboard with sidebar navigation and project scoping</li>
        <li>8 MCP stdio servers auto-discovered via <code>.mcp.json</code></li>
        <li>JsonFileStore for git-friendly per-entity JSON storage</li>
        <li>SQLite databases for kanban data</li>
        <li>Socket.io for real-time dashboard updates</li>
        <li>Design token system for consistent theming</li>
      </ul>

      <h3>Infrastructure</h3>
      <ul class="dc-list">
        <li>Dev Task workflow enforcing test-before-commit discipline</li>
        <li>Browser automation regression suite with starter scenarios</li>
        <li>Centralized storage in <code>~/.devglide/</code> home directory</li>
      </ul>
    </div>
  </section>
`;

// ── Views map ───────────────────────────────────────────────────────

const VIEWS = {
  home:     { label: 'Home',            html: HOME_HTML },
  guide:    { label: 'Getting Started', html: GETTING_STARTED_HTML },
  modules:  { label: 'Modules',         html: MODULES_HTML },
  api:      { label: 'API Reference',   html: API_HTML },
  changelog:{ label: 'Changelog',       html: CHANGELOG_HTML },
};

// ── Navigation & rendering ──────────────────────────────────────────

function switchView(id) {
  _activeView = id;
  const content = _container?.querySelector('#dc-view-content');
  if (content) {
    content.innerHTML = VIEWS[id]?.html ?? '';
    content.scrollTop = 0;
  }
  // Update active nav link
  _container?.querySelectorAll('.dc-nav-link').forEach(link => {
    link.classList.toggle('active', link.dataset.view === id);
  });
  updateOnboardingBanner();
}

// ── Exports ──────────────────────────────────────────────────────────

export function mount(container, ctx) {
  _container = container;
  _activeView = 'home';
  _hasProject = !!ctx?.project;
  container.classList.add('page-documentation');

  // Build shell: header + nav + scrollable content area
  container.innerHTML = `
    <header>
      <div class="brand">Documentation</div>
    </header>
    <nav class="dc-nav">
      ${Object.entries(VIEWS).map(([id, v]) =>
        `<button class="dc-nav-link${id === 'home' ? ' active' : ''}" data-view="${id}">${v.label}</button>`
      ).join('')}
    </nav>
    <div class="dc-view-content" id="dc-view-content">${HOME_HTML}</div>
  `;

  // Bind nav clicks
  container.querySelectorAll('.dc-nav-link').forEach(link => {
    link.addEventListener('click', () => switchView(link.dataset.view));
  });

  updateOnboardingBanner();
}

export function unmount(container) {
  container.classList.remove('page-documentation');
  container.innerHTML = '';
  _container = null;
}

export function onProjectChange(project) {
  _hasProject = !!project;
  updateOnboardingBanner();
}
