(function () {
  'use strict';

  // ---- 1. Extract config — injected global or script-tag src ----

  var serverOrigin, targetPath;

  var _cfg = window.__devglideRunnerConfig;
  if (_cfg) {
    serverOrigin = _cfg.serverOrigin;
    targetPath   = _cfg.target;
    delete window.__devglideRunnerConfig;
  } else {
    var scriptEl = document.currentScript;
    if (!scriptEl) {
      var scripts = document.getElementsByTagName('script');
      for (var i = 0; i < scripts.length; i++) {
        var src = scripts[i].getAttribute('src') || '';
        if (src.indexOf('scenario-runner.js') !== -1) {
          scriptEl = scripts[i];
          break;
        }
      }
    }

    if (!scriptEl) {
      return;
    }

    var fullSrc = scriptEl.getAttribute('src');

    var originMatch = fullSrc.match(/^(https?:\/\/[^\/]+)/);
    if (!originMatch) {
      return;
    }
    serverOrigin = originMatch[1];

    targetPath = '';
    var qIndex = fullSrc.indexOf('?');
    if (qIndex !== -1) {
      var query = fullSrc.substring(qIndex + 1);
      var params = query.split('&');
      for (var p = 0; p < params.length; p++) {
        var kv = params[p].split('=');
        var key = kv[0];
        var val = decodeURIComponent(kv.slice(1).join('='));
        if (key === 'target') {
          targetPath = val;
        }
      }
    }
  }

  if (!targetPath) {
    return;
  }

  // ---- 2. Trigger module ----

  var DEFAULT_TIMEOUT = 5000;

  var LS_KEY = 'cs-trigger-scenario';

  function saveProgress(scenario, nextStepIndex) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        steps: scenario.steps,
        nextStepIndex: nextStepIndex,
        target: scenario.target || null,
        savedAt: new Date().toISOString()
      }));
    } catch (e) {
      console.warn('[scenario-runner] Cannot save progress to localStorage: ' + e.message);
    }
  }

  function clearProgress() {
    try {
      localStorage.removeItem(LS_KEY);
    } catch (e) {
      // ignore
    }
  }

  function loadProgress() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (data.savedAt) {
        var elapsed = Date.now() - new Date(data.savedAt).getTime();
        if (elapsed > 5 * 60 * 1000) {
          localStorage.removeItem(LS_KEY);
          return null;
        }
      }
      return data;
    } catch (e) {
      return null;
    }
  }

  function resolveElement(selector) {
    var el = document.querySelector(selector);
    if (!el) {
      throw new Error('Element not found: ' + selector);
    }
    return el;
  }

  function waitForElement(selector, timeout) {
    var deadline = Date.now() + (timeout || DEFAULT_TIMEOUT);
    return new Promise(function (resolve, reject) {
      var check = function () {
        var el = document.querySelector(selector);
        if (el) {
          resolve(el);
        } else if (Date.now() >= deadline) {
          reject(new Error('Timed out waiting for element: ' + selector));
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
  }

  function waitForElementHidden(selector, timeout) {
    var deadline = Date.now() + (timeout || DEFAULT_TIMEOUT);
    return new Promise(function (resolve, reject) {
      var check = function () {
        var el = document.querySelector(selector);
        if (!el || el.offsetParent === null) {
          resolve();
        } else if (Date.now() >= deadline) {
          reject(new Error('Timed out waiting for element to hide: ' + selector));
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
  }

  function dispatchInputEvents(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  var executors = {
    click: function (step) {
      var el = resolveElement(step.selector);
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return Promise.resolve();
    },

    dblclick: function (step) {
      var el = resolveElement(step.selector);
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      return Promise.resolve();
    },

    type: function (step) {
      var el = resolveElement(step.selector);
      var descriptor = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(el).constructor.prototype || HTMLInputElement.prototype, 'value'
      );
      var setValue = (descriptor && descriptor.set)
        ? function (v) { descriptor.set.call(el, v); }
        : function (v) { el.value = v; };

      if (step.clear !== false) {
        setValue('');
        dispatchInputEvents(el);
      }
      setValue(step.text || '');
      dispatchInputEvents(el);
      return Promise.resolve();
    },

    select: function (step) {
      var el = resolveElement(step.selector);
      el.value = step.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return Promise.resolve();
    },

    wait: function (step) {
      return new Promise(function (resolve) {
        setTimeout(resolve, step.ms || 0);
      });
    },

    waitFor: function (step) {
      return waitForElement(step.selector, step.timeout);
    },

    waitForHidden: function (step) {
      return waitForElementHidden(step.selector, step.timeout);
    },

    find: function (step) {  // alias for waitFor
      return waitForElement(step.selector, step.timeout);
    },

    assertExists: function (step) {
      resolveElement(step.selector);
      return Promise.resolve();
    },

    assertNotExists: function (step) {
      var el = document.querySelector(step.selector);
      if (el) {
        throw new Error('assertNotExists failed: element "' + step.selector + '" exists');
      }
      return Promise.resolve();
    },

    assertText: function (step) {
      var el = resolveElement(step.selector);
      var actual = (el.textContent || '').trim();
      var expected = step.text || '';
      var isContains = step.contains !== false; // default true
      if (isContains) {
        if (actual.indexOf(expected) === -1) {
          throw new Error('assertText failed: "' + actual + '" does not contain "' + expected + '"');
        }
      } else {
        if (actual !== expected) {
          throw new Error('assertText failed: expected "' + expected + '" but got "' + actual + '"');
        }
      }
      return Promise.resolve();
    },

    logPath: function () {
      console.log('[scenario-runner] Current path: ' + window.location.href);
      return Promise.resolve();
    },

    logBody: function () {
      console.log('[scenario-runner] Current body HTML: ' + document.body.innerHTML);
      return Promise.resolve();
    },

    logHead: function () {
      console.log('[scenario-runner] Current head HTML: ' + document.head.innerHTML);
      return Promise.resolve();
    },

    navigate: function (step, scenario, stepIndex) {
      if (typeof step.path !== 'string' || !step.path.startsWith('/') || step.path.indexOf('//') !== -1) {
        return Promise.reject(new Error('navigate: invalid path "' + step.path + '". Must be a relative path starting with "/" and must not contain "//"'));
      }
      saveProgress(scenario, stepIndex + 1);
      window.location.href = step.path;
      return new Promise(function () {});
    }
  };

  var resultUrl = serverOrigin + '/api/test/trigger/scenarios/';

  function reportResult(scenarioId, status, failedStep, error, duration) {
    var body = { status: status };
    if (typeof failedStep === 'number') body.failedStep = failedStep;
    if (error) body.error = error;
    if (typeof duration === 'number') body.duration = duration;
    try {
      fetch(resultUrl + encodeURIComponent(scenarioId) + '/result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).catch(function (err) {
        console.warn('[scenario-runner] Failed to report result: ' + err.message);
      });
    } catch (e) {
      // ignore — fire-and-forget
    }
  }

  function runScenario(scenario, startIndex) {
    var steps = scenario.steps || [];
    var i = startIndex || 0;
    var startTime = Date.now();

    function nextStep() {
      if (i >= steps.length) {
        return Promise.resolve();
      }
      var step = steps[i];
      var currentIndex = i;
      i++;
      var executor = executors[step.command];
      if (!executor) {
        var err = new Error('Unknown command: ' + step.command);
        err._failedStep = currentIndex;
        return Promise.reject(err);
      }
      try {
        return executor(step, scenario, currentIndex).then(function () {
          return nextStep();
        }, function (err) {
          err._failedStep = currentIndex;
          return Promise.reject(err);
        });
      } catch (e) {
        e._failedStep = currentIndex;
        return Promise.reject(e);
      }
    }

    return nextStep().then(function () {
      clearProgress();
      var duration = Date.now() - startTime;
      reportResult(scenario.id, 'passed', undefined, undefined, duration);
    }, function (err) {
      clearProgress();
      var duration = Date.now() - startTime;
      reportResult(scenario.id, 'failed', err._failedStep, err.message, duration);
      throw err;
    });
  }

  // ---- 3. Scenario delivery — SSE primary, HTTP poll fallback ----

  var streamUrl = serverOrigin + '/api/test/trigger/scenarios/stream?target=' + encodeURIComponent(targetPath).replace(/%2F/gi, '/');
  var pollUrl = serverOrigin + '/api/test/trigger/scenarios/poll?target=' + encodeURIComponent(targetPath).replace(/%2F/gi, '/');

  // Shared handler: process a scenario received from either SSE or poll
  function handleScenario(scenario) {
    return runScenario(scenario).then(function () {
      console.log('[scenario-runner] Scenario completed: ' + (scenario.name || scenario.id));
    }).catch(function (err) {
      console.error('[scenario-runner] Scenario failed: ' + err.message);
    });
  }

  // ---- SSE stream (primary mechanism) ----

  var eventSource = null;

  function connectSSE() {
    eventSource = new EventSource(streamUrl);

    eventSource.onmessage = function (event) {
      var scenario;
      try {
        scenario = JSON.parse(event.data);
      } catch (e) {
        console.warn('[scenario-runner] Failed to parse SSE data: ' + e.message);
        return;
      }
      if (!scenario || !scenario.steps) return;
      handleScenario(scenario);
    };

    eventSource.onerror = function () {
      // EventSource automatically reconnects on error.
      // Log only once per error event to avoid spam.
      console.warn('[scenario-runner] SSE connection error — reconnecting...');
    };
  }

  // ---- HTTP poll fallback (used only if EventSource is unavailable) ----

  var POLL_INTERVAL = 30000;
  var retryDelay = 2000;
  var maxRetryDelay = 30000;
  var pollTimer = null;

  function pollLoop() {
    // Don't poll while the tab is hidden — resume on visibility change
    if (document.hidden) return;

    fetch(pollUrl).then(function (response) {
      if (response.status === 204) {
        retryDelay = 2000;
        pollTimer = setTimeout(pollLoop, POLL_INTERVAL);
        return;
      }
      if (!response.ok) {
        throw new Error('Poll returned status ' + response.status);
      }
      return response.json();
    }).then(function (scenario) {
      if (!scenario) {
        return;
      }
      retryDelay = 2000;
      return handleScenario(scenario).then(function () {
        pollLoop();
      });
    }).catch(function (err) {
      console.warn('[scenario-runner] Poll error, retrying in ' + retryDelay + 'ms: ' + err.message);
      pollTimer = setTimeout(function () {
        retryDelay = Math.min(retryDelay * 2, maxRetryDelay);
        pollLoop();
      }, retryDelay);
    });
  }

  // Pause polling when tab is hidden, resume when visible (poll fallback only)
  function onVisibilityChangePoll() {
    if (!document.hidden) {
      clearTimeout(pollTimer);
      pollLoop();
    }
  }

  // ---- Start listening ----

  function startListening() {
    if (typeof EventSource !== 'undefined') {
      connectSSE();
    } else {
      // Fallback for environments without EventSource support
      console.warn('[scenario-runner] EventSource not available — falling back to HTTP polling');
      document.addEventListener('visibilitychange', onVisibilityChangePoll);
      pollLoop();
    }
  }

  function tryResumeScenario() {
    var saved = loadProgress();
    if (!saved) return false;
    var savedTarget = saved.target || null;
    if (savedTarget !== targetPath) {
      clearProgress();
      return false;
    }
    if (!saved.steps || saved.nextStepIndex >= saved.steps.length) {
      clearProgress();
      return false;
    }
    console.log('[scenario-runner] Resuming scenario "' + (saved.scenarioName || saved.scenarioId) + '" from step ' + saved.nextStepIndex);
    var scenario = {
      id: saved.scenarioId,
      name: saved.scenarioName,
      steps: saved.steps,
      target: saved.target
    };
    runScenario(scenario, saved.nextStepIndex).then(function () {
      console.log('[scenario-runner] Scenario completed: ' + (scenario.name || scenario.id));
    }).catch(function (err) {
      console.error('[scenario-runner] Scenario failed: ' + err.message);
    }).then(function () {
      startListening();
    });
    return true;
  }

  if (!tryResumeScenario()) {
    startListening();
  }

})();
