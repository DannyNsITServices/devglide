/*!
 * VoiceWidget — hold-to-record voice input widget
 * No external dependencies. Plain JS + Web APIs.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.VoiceWidget = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────────
  // CSS — KITT SCANNER (Knight Rider-inspired, Material Design sensibility)
  //        Matte black panel · red Larson scanner strip · subtle elevation
  //        scanner freezes on malfunction · clean system-ui typography
  // ─────────────────────────────────────────────────────────────────────────────
  var CSS = [
    // ── Wrapper — NERV aesthetic ──
    '.vw-wrap{',
      'position:relative;display:inline-flex;z-index:0;',
      'filter:drop-shadow(0 2px 4px rgba(0,0,0,.7)) drop-shadow(0 1px 2px rgba(0,0,0,.5));',
      'transition:filter .25s ease;',
    '}',
    '.vw-wrap:hover{',
      'filter:var(--df-glow-accent,drop-shadow(0 0 8px rgba(255,140,0,.35))) drop-shadow(0 2px 4px rgba(0,0,0,.6));',
    '}',
    // Corner brackets — NERV card pattern
    '.vw-wrap::before,.vw-wrap::after{',
      "content:'';position:absolute;width:8px;height:8px;",
      'border-color:var(--df-color-accent-default,#ff8c00);border-style:solid;pointer-events:none;opacity:.4;z-index:1;',
    '}',
    '.vw-wrap::before{top:0;left:0;border-width:2px 0 0 2px;}',
    '.vw-wrap::after{bottom:0;right:0;border-width:0 2px 2px 0;}',
    '.vw-wrap[data-state="recording"]{animation:vw-wrap-pulse 1.2s ease-in-out infinite alternate}',
    '@keyframes vw-wrap-pulse{',
      '0%{filter:drop-shadow(0 4px 10px rgba(255,21,0,.4)) drop-shadow(0 2px 4px rgba(0,0,0,.7))}',
      '100%{filter:drop-shadow(0 4px 18px rgba(255,21,0,.7)) drop-shadow(0 2px 6px rgba(0,0,0,.8))}',
    '}',
    '.vw-wrap[data-state="error"]{',
      'filter:var(--df-glow-error,drop-shadow(0 4px 14px rgba(255,30,0,.6))) drop-shadow(0 2px 4px rgba(0,0,0,.7));',
    '}',

    // ── Button — NERV angular panel, fixed dimensions ──
    '.vw-btn{',
      'position:relative;display:inline-flex;align-items:center;justify-content:center;gap:8px;',
      'width:120px;height:36px;box-sizing:border-box;',
      'padding:0 14px 4px;', // 4px bottom for scanner strip
      'background:var(--df-color-bg-surface,#0f0c00);',
      'border:1px solid var(--df-color-border-default,#2a2000);',
      'border-radius:0;',
      'clip-path:var(--df-clip-sm,polygon(0 0,calc(100% - 8px) 0,100% 8px,100% 100%,8px 100%,0 calc(100% - 8px)));',
      'color:var(--df-color-text-primary,#e8dcc8);cursor:pointer;',
      'font-size:11px;font-weight:400;',
      "font-family:var(--df-font-mono,'Courier New',Courier,monospace);",
      'letter-spacing:var(--df-letter-spacing-wide,0.12em);text-transform:uppercase;white-space:nowrap;',
      'user-select:none;-webkit-user-select:none;touch-action:none;',
      'outline:none;overflow:hidden;',
      'transition:background .25s ease,color .25s ease,border-color .25s ease;',
    '}',

    // ── Hover / active ──
    '.vw-btn:hover{background:var(--df-color-bg-raised,#1a1400);color:var(--df-color-accent-default,#ff8c00);border-color:var(--df-color-accent-default,#ff8c00)}',
    '.vw-btn:active{background:var(--df-color-bg-surface,#0f0c00)}',
    '.vw-btn:hover .vw-icon{transform:scale(1.08)}',

    // ── NERV scanner strip — orange in idle, red in recording ──
    '.vw-bars{',
      'position:absolute;bottom:0;left:0;right:0;height:4px;',
      'background:var(--df-color-bg-raised,#1a1400);overflow:hidden;',
    '}',
    '.vw-bar{display:none}',

    // ── Scanner beam — accent Larson sweep (idle, theme-aware) ──
    '.vw-bars::before{',
      "content:'';position:absolute;",
      'top:0;left:-20%;width:35%;height:100%;',
      'background:radial-gradient(ellipse at center,color-mix(in srgb,var(--df-color-accent-default,#ff8c00) 70%,transparent) 0%,color-mix(in srgb,var(--df-color-accent-default,#ff8c00) 30%,transparent) 50%,transparent 100%);',
      'animation:vw-kitt 2.8s ease-in-out infinite alternate;',
    '}',
    '@keyframes vw-kitt{0%{left:-20%}100%{left:85%}}',

    // ── Recording — fast red scanner, state-recording color ──
    '.vw-btn[data-state="recording"]{background:var(--df-color-bg-surface,#0f0c00);color:var(--df-color-state-recording,#ff1500);border-color:var(--df-color-state-recording,#ff1500)}',
    '.vw-btn[data-state="recording"] .vw-bars::before{',
      'animation-duration:.65s;',
      'background:radial-gradient(ellipse at center,#ff1500 0%,rgba(255,21,0,.6) 40%,transparent 100%);',
      'filter:blur(.4px);',
    '}',
    '.vw-btn[data-state="recording"] .vw-icon{display:none}',
    '.vw-btn[data-state="recording"] .vw-label{display:none}',

    // ── KITT voice modulator — segmented LED bars ──
    '.vw-modulator{display:none;align-items:flex-end;gap:3px;height:18px;position:relative;z-index:2}',
    '.vw-btn[data-state="recording"] .vw-modulator{display:inline-flex}',
    '.vw-modulator span{',
      'width:5px;border-radius:0;',
      'background:repeating-linear-gradient(to top,#ff4400 0,#ff4400 3px,#1a0500 3px,#1a0500 5px);',
      'box-shadow:0 0 4px rgba(255,80,0,.8),0 0 10px rgba(255,40,0,.4);',
      'animation:vw-mod .55s ease-in-out infinite alternate;',
    '}',
    '.vw-modulator span:nth-child(1){animation-delay:0s;min-height:4px}',
    '.vw-modulator span:nth-child(2){animation-delay:.07s;min-height:6px}',
    '.vw-modulator span:nth-child(3){animation-delay:.14s;min-height:3px}',
    '.vw-modulator span:nth-child(4){animation-delay:.21s;min-height:8px}',
    '.vw-modulator span:nth-child(5){animation-delay:.28s;min-height:4px}',
    '.vw-modulator span:nth-child(6){animation-delay:.35s;min-height:6px}',
    '@keyframes vw-mod{from{height:3px}to{height:18px}}',

    // ── Transcribing — processing amber, medium scanner ──
    '.vw-btn[data-state="transcribing"]{background:var(--df-color-bg-surface,#0f0c00);color:var(--df-color-state-processing,#cc8800);cursor:wait;border-color:var(--df-color-state-processing,#cc8800)}',
    '.vw-btn[data-state="transcribing"] .vw-bars{background:var(--df-color-bg-raised,#1a1400)}',
    '.vw-btn[data-state="transcribing"] .vw-bars::before{',
      'animation-duration:1.3s;',
      'background:radial-gradient(ellipse at center,color-mix(in srgb,var(--df-color-state-processing,#cc8800) 85%,transparent) 0%,color-mix(in srgb,var(--df-color-state-processing,#cc8800) 40%,transparent) 40%,transparent 100%);',
    '}',
    '.vw-btn[data-state="transcribing"] .vw-icon{display:none}',
    '.vw-btn[data-state="transcribing"] .vw-label{animation:vw-process 1.6s ease-in-out infinite}',
    '@keyframes vw-process{0%,100%{opacity:1}40%,60%{opacity:.3}}',

    // ── Spinner ──
    '.vw-spinner{',
      'display:none;width:12px;height:12px;flex-shrink:0;',
      'border:2px solid rgba(200,120,0,.2);border-top-color:var(--df-color-state-processing,#cc8800);',
      'border-radius:50%;animation:vw-spin .65s linear infinite;',
    '}',
    '.vw-btn[data-state="transcribing"] .vw-spinner{display:block}',
    '@keyframes vw-spin{to{transform:rotate(360deg)}}',

    // ── Error — scanner frozen, shake, error red ──
    '.vw-btn[data-state="error"]{',
      'background:var(--df-color-bg-surface,#0f0c00);color:var(--df-color-state-error,#ff3333);',
      'border-color:var(--df-color-state-error,#ff3333);',
      'animation:vw-quake .45s ease;',
    '}',
    '@keyframes vw-quake{',
      '0%,100%{transform:translate(0)}',
      '15%{transform:translate(-4px,1px)}',
      '30%{transform:translate(4px,-1px)}',
      '45%{transform:translate(-3px,0)}',
      '60%{transform:translate(3px,1px)}',
      '75%{transform:translate(-2px,-1px)}',
    '}',
    '.vw-btn[data-state="error"] .vw-bars::before{',
      'animation-play-state:paused;',
      'background:radial-gradient(ellipse at center,rgba(255,51,51,.9) 0%,rgba(255,51,51,.4) 40%,transparent 100%);',
    '}',

    // ── Error flash overlay ──
    '.vw-flash{',
      'position:absolute;inset:0;',
      'background:rgba(255,30,0,.25);opacity:0;pointer-events:none;z-index:5;',
    '}',
    '.vw-wrap[data-state="error"] .vw-flash{animation:vw-flashpop .5s ease-out}',
    '@keyframes vw-flashpop{0%{opacity:1}100%{opacity:0}}',

    // ── Icon & label ──
    '.vw-icon{display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:transform .2s ease;position:relative;z-index:2}',
    '.vw-label{font-size:11px;line-height:1;position:relative;z-index:2;letter-spacing:var(--df-letter-spacing-wide,0.12em);text-transform:uppercase}',
  ].join('\n');

  var ICONS = {
    // Standard mic
    idle: '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>',
    // Red filled circle (recording indicator — KITT's active signal dot)
    recording: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="#ff1500"/></svg>',
    transcribing: '',
    // Warning triangle
    error: '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  };

  var LABELS = {
    idle:         'Speak',
    recording:    'Transmitting\u2026',
    transcribing: 'Processing\u2026',
    error:        'Malfunction',
  };

  var _styleInjected = false;
  function injectStyles() {
    if (_styleInjected) return;
    _styleInjected = true;
    var el = document.createElement('style');
    el.textContent = CSS;
    document.head.appendChild(el);
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onloadend = function () {
        if (reader.readyState !== FileReader.DONE) {
          reject(new Error('FileReader did not complete'));
          return;
        }
        var result = reader.result;
        if (typeof result !== 'string') {
          reject(new Error('FileReader produced non-string result'));
          return;
        }
        var base64 = result.split(',')[1];
        if (!base64) {
          reject(new Error('Failed to extract base64 from data URL'));
          return;
        }
        resolve(base64);
      };
      reader.onerror = function () {
        reject(reader.error || new Error('Failed to read audio blob'));
      };
      reader.readAsDataURL(blob);
    });
  }

  function mimeToExt(mimeType) {
    if (!mimeType) return 'webm';
    if (mimeType.includes('ogg')) return 'ogg';
    if (mimeType.includes('mp4')) return 'mp4';
    return 'webm';
  }

  function pickMimeType() {
    var candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  /**
   * Create a VoiceWidget instance.
   *
   * @param {object} opts
   * @param {string}   opts.voiceUrl   - Base URL of the voice app (e.g. 'http://localhost:7004')
   * @param {function} opts.onResult   - Called with transcribed text string
   * @param {function} [opts.onError]  - Called with Error object
   * @param {string}   [opts.language] - BCP-47 language tag (e.g. 'en')
   * @param {string}   [opts.hotkey]   - Single key character to toggle recording (e.g. 'v')
   * @param {string}   [opts.label]    - Idle label override (default: 'Speak')
   */
  function create(opts) {
    if (!opts || !opts.voiceUrl) throw new Error('VoiceWidget: voiceUrl is required');
    if (typeof opts.onResult !== 'function') throw new Error('VoiceWidget: onResult callback is required');

    var voiceUrl = opts.voiceUrl.replace(/\/$/, '');
    var onResult = opts.onResult;
    var onError = opts.onError || function (err) { console.error('[VoiceWidget]', err); };
    var language = opts.language || null;
    var hotkey = opts.hotkey ? opts.hotkey.toLowerCase() : null;
    var idleLabel = opts.label || LABELS.idle;

    var state = 'idle'; // idle | recording | transcribing | error
    var mediaRecorder = null;
    var chunks = [];
    var stream = null;
    var errorTimer = null;
    var pendingStop = false;        // stop requested while getUserMedia pending
    var recordingStartedAt = 0;     // timestamp when recording began
    var chimeTimer = null;          // setTimeout id during chime-before-record delay
    var MIN_RECORDING_MS = 350;     // minimum recording duration to capture audio
    var CHIME_LEAD_MS = 550;        // ms to wait for start chime + echo-cancellation settling before opening mic

    // ── audio feedback ─────────────────────────────────────────────────────────
    var _audioCtx = null;

    function _getAudioCtx() {
      if (!_audioCtx) {
        try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
      }
      if (_audioCtx && _audioCtx.state === 'suspended') { _audioCtx.resume(); }
      return _audioCtx;
    }

    // "Her" OS-inspired chime — warm, layered, ethereal tones.
    // Soft sine layers at consonant intervals with gentle attack and long decay.
    function _playTone(ctx, freq, startTime, duration, vol) {
      var osc = ctx.createOscillator();
      var g   = ctx.createGain();
      osc.connect(g);
      g.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, startTime);
      g.gain.setValueAtTime(0, startTime);
      g.gain.linearRampToValueAtTime(vol, startTime + 0.04);
      g.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
      osc.start(startTime);
      osc.stop(startTime + duration + 0.01);
    }

    // Start chime — single soft rising tone
    function _playStartChime() {
      var ctx = _getAudioCtx();
      if (!ctx) return;
      try {
        var t = ctx.currentTime;
        _playTone(ctx, 523.25, t, 0.40, 0.06);        // C5 fundamental
        _playTone(ctx, 659.25, t + 0.12, 0.35, 0.05); // E5 gentle rise
      } catch (e) {}
    }

    // Stop chime — single soft descending tone
    function _playStopChime() {
      var ctx = _getAudioCtx();
      if (!ctx) return;
      try {
        var t = ctx.currentTime;
        _playTone(ctx, 659.25, t, 0.30, 0.05);        // E5
        _playTone(ctx, 523.25, t + 0.10, 0.35, 0.04); // C5 resolve down
      } catch (e) {}
    }

    // DOM refs
    var wrap = null;
    var btn = null;
    var iconEl = null;
    var labelEl = null;
    var spinnerEl = null;

    // ── state machine ──────────────────────────────────────────────────────────
    function setState(s) {
      state = s;
      if (!btn) return;
      btn.setAttribute('data-state', s);
      wrap.setAttribute('data-state', s);
      iconEl.innerHTML = ICONS[s] || '';
      var lbl = s === 'idle' ? idleLabel : (LABELS[s] || s);
      labelEl.textContent = lbl;
      btn.setAttribute('aria-label', lbl);
    }

    // ── recording ──────────────────────────────────────────────────────────────
    function startRecording() {
      if (state !== 'idle' && state !== 'error') return;

      clearTimeout(errorTimer);
      pendingStop = false;
      _getAudioCtx(); // init within user gesture so AudioContext is unlocked

      // Guard: secure context and mediaDevices availability
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        handleError(new Error(
          window.isSecureContext === false
            ? 'Microphone requires a secure (HTTPS) connection'
            : 'Microphone API not available in this browser'
        ));
        return;
      }

      navigator.mediaDevices.getUserMedia({ audio: true, video: false })
        .then(function (s) {
          stream = s;
          chunks = [];
          var mime = pickMimeType();
          mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});

          mediaRecorder.ondataavailable = function (e) {
            if (e.data && e.data.size > 0) chunks.push(e.data);
          };

          mediaRecorder.onstop = function () {
            stopStream();
            var usedMime = mediaRecorder.mimeType || 'audio/webm';
            var blob = new Blob(chunks, { type: usedMime });
            chunks = [];
            if (blob.size === 0) {
              handleError(new Error('No audio captured'));
              return;
            }
            transcribe(blob, usedMime);
          };

          mediaRecorder.onstart = function () {
            recordingStartedAt = Date.now();

            // If stop was requested during chime delay, honour it
            if (pendingStop) {
              pendingStop = false;
              setTimeout(doStop, MIN_RECORDING_MS);
            }
          };

          // Play the chime BEFORE opening the mic so the beep never enters
          // the recording. This avoids browser echo-cancellation suppressing
          // the first moments of speech that follow the beep.
          _playStartChime();
          setState('recording');
          chimeTimer = setTimeout(function () {
            chimeTimer = null;
            if (pendingStop) {
              // Stop requested during chime — abort without recording
              pendingStop = false;
              stopStream();
              setState('idle');
              return;
            }
            mediaRecorder.start();
          }, CHIME_LEAD_MS);
        })
        .catch(function (err) {
          pendingStop = false;
          var name = err.name || '';
          var msg;
          if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
            msg = 'Microphone access denied. Check: browser permission popup, and Windows Settings > Privacy > Microphone';
          } else if (name === 'AbortError') {
            msg = 'Microphone permission dismissed — click the mic and allow access';
          } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
            msg = 'No microphone detected. Check: device is connected, and Windows Settings > Privacy > Microphone is enabled';
          } else if (name === 'NotReadableError') {
            msg = 'Microphone is in use by another application';
          } else if (name === 'SecurityError') {
            msg = 'Microphone requires a secure (HTTPS) connection or localhost';
          } else if (name === 'TypeError') {
            msg = 'Microphone API not available — requires HTTPS or localhost';
          } else {
            msg = 'Microphone unavailable — check browser permissions and Windows privacy settings';
          }
          handleError(new Error(msg));
        });
    }

    function doStop() {
      if (state !== 'recording') return;
      _playStopChime(); // descending 2-note: done speaking
      setState('transcribing');
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      }
    }

    function stopRecording() {
      // Stop requested before getUserMedia resolved — defer
      if (state === 'idle') {
        pendingStop = true;
        return;
      }
      if (state !== 'recording') return;

      // Stop during chime delay — mic hasn't opened yet, cancel gracefully
      if (chimeTimer) {
        clearTimeout(chimeTimer);
        chimeTimer = null;
        stopStream();
        setState('idle');
        return;
      }

      // Ensure minimum recording time so the blob isn't empty
      var elapsed = Date.now() - recordingStartedAt;
      if (elapsed < MIN_RECORDING_MS) {
        setTimeout(doStop, MIN_RECORDING_MS - elapsed);
        return;
      }
      doStop();
    }

    function stopStream() {
      if (stream) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        stream = null;
      }
    }

    // ── transcription ──────────────────────────────────────────────────────────
    function transcribe(blob, mimeType) {
      // Guard against recordings that exceed the server's 25MB JSON body limit
      // (base64 adds ~33% overhead, so cap the raw blob at 18MB)
      if (blob.size > 18 * 1024 * 1024) {
        handleError(new Error('Recording too large — try a shorter message'));
        return;
      }

      var abortCtrl = new AbortController();
      var fetchTimeout = setTimeout(function () { abortCtrl.abort(); }, 30000);

      blobToBase64(blob)
        .then(function (base64) {
          var ext = mimeToExt(mimeType);
          var payload = {
            audioBase64: base64,
            filename: 'recording.' + ext,
          };
          if (language) payload.language = language;
          var body = JSON.stringify(payload);

          return fetch(voiceUrl + '/api/voice/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body,
            signal: abortCtrl.signal,
          });
        })
        .then(function (res) {
          if (!res.ok) {
            return res.text().then(function (body) {
              try {
                var d = JSON.parse(body);
                throw new Error(d.error || res.status + ' ' + res.statusText);
              } catch (parseErr) {
                if (parseErr instanceof SyntaxError) {
                  throw new Error(res.status + ' ' + (res.statusText || 'error') + (body ? ': ' + body.slice(0, 120) : ''));
                }
                throw parseErr;
              }
            });
          }
          return res.json();
        })
        .then(function (data) {
          clearTimeout(fetchTimeout);
          if (!data.ok) throw new Error(data.error || 'Transcription failed');
          setState('idle');
          onResult(data.text || '');
        })
        .catch(function (err) {
          clearTimeout(fetchTimeout);
          if (err.name === 'AbortError') {
            handleError(new Error('Transcription timed out — server did not respond within 30 seconds'));
          } else {
            handleError(err);
          }
        });
    }

    // ── error handling ─────────────────────────────────────────────────────────
    function handleError(err) {
      if (chimeTimer) { clearTimeout(chimeTimer); chimeTimer = null; }
      stopStream();
      setState('error');
      onError(err);
      errorTimer = setTimeout(function () {
        if (state === 'error') setState('idle');
      }, 3000);
    }

    // ── pointer / touch events ─────────────────────────────────────────────────
    function onPointerDown(e) {
      e.preventDefault();
      startRecording();
    }

    function onPointerUp(e) {
      e.preventDefault();
      stopRecording();
    }

    // ── keyboard shortcut ──────────────────────────────────────────────────────
    var _keydownHandler = null;
    var _keyupHandler = null;

    function setupHotkey() {
      if (!hotkey) return;

      _keydownHandler = function (e) {
        if (e.repeat) return;
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) return;
        if (e.key.toLowerCase() === hotkey) {
          e.preventDefault();
          startRecording();
        }
      };

      _keyupHandler = function (e) {
        if (e.key.toLowerCase() === hotkey) {
          e.preventDefault();
          stopRecording();
        }
      };

      document.addEventListener('keydown', _keydownHandler);
      document.addEventListener('keyup', _keyupHandler);
    }

    function teardownHotkey() {
      if (_keydownHandler) document.removeEventListener('keydown', _keydownHandler);
      if (_keyupHandler) document.removeEventListener('keyup', _keyupHandler);
      _keydownHandler = null;
      _keyupHandler = null;
    }

    // ── public API ─────────────────────────────────────────────────────────────
    return {
      /**
       * Render the mic button into containerEl.
       * @param {HTMLElement} containerEl
       */
      mount: function (containerEl) {
        if (!containerEl) throw new Error('VoiceWidget.mount: containerEl is required');
        injectStyles();

        // ── Wrapper ──
        wrap = document.createElement('div');
        wrap.className = 'vw-wrap';
        wrap.setAttribute('data-state', 'idle');

        // ── Button ──
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'vw-btn';
        btn.setAttribute('aria-label', idleLabel);
        btn.setAttribute('data-state', 'idle');

        spinnerEl = document.createElement('span');
        spinnerEl.className = 'vw-spinner';

        iconEl = document.createElement('span');
        iconEl.className = 'vw-icon';
        iconEl.innerHTML = ICONS.idle;

        // Scanner strip container (Larson scanner bar)
        var barsEl = document.createElement('span');
        barsEl.className = 'vw-bars';
        for (var i = 0; i < 7; i++) {
          var bar = document.createElement('span');
          bar.className = 'vw-bar';
          barsEl.appendChild(bar);
        }

        labelEl = document.createElement('span');
        labelEl.className = 'vw-label';
        labelEl.setAttribute('aria-live', 'polite');
        labelEl.textContent = idleLabel;

        var modulatorEl = document.createElement('span');
        modulatorEl.className = 'vw-modulator';
        for (var m = 0; m < 6; m++) {
          modulatorEl.appendChild(document.createElement('span'));
        }

        btn.appendChild(spinnerEl);
        btn.appendChild(iconEl);
        btn.appendChild(barsEl);
        btn.appendChild(modulatorEl);
        btn.appendChild(labelEl);

        // pointer events
        btn.addEventListener('pointerdown', onPointerDown);
        btn.addEventListener('pointerup', onPointerUp);
        btn.addEventListener('pointercancel', onPointerUp);
        btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });

        wrap.appendChild(btn);

        // ── Error flash overlay ──
        var flash = document.createElement('span');
        flash.className = 'vw-flash';
        flash.setAttribute('aria-live', 'polite');
        flash.setAttribute('role', 'status');
        wrap.appendChild(flash);

        containerEl.appendChild(wrap);

        setupHotkey();
      },

      /** Remove the widget and all event listeners. */
      destroy: function () {
        clearTimeout(errorTimer);
        if (chimeTimer) { clearTimeout(chimeTimer); chimeTimer = null; }
        teardownHotkey();
        stopStream();
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
          mediaRecorder.stop();
        }
        if (btn) {
          btn.removeEventListener('pointerdown', onPointerDown);
          btn.removeEventListener('pointerup', onPointerUp);
          btn.removeEventListener('pointercancel', onPointerUp);
        }
        if (_audioCtx) { _audioCtx.close(); _audioCtx = null; }
        if (wrap && wrap.parentNode) {
          wrap.parentNode.removeChild(wrap);
        }
        wrap = btn = iconEl = labelEl = spinnerEl = null;
      },

      /** Programmatically start recording. */
      startRecording: startRecording,

      /** Programmatically stop recording and trigger transcription. */
      stopRecording: stopRecording,

      /** Current state: 'idle' | 'recording' | 'transcribing' | 'error' */
      get state() { return state; },
    };
  }

  return { create: create };
});
