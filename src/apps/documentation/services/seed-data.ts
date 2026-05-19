import type { DocEntry } from '../types.js';

/**
 * Embedded seed documentation entries.
 * These are written to ~/.devglide/documentation/ on first use if not already present.
 * Embedded in code so the bundled MCP server (dist/mcp/documentation.mjs) does not
 * need to locate seed files on disk.
 */
export const SEED_ENTRIES: DocEntry[] = [
  {
    "id": "ex-flaky-selector",
    "type": "example",
    "toolName": "devglide-test",
    "scenario": "Flaky selector in React controlled form",
    "startingAssumptions": [
      "A test scenario intermittently fails on a click or type step targeting a form element.",
      "The selector works when tested manually in the browser DevTools.",
      "The app uses React with controlled form inputs."
    ],
    "toolSequence": [
      "test_get_result — read the failure details. Note which step failed and the selector used.",
      "Inspect the app source code to check if the element has stable attributes (id, data-testid, role, aria-label).",
      "If the selector uses dynamic class names (CSS modules, styled-components): it will break between builds.",
      "If the element is rendered conditionally or inside a transition: add a wait-for-element step before the interaction.",
      "Add a data-testid attribute to the element in the app source code if no stable selector exists.",
      "Update the scenario to use the data-testid selector and add a wait step.",
      "Re-run the scenario multiple times to verify the fix is stable."
    ],
    "whatGoodLooksLike": [
      "The scenario passes consistently across multiple runs.",
      "The selector uses a stable attribute that will not change between builds.",
      "The wait step ensures the element is rendered before interaction."
    ],
    "whatBadLooksLike": [
      "The scenario still fails intermittently — the timing issue is not fully resolved.",
      "Adding data-testid changes app behavior (unlikely but possible if the attribute conflicts)."
    ],
    "whatToDoNext": [
      "If still flaky: increase the wait timeout or add an assertion that the element is visible before interacting.",
      "If the form field is a complex component (date picker, autocomplete): interact via its UI controls rather than targeting the underlying input directly.",
      "Consider whether the React component needs a fix for accessibility — stable selectors often align with proper ARIA attributes."
    ],
    "tags": [
      "example",
      "test",
      "selector",
      "react",
      "form",
      "flaky"
    ],
    "createdAt": "2026-03-24T00:00:00.000Z",
    "updatedAt": "2026-03-24T00:00:00.000Z"
  },
  {
    "id": "ex-no-result-recovery",
    "type": "example",
    "toolName": "devglide-test",
    "scenario": "Scenario returns no result found — recovery steps",
    "startingAssumptions": [
      "You submitted a scenario via test_run_scenario.",
      "test_get_result returns 'no result found' after waiting."
    ],
    "toolSequence": [
      "test_get_result — confirm the 'no result found' response.",
      "log_read — check if devtools.js is posting any log entries. If no recent entries, devtools.js is not active.",
      "shell_run_command to check if the dev server process is running.",
      "If the dev server is running: the issue is the browser. Ask the user to verify the browser tab is open on the app.",
      "If devtools.js is not in the page source: instruct the user to add the devtools.js script tag.",
      "After the browser is confirmed ready: re-submit the scenario via test_run_scenario.",
      "test_get_result — should now return a real result."
    ],
    "whatGoodLooksLike": [
      "After recovery, test_get_result returns 'passed' or 'failed' (not 'no result found').",
      "log_read shows fresh entries from the current browser session."
    ],
    "whatBadLooksLike": [
      "test_get_result still returns 'no result found' after recovery steps.",
      "log_read shows no entries — devtools.js is still not connected."
    ],
    "whatToDoNext": [
      "If still no result: check that the DevGlide server port matches what devtools.js is configured for.",
      "Check the browser console directly for devtools.js initialization errors.",
      "As a last resort, fully close and reopen the browser, navigate to the app, and retry."
    ],
    "tags": [
      "example",
      "test",
      "no-result",
      "recovery"
    ],
    "createdAt": "2026-03-24T00:00:00.000Z",
    "updatedAt": "2026-03-24T00:00:00.000Z"
  },
  {
    "id": "ex-pass-with-errors",
    "type": "example",
    "toolName": "devglide-test",
    "scenario": "Scenario passes but logs show runtime exception",
    "startingAssumptions": [
      "A test scenario just completed with status 'passed'.",
      "You are about to check logs as part of the verification workflow."
    ],
    "toolSequence": [
      "test_get_result — confirms 'passed'.",
      "log_read with level filter 'error' — read error-level log entries.",
      "Identify the error: read the message, stack trace, and timestamp.",
      "Correlate the error timestamp with the scenario steps to find the trigger.",
      "Determine if the error is in app code (fixable) or third-party (document as noise).",
      "If fixable: fix the app code, re-run the scenario, and re-check logs.",
      "If third-party noise: document it in a project override via docs_add."
    ],
    "whatGoodLooksLike": [
      "After the fix, the scenario still passes AND logs are clean of unexpected errors.",
      "If the error was third-party noise: a project override documents it for future runs."
    ],
    "whatBadLooksLike": [
      "The fix breaks the scenario — it now fails.",
      "New errors appear after the fix.",
      "The error is intermittent and hard to reproduce."
    ],
    "whatToDoNext": [
      "If the fix broke the scenario: the fix may be incorrect. Revert and investigate further.",
      "If new errors appeared: the fix had side effects. Review the change carefully.",
      "If intermittent: run the scenario multiple times and check logs each time to gather more data."
    ],
    "tags": [
      "example",
      "test",
      "log",
      "runtime-error",
      "false-positive"
    ],
    "createdAt": "2026-03-24T00:00:00.000Z",
    "updatedAt": "2026-03-24T00:00:00.000Z"
  },
  {
    "id": "ex-test-ui-flow",
    "type": "example",
    "toolName": "devglide-test",
    "scenario": "Test a UI flow and inspect logs after run",
    "startingAssumptions": [
      "The app dev server is running.",
      "A browser page is open on the app with devtools.js loaded.",
      "The DevGlide server is running on port 7000.",
      "You know which UI flow to test (e.g. 'create a new item', 'submit a form')."
    ],
    "toolSequence": [
      "test_list_saved — check if a relevant saved scenario exists.",
      "test_run_scenario with a natural language description of the flow (e.g. 'Navigate to the form page, fill in the name field with \"Test Club\", select a category, and click Submit. Verify a success message appears.')",
      "Wait 3-5 seconds for the browser to consume and execute the scenario.",
      "test_get_result — read the scenario outcome.",
      "log_read with targetPath for the project log — read the browser console output after the run.",
      "Assess: scenario passed + no unexpected errors in logs = verification success."
    ],
    "whatGoodLooksLike": [
      "test_get_result returns status 'passed' with all steps completed.",
      "log_read shows normal app output — no errors, only expected info/debug messages.",
      "The UI reflects the expected state after the flow (e.g. the new item appears in a list)."
    ],
    "whatBadLooksLike": [
      "test_get_result returns 'no result found' — the browser did not consume the scenario.",
      "test_get_result returns status 'failed' with a step failure.",
      "log_read shows error-level entries (unhandled exceptions, assertion failures).",
      "test_get_result returns 'passed' but logs contain runtime errors."
    ],
    "whatToDoNext": [
      "If 'no result found': verify browser is open with devtools.js, then retry.",
      "If a step failed: read the failure details, check the selector and timing, and fix the scenario or app code.",
      "If logs show errors: diagnose the root cause from the error message and stack trace, fix the app, and re-run.",
      "If the scenario passed but logs have errors: treat as failure — add assertions or fix the underlying error."
    ],
    "tags": [
      "example",
      "test",
      "log",
      "verification",
      "ui"
    ],
    "createdAt": "2026-03-24T00:00:00.000Z",
    "updatedAt": "2026-03-24T00:00:00.000Z"
  },
  {
    "id": "guide-devglide-log",
    "type": "tool-guide",
    "toolName": "devglide-log",
    "summary": "Read and manage structured log files captured from browser console output and server-side processes. Used alongside devglide-test to verify that apps run without runtime errors.",
    "executionModel": "File-based log capture. The browser-side sniffer (devtools.js) intercepts console.log/warn/error calls and POSTs them to the DevGlide server, which appends them to a log file. Server-side logs are captured separately. log_read returns recent entries from a target log file.",
    "prerequisites": [
      "devtools.js must be loaded in the browser page for browser-side log capture.",
      "The DevGlide server must be running to receive log POST requests.",
      "A log session must be active — devtools.js creates a session on page load."
    ],
    "inputsExplained": {
      "targetPath": "Path to the log file to read. For project-scoped logs, this is typically ~/.devglide/projects/{projectId}/logs/{project-name}-console.log. If omitted, reads the default DevGlide console log.",
      "lines": "Number of recent lines to return. Defaults to 50.",
      "level": "Optional filter by log level (log, warn, error, info, debug)."
    },
    "resultSemantics": {
      "entries_returned": "Log entries matching the query. Each entry includes timestamp, level, source, and message.",
      "empty_result": "No log entries found. This may mean: no logs captured yet, wrong targetPath, or devtools.js not loaded.",
      "error_entries": "Entries with level 'error' indicate runtime exceptions or failed assertions in the app."
    },
    "preferredPatterns": [
      "Always read logs after every devglide-test scenario run — log review is mandatory for verification, not optional.",
      "To find the correct log path for a project: the pattern is ~/.devglide/projects/{projectId}/logs/{project-name}-console.log where project-name is the name registered in DevGlide.",
      "Filter by level 'error' first to quickly identify runtime failures.",
      "Distinguish expected noise from real failures. Common expected noise includes: map tile 404s, font loading warnings, style sheet 404s from optional dependencies, and development-mode React warnings.",
      "When a scenario passes but logs show errors, treat the errors as failures — a passing scenario does not mean the app is healthy."
    ],
    "antiPatterns": [
      "Do not skip log review after test runs. A scenario can pass while the app throws unhandled exceptions.",
      "Do not assume an empty log means success — it may mean devtools.js is not capturing.",
      "Do not treat all warnings as failures. Many frameworks emit development-mode warnings that are not bugs.",
      "Do not read logs from a stale session. Check the session timestamp to ensure you are reading current output."
    ],
    "followUpChecks": [
      "After identifying errors in logs, correlate them with the scenario step that was executing at that timestamp.",
      "If logs show errors but the scenario passed, the error may be in a background process or async operation not covered by the scenario steps."
    ],
    "commonFailures": [
      "No log entries despite running the app — devtools.js not loaded or posting to wrong server URL.",
      "Log file path does not exist — project not registered in DevGlide or using wrong project name.",
      "Logs show hundreds of entries — filter by level or use lines parameter to limit output."
    ],
    "seeAlso": [
      "devglide-test"
    ],
    "tags": [
      "log",
      "debugging",
      "verification",
      "console"
    ],
    "createdAt": "2026-03-24T00:00:00.000Z",
    "updatedAt": "2026-03-24T00:00:00.000Z"
  },
  {
    "id": "guide-devglide-test",
    "type": "tool-guide",
    "toolName": "devglide-test",
    "summary": "Run browser automation scenarios against an app instrumented with devtools.js. Scenarios are described in natural language, translated into browser commands, and executed inside a real browser page.",
    "executionModel": "Browser-driven, not server-driven. Submitting a scenario via test_run_scenario or test_run_saved only queues work on the server. Actual execution happens inside the browser page where devtools.js is loaded — it polls the server for pending scenarios and runs them in-page. The server never drives the browser directly.",
    "prerequisites": [
      "The app's dev server must be running and reachable at its expected URL.",
      "A real browser page must be open on the app (not just a server process).",
      "devtools.js must be loaded in the page — add <script src=\"http://localhost:7000/devtools.js\"></script> to the app's HTML in development.",
      "The browser session must be active — devtools.js polls the DevGlide server; if the tab is closed or navigated away, polling stops.",
      "The DevGlide server must be running (default port 7000)."
    ],
    "inputsExplained": {
      "scenario": "A natural-language description of what to test. DevGlide translates this into a sequence of browser commands (navigate, click, type, assert, wait, etc.).",
      "target": "The base URL of the app under test. Resolved from the active project if not specified.",
      "steps": "When using test_run_scenario with explicit steps, each step is a command object (e.g. { command: 'click', selector: '#submit' })."
    },
    "resultSemantics": {
      "passed": "All steps completed successfully. The scenario ran to completion without assertion failures.",
      "failed": "One or more steps failed. Inspect the failed step details and check devglide-log for runtime errors.",
      "no_result_found": "The browser has NOT consumed the scenario yet. This is NOT a test failure — it means devtools.js has not polled or the page is not open. Wait briefly and retry test_get_result, or verify the browser is open with devtools.js loaded."
    },
    "preferredPatterns": [
      "Use click-based navigation after the initial page load. Simulate what a real user would do — click links, buttons, and menu items rather than navigating via URL.",
      "Wait for state changes, not fixed timeouts. Use assertions or wait-for-element steps rather than arbitrary sleep durations.",
      "Keep scenarios focused on one user flow. A scenario that tests club creation should not also test user settings.",
      "Inspect devglide-log after every run — even if the scenario passes, the logs may contain runtime errors or unexpected warnings.",
      "For stateful React forms with controlled inputs, add targeted data-testid attributes only where semantic selectors (role, label, placeholder) are unstable.",
      "Prefer realistic data in scenarios — use plausible names, emails, and values rather than 'test123'."
    ],
    "antiPatterns": [
      "Do not treat 'no result found' as a normal test failure. It means the scenario was not consumed by the browser.",
      "Do not use excessive navigate steps. Each full navigation can reset React state, unmount components, and break stateful flows.",
      "Do not rely only on scenario pass/fail without reviewing logs. A passing scenario can mask runtime errors visible in the console.",
      "Do not use fragile CSS selectors like nth-child or deeply nested class chains. Prefer data-testid, role, or label-based selectors.",
      "Do not run scenarios against a page that has not finished loading. Wait for the app to be interactive before submitting."
    ],
    "followUpChecks": [
      "Read the browser log via devglide-log after every scenario run.",
      "Distinguish expected noise (e.g. map tile 404s, style loading warnings) from real failures (unhandled exceptions, assertion errors).",
      "If the scenario fails, check both the step failure details AND the logs — the root cause is often visible in the console before the step that failed."
    ],
    "commonFailures": [
      "Scenario queued but never runs — browser tab closed, devtools.js not loaded, or wrong target URL.",
      "Selector works in DevTools but automation fails — element not yet rendered, inside shadow DOM, or hidden behind an overlay.",
      "React controlled input does not update — automation types text but React state does not reflect it. Use dispatchEvent with InputEvent or interact via the React fiber.",
      "Navigate causes full reload and context loss — stateful app loses form data mid-flow. Use click navigation instead."
    ],
    "seeAlso": [
      "devglide-log"
    ],
    "tags": [
      "test",
      "browser",
      "automation",
      "devtools"
    ],
    "createdAt": "2026-03-24T00:00:00.000Z",
    "updatedAt": "2026-03-24T00:00:00.000Z"
  },
  {
    "id": "ts-controlled-input",
    "type": "troubleshooting",
    "toolName": "devglide-test",
    "symptom": "React controlled input does not update as expected",
    "likelyCauses": [
      "The automation sets the input value directly (e.g. element.value = 'text') but React does not recognize the change because no synthetic event was fired.",
      "React controlled inputs require an InputEvent or Change event dispatched through the React event system to trigger state updates.",
      "The input has a debounce or validation handler that delays or rejects the change."
    ],
    "howToDiagnose": [
      "Check if the input is controlled (has a value prop bound to React state).",
      "After the type step, check whether the displayed value matches what was typed.",
      "Look at React DevTools to see if the component state updated.",
      "Check the browser console for React warnings about uncontrolled-to-controlled transitions."
    ],
    "howToFix": [
      "Use the type command which simulates individual key presses — this usually fires the correct events for React.",
      "If type does not work, the scenario may need to dispatch a native InputEvent: new InputEvent('input', { bubbles: true, data: 'text' }).",
      "For complex form fields (date pickers, rich text editors), interact through their UI controls rather than setting values directly.",
      "Add a data-testid to the input and verify the value via assertion after typing."
    ],
    "whenToRetry": "After switching to the type command or implementing proper event dispatch.",
    "tags": [
      "test",
      "react",
      "input",
      "controlled",
      "form"
    ],
    "createdAt": "2026-03-24T00:00:00.000Z",
    "updatedAt": "2026-03-24T00:00:00.000Z"
  },
  {
    "id": "ts-expected-warnings",
    "type": "troubleshooting",
    "toolName": "devglide-log",
    "symptom": "logs contain expected app-specific warnings",
    "likelyCauses": [
      "The app has known non-critical warnings that appear during normal operation.",
      "Common examples: map tile 404s when no local tileserver is running, font loading failures from CDN, stylesheet 404s from optional dependencies, React development-mode warnings.",
      "These are not bugs — they are expected noise for the current development environment."
    ],
    "howToDiagnose": [
      "Check the log level — warnings (level: warn) are typically non-critical.",
      "Check if the warning message matches known patterns for the app (e.g. 'Failed to load tile', '404 for /fonts/', 'React does not recognize the X prop').",
      "Check project documentation or overrides for a list of known expected warnings.",
      "If unsure, ask the user whether the warning is expected for their app."
    ],
    "howToFix": [
      "Do not treat expected warnings as failures in verification.",
      "Document known expected warnings in a project override so other agents can distinguish them from real failures.",
      "If the warning is unexpected: investigate whether a dependency is missing or misconfigured.",
      "Filter log output by level 'error' to focus on real failures."
    ],
    "whenToRetry": "Not applicable — this is about correct interpretation, not a fixable failure.",
    "tags": [
      "log",
      "warnings",
      "noise",
      "expected"
    ],
    "createdAt": "2026-03-24T00:00:00.000Z",
    "updatedAt": "2026-03-24T00:00:00.000Z"
  },
  {
    "id": "ts-navigate-reload",
    "type": "troubleshooting",
    "toolName": "devglide-test",
    "symptom": "navigate causes reload and context loss",
    "likelyCauses": [
      "The scenario uses a navigate step that triggers a full page reload instead of client-side routing.",
      "The app is a single-page app (SPA) but the navigate step goes to a different origin or uses a full URL that bypasses the client router.",
      "React or framework state (form data, auth tokens, component state) is lost on full reload.",
      "devtools.js must re-initialize after a full page reload, causing a gap in the polling loop."
    ],
    "howToDiagnose": [
      "Check the scenario steps — is there a navigate command mid-flow?",
      "Check if the app uses client-side routing (React Router, Next.js, etc.).",
      "Look at the browser network tab to confirm whether a full page load occurred."
    ],
    "howToFix": [
      "Replace navigate steps with click-based navigation. Click the link, button, or menu item that the user would click to reach that page.",
      "If a navigate is necessary (e.g. initial page load), keep it as the first step only.",
      "For SPAs, ensure the navigate URL uses the same origin and lets the client router handle routing.",
      "If form state is lost: restructure the scenario to complete one form before navigating away."
    ],
    "whenToRetry": "After rewriting the scenario to use click-based navigation instead of navigate steps.",
    "tags": [
      "test",
      "navigate",
      "reload",
      "spa",
      "state-loss"
    ],
    "createdAt": "2026-03-24T00:00:00.000Z",
    "updatedAt": "2026-03-24T00:00:00.000Z"
  },
  {
    "id": "ts-no-result-found",
    "type": "troubleshooting",
    "toolName": "devglide-test",
    "symptom": "test_get_result returns no result found",
    "likelyCauses": [
      "The browser page is not open or the tab is inactive.",
      "devtools.js is not loaded in the page.",
      "The browser is open on a different URL than the target app.",
      "devtools.js polling was interrupted (page navigated away, tab crashed, or JavaScript error blocked polling).",
      "The DevGlide server restarted after the scenario was submitted but before the browser consumed it."
    ],
    "howToDiagnose": [
      "Check that a browser page is open on the target app URL.",
      "Open the browser DevTools console and look for 'devglide' messages confirming devtools.js is active.",
      "Check devglide-log for recent session entries — if there are none, devtools.js is not connected.",
      "Verify the DevGlide server is running on the expected port (default 7000)."
    ],
    "howToFix": [
      "Open the app in a browser if no page is open.",
      "Add <script src=\"http://localhost:7000/devtools.js\"></script> to the app's development HTML if devtools.js is missing.",
      "Refresh the browser page to restart the devtools.js polling loop.",
      "Re-submit the scenario after confirming the browser is ready."
    ],
    "whenToRetry": "After confirming the browser page is open and devtools.js is loaded. Wait 2-5 seconds after the fix, then call test_get_result again.",
    "tags": [
      "test",
      "no-result",
      "browser",
      "devtools"
    ],
    "createdAt": "2026-03-24T00:00:00.000Z",
    "updatedAt": "2026-03-24T00:00:00.000Z"
  },
  {
    "id": "ts-pass-but-errors",
    "type": "troubleshooting",
    "toolName": "devglide-test",
    "symptom": "scenario passes but console logs show runtime error",
    "likelyCauses": [
      "The runtime error occurs in async code (setTimeout, Promise, event handler) that is not part of the synchronous scenario execution flow.",
      "The error occurs in a background component or service worker, not in the component being tested.",
      "The scenario assertions do not check for error states — they only verify the happy path.",
      "A race condition causes the error only sometimes, depending on timing."
    ],
    "howToDiagnose": [
      "Read the full log output after the scenario run. Filter by level 'error'.",
      "Correlate the error timestamp with the scenario steps to identify which action triggered it.",
      "Check if the error is in app code or a third-party library.",
      "Run the scenario multiple times to check if the error is consistent or intermittent."
    ],
    "howToFix": [
      "Treat the runtime error as a real failure even though the scenario passed — the scenario assertions were incomplete.",
      "Fix the runtime error in the app code.",
      "Add assertion steps to the scenario that verify no error state is visible (e.g. check that no error toast or banner appeared).",
      "If the error is in a third-party library and cannot be fixed: document it as expected noise in a project override."
    ],
    "whenToRetry": "After fixing the runtime error. Re-run the scenario and verify that both the scenario passes AND logs are clean.",
    "tags": [
      "test",
      "log",
      "runtime-error",
      "false-positive"
    ],
    "createdAt": "2026-03-24T00:00:00.000Z",
    "updatedAt": "2026-03-24T00:00:00.000Z"
  },
  {
    "id": "ts-scenario-never-runs",
    "type": "troubleshooting",
    "toolName": "devglide-test",
    "symptom": "scenario accepted but never runs",
    "likelyCauses": [
      "devtools.js is loaded but polling is blocked by a JavaScript error in the app.",
      "The app page is open but on a route that does not load devtools.js (e.g. a separate login page or error page).",
      "A previous scenario is still running or stuck, blocking the queue.",
      "The target URL in the scenario does not match the page currently open in the browser.",
      "Browser DevTools is paused on a breakpoint, blocking script execution."
    ],
    "howToDiagnose": [
      "Check the browser console for JavaScript errors that may have halted devtools.js.",
      "Verify the page URL matches the expected target for the scenario.",
      "Check if a previous scenario result is pending via test_get_result.",
      "Look for 'devglide runner' messages in the browser console confirming the polling loop is active."
    ],
    "howToFix": [
      "If a JS error is blocking devtools.js: fix the error or refresh the page.",
      "If on the wrong page: navigate to the correct app URL.",
      "If a previous scenario is stuck: refresh the page to clear the queue.",
      "If DevTools is paused: resume execution."
    ],
    "whenToRetry": "After clearing the blocking condition. Re-submit the scenario — do not assume the old submission will eventually run.",
    "tags": [
      "test",
      "scenario",
      "stuck",
      "polling"
    ],
    "createdAt": "2026-03-24T00:00:00.000Z",
    "updatedAt": "2026-03-24T00:00:00.000Z"
  },
  {
    "id": "ts-selector-fails",
    "type": "troubleshooting",
    "toolName": "devglide-test",
    "symptom": "selector works manually but automation fails",
    "likelyCauses": [
      "The element is not yet rendered when the automation tries to find it (timing issue).",
      "The element is inside a shadow DOM and the selector does not pierce it.",
      "The element is hidden behind a modal, overlay, or loading spinner.",
      "The selector relies on dynamically generated class names (e.g. CSS modules, styled-components) that change between builds.",
      "The element is in an iframe that the automation does not target."
    ],
    "howToDiagnose": [
      "Add a wait-for-element step before the interaction step.",
      "Check if the element is visible in the DOM at the time of the step (not hidden by CSS or not yet mounted).",
      "Inspect whether the element is inside a shadow DOM boundary.",
      "Check if the class names in the selector are stable across builds."
    ],
    "howToFix": [
      "Add a wait step before interacting with the element.",
      "Use stable selectors: data-testid, role attributes, aria-label, or visible text content.",
      "If the element is behind a modal: add a step to dismiss the modal first.",
      "If class names are dynamic: add a data-testid attribute to the element in the app source code.",
      "If inside shadow DOM: use the appropriate shadow DOM piercing selector or restructure the test to avoid it."
    ],
    "whenToRetry": "After updating the selector or adding appropriate wait steps.",
    "tags": [
      "test",
      "selector",
      "timing",
      "dom"
    ],
    "createdAt": "2026-03-24T00:00:00.000Z",
    "updatedAt": "2026-03-24T00:00:00.000Z"
  },
  {
    "id": "workflow-verify-ui-flow",
    "type": "workflow",
    "name": "verify-ui-flow-with-devglide-test-and-devglide-log",
    "goal": "Verify a UI flow end-to-end using browser test scenarios and log review. This is the standard verification loop for confirming that an app feature works correctly.",
    "toolsInvolved": [
      "devglide-test",
      "devglide-log"
    ],
    "preflight": [
      "Confirm the target app and its expected URL (check project config or ask the user).",
      "Confirm the app's dev server is running. If not, start it via devglide-shell.",
      "Confirm a browser page is open on the app with devtools.js loaded.",
      "Confirm the browser session is active by checking devglide-log for recent session entries."
    ],
    "stepSequence": [
      "Identify the UI flow to verify (e.g. 'create a club', 'submit a form', 'navigate to settings').",
      "Check if a saved test scenario already exists via test_list_saved. Reuse if available.",
      "If no saved scenario exists, create a realistic scenario describing the user flow in natural language. Use click-based navigation, realistic data, and targeted assertions.",
      "Run the scenario via test_run_saved or test_run_scenario.",
      "Wait briefly (2-5 seconds) then check the result via test_get_result.",
      "If test_get_result returns 'no result found', the browser has not consumed the scenario yet. Verify the browser is open and devtools.js is loaded. Retry test_get_result after a few seconds.",
      "Read browser logs via log_read immediately after the run — filter for errors first.",
      "Separate expected noise from true failures. Expected noise includes: map tile 404s, font/style loading warnings, React development warnings.",
      "If the scenario failed: examine the failed step, correlate with log entries at that timestamp, and diagnose the root cause.",
      "If the scenario passed but logs show runtime errors: treat as a failure. The error may be in async code not covered by scenario assertions.",
      "Fix the identified issue in the application code.",
      "Re-run the scenario and re-check logs. Repeat until the scenario passes AND logs are clean of unexpected errors.",
      "Report the verification result: pass/fail, what was tested, any fixes applied, and any known non-blocking warnings."
    ],
    "successCriteria": [
      "The test scenario passes — all steps complete without assertion failures.",
      "Browser logs contain no unexpected errors after the run.",
      "Any app-specific expected noise is identified and excluded from failure assessment.",
      "The verification result is reported clearly."
    ],
    "failureBranches": [
      "If devtools.js is not loaded: guide the user to add the script tag to their app's development HTML.",
      "If the dev server is not running: start it via shell_run_command.",
      "If 'no result found' persists after multiple retries: check that the browser tab is active and not on a different page.",
      "If a selector fails: inspect the page structure, consider adding data-testid attributes for unstable elements.",
      "If a controlled input does not update: use the appropriate input simulation technique for the framework (React needs InputEvent dispatch).",
      "If logs show errors unrelated to the test flow: note them as pre-existing issues and focus on the target flow."
    ],
    "expectedOutputs": [
      "test_get_result with status 'passed' or 'failed' and step details.",
      "log_read output showing browser console entries during and after the test run.",
      "A clear verification report."
    ],
    "expectedNoise": [
      "Map tile 404s when no local tileserver is running.",
      "Font or stylesheet loading warnings from CDN dependencies.",
      "React development-mode warnings (e.g. key props, deprecated lifecycle methods).",
      "Service worker registration messages."
    ],
    "tags": [
      "verification",
      "testing",
      "ui",
      "workflow",
      "devglide-test",
      "devglide-log"
    ],
    "createdAt": "2026-03-24T00:00:00.000Z",
    "updatedAt": "2026-03-24T00:00:00.000Z"
  }
];
