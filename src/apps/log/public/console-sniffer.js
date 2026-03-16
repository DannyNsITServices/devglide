(function () {
  'use strict';

  // ---- 1. Extract config — injected global or script-tag src ----

  var serverOrigin, targetPath, persistent, allowedTypes;

  var _cfg = window.__devglideSnifferConfig;
  if (_cfg) {
    serverOrigin = _cfg.serverOrigin;
    targetPath   = _cfg.targetPath;
    persistent   = !!_cfg.persistent;
    allowedTypes = _cfg.allowedTypes || {};
    delete window.__devglideSnifferConfig;
  } else {
    var scriptEl = document.currentScript;
    if (!scriptEl) {
      var scripts = document.getElementsByTagName('script');
      for (var i = 0; i < scripts.length; i++) {
        var src = scripts[i].getAttribute('src') || '';
        if (src.indexOf('console-sniffer.js') !== -1) {
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
    persistent = false;
    allowedTypes = {};
    var qIndex = fullSrc.indexOf('?');
    if (qIndex !== -1) {
      var query = fullSrc.substring(qIndex + 1);
      var params = query.split('&');
      for (var p = 0; p < params.length; p++) {
        var kv = params[p].split('=');
        var key = kv[0];
        var val = decodeURIComponent(kv.slice(1).join('='));
        if (key === 'targetPath') {
          targetPath = val;
        } else if (key === 'persistent') {
          persistent = (val === 'true');
        } else if (key === 'levels') {
          var lvlParts = val.split(',');
          for (var l = 0; l < lvlParts.length; l++) {
            var t = lvlParts[l].trim().toUpperCase();
            if (t) { allowedTypes[t] = true; }
          }
        }
      }
    }
  }

  if (!targetPath) {
    return;
  }

  // ---- 2. Sniffer module ----

  var apiUrl = serverOrigin + '/api/log';
  var clearUrl = serverOrigin + '/api/log?targetPath=' + encodeURIComponent(targetPath);

  function generateSessionId() {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      var arr = new Uint32Array(1);
      crypto.getRandomValues(arr);
      return ('00000000' + arr[0].toString(16)).slice(-8);
    }
    return ('00000000' + Math.floor(Math.random() * 0xFFFFFFFF).toString(16)).slice(-8);
  }

  var sessionId = generateSessionId();
  var seqCounter = 0;

  if (!persistent) {
    try {
      fetch(clearUrl, { method: 'DELETE' }).catch(function () {});
    } catch (e) {}
  }

  try {
    fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        type:       'SESSION_START',
        session:    sessionId,
        seq:        seqCounter++,
        ts:         new Date().toISOString(),
        url:        window.location.href,
        ua:         navigator.userAgent,
        targetPath: targetPath,
        persistent: persistent
      })
    }).catch(function () {});
  } catch (e) {}

  function formatArgs(args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) {
      var arg = args[i];
      if (arg === null) {
        parts.push('null');
      } else if (arg === undefined) {
        parts.push('undefined');
      } else if (typeof arg === 'object') {
        try {
          parts.push(JSON.stringify(arg));
        } catch (e) {
          parts.push('[object Object]');
        }
      } else {
        parts.push(String(arg));
      }
    }
    return parts.join(' ');
  }

  function sendLog(type, message, extra) {
    if (Object.keys(allowedTypes).length > 0 && !allowedTypes[type]) {
      seqCounter++;   // keep seq monotonic; gaps in file indicate filtered events
      return;
    }
    try {
      var payload = {
        type:       type,
        session:    sessionId,
        seq:        seqCounter++,
        ts:         new Date().toISOString(),
        targetPath: targetPath
      };
      if (message !== undefined && message !== null) {
        payload.message = message;
      }
      if (extra) {
        if (extra.source !== undefined && extra.source !== null && extra.source !== '') payload.source = extra.source;
        if (extra.line   !== undefined && extra.line   !== null)                        payload.line   = extra.line;
        if (extra.col    !== undefined && extra.col    !== null)                        payload.col    = extra.col;
        if (extra.stack  !== undefined && extra.stack  !== null && extra.stack !== '')  payload.stack  = extra.stack;
      }
      fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify(payload)
      }).catch(function () {});
    } catch (e) {}
  }

  function captureStack() {
    try {
      var raw = new Error().stack || '';
      var lines = raw.split('\n').filter(function (l) {
        return l.trim() !== '' && l.trim() !== 'Error'
            && l.indexOf('console-sniffer.js') === -1;
      });
      return lines.length > 0 ? lines.join('\n') : undefined;
    } catch (e) {
      return undefined;
    }
  }

  var levelMap = {
    log:   'LOG',
    warn:  'WARN',
    error: 'ERROR',
    info:  'INFO',
    debug: 'DEBUG'
  };

  Object.keys(levelMap).forEach(function (method) {
    var original = console[method].bind(console);
    console[method] = function () {
      original.apply(console, arguments);
      var stack = captureStack();
      sendLog(levelMap[method], formatArgs(arguments), stack ? { stack: stack } : undefined);
    };
  });

  var previousOnError = window.onerror;
  window.onerror = function (message, source, lineno, colno, error) {
    sendLog('WINDOW_ERROR', String(message), {
      source: source  || undefined,
      line:   lineno  || undefined,
      col:    colno   || undefined,
      stack:  (error && error.stack) ? error.stack : undefined
    });
    if (typeof previousOnError === 'function') {
      return previousOnError.apply(this, arguments);
    }
    return false;
  };

  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    var msg;
    var stack;
    if (reason instanceof Error) {
      msg   = reason.message;
      stack = reason.stack || undefined;
    } else {
      try { msg = JSON.stringify(reason); } catch (e) { msg = String(reason); }
      stack = undefined;
    }
    sendLog('UNHANDLED_REJECTION', msg, { stack: stack });
  });

})();
