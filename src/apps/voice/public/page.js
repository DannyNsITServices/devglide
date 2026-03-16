// ── Voice App — Page Module ──────────────────────────────────────────
// ES module: mount(container, ctx), unmount(container), onProjectChange(project)

let _container = null;
let _statsTimer = null;
let _visibilityHandler = null;
let _escapeHandler = null;

let allProviders = [];
let currentProviderId = 'openai';
let audioFile = null;

// ── HTML ─────────────────────────────────────────────────────────────

const BODY_HTML = `
  <div class="voice-toast-container" id="voice-toast-container"></div>

  <!-- No Microphone Modal -->
  <div id="mic-modal" class="modal-overlay hidden" role="dialog" aria-modal="true" aria-labelledby="mic-modal-title">
    <div class="modal">
      <div class="modal-icon">
        <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="1" y1="1" x2="23" y2="23"/>
          <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/>
          <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/>
          <line x1="12" y1="19" x2="12" y2="23"/>
          <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
      </div>
      <h2 id="mic-modal-title">No Microphone Detected</h2>
      <p class="modal-message" id="mic-modal-detail">No microphone device was found or access was denied.</p>
      <p class="modal-hint">You can still transcribe audio using the file upload below.</p>
      <button type="button" id="mic-modal-close" class="btn btn-secondary">Dismiss</button>
    </div>
  </div>

  <header>
    <span class="app-name">Voice</span>
    <span id="status-badge" class="badge badge--unknown" role="status">checking...</span>
  </header>

  <div class="voice-container">
    <!-- Configuration -->
    <section class="card">
      <div class="card-header">
        <h2>Configuration</h2>
      </div>
      <form id="config-form" autocomplete="off">
        <div class="form-row">
          <div class="form-group">
            <label for="voice-provider-select">Provider</label>
            <select id="voice-provider-select"></select>
          </div>
          <div class="form-group">
            <label for="voice-language-select">Language</label>
            <select id="voice-language-select">
              <option value="auto">auto-detect</option>
              <option value="en">English</option>
              <option value="de">German</option>
              <option value="fr">French</option>
              <option value="es">Spanish</option>
              <option value="it">Italian</option>
              <option value="pt">Portuguese</option>
              <option value="nl">Dutch</option>
              <option value="ja">Japanese</option>
              <option value="ko">Korean</option>
              <option value="zh">Chinese</option>
              <option value="ru">Russian</option>
              <option value="ar">Arabic</option>
              <option value="hi">Hindi</option>
              <option value="pl">Polish</option>
              <option value="uk">Ukrainian</option>
            </select>
          </div>
        </div>

        <div class="form-group">
          <label for="voice-model-input">Model</label>
          <input type="text" id="voice-model-input" placeholder="e.g. whisper-1" spellcheck="false">
        </div>

        <div id="api-key-group" class="form-group hidden">
          <label for="voice-api-key-input">
            API Key
            <span id="api-key-current" class="field-hint"></span>
          </label>
          <div class="input-with-action">
            <input type="password" id="voice-api-key-input"
              placeholder="Paste new key, or leave blank to keep current"
              autocomplete="new-password" spellcheck="false"
              aria-describedby="api-key-current">
            <button type="button" id="toggle-key-btn" class="btn-icon" title="Toggle visibility" aria-label="Toggle API key visibility">
              <svg id="eye-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
              <svg id="eye-off-icon" class="hidden" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                <line x1="1" y1="1" x2="23" y2="23"/>
              </svg>
            </button>
          </div>
        </div>

        <div id="base-url-group" class="form-group hidden">
          <label for="voice-base-url-input">Base URL</label>
          <input type="url" id="voice-base-url-input" placeholder="http://localhost:8080" spellcheck="false">
        </div>

        <div class="form-actions">
          <button type="button" id="test-btn" class="btn btn-secondary">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
            Test Connection
          </button>
          <span id="test-result" class="test-result"></span>
          <button type="submit" id="save-btn" class="btn btn-primary">Save</button>
        </div>
      </form>
    </section>

    <!-- Statistics -->
    <section class="card">
      <div class="card-header">
        <h2>Statistics</h2>
        <button id="reset-stats-btn" class="btn btn-secondary">Reset</button>
      </div>
      <div class="stats-grid">
        <div class="stat-card">
          <span class="stat-value" id="total-transcriptions">0</span>
          <span class="stat-label">Transcriptions</span>
        </div>
        <div class="stat-card">
          <span class="stat-value" id="total-duration">0s</span>
          <span class="stat-label">Audio Processed</span>
        </div>
        <div class="stat-card">
          <span class="stat-value" id="total-errors">0</span>
          <span class="stat-label">Errors</span>
        </div>
        <div class="stat-card">
          <span class="stat-value" id="last-transcription">never</span>
          <span class="stat-label">Last Transcription</span>
        </div>
      </div>
    </section>

    <!-- Test Transcription -->
    <section class="card">
      <h2>Test Transcription</h2>
      <div class="upload-area" id="upload-area" aria-label="Audio file upload drop zone">
        <input type="file" id="audio-file" accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac,.webm" class="hidden">
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="upload-icon">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        <p class="upload-hint">
          Drop an audio file here, or
          <button type="button" id="choose-file-btn" class="btn-link">browse</button>
        </p>
        <p id="chosen-file-name" class="file-name hidden"></p>
      </div>
      <div class="transcribe-row">
        <button id="transcribe-btn" class="btn btn-primary" disabled>Transcribe</button>
        <span id="transcribe-status" class="field-hint"></span>
      </div>
      <div id="transcription-result" class="result-box hidden">
        <div id="result-meta" class="result-meta"></div>
        <p id="result-text"></p>
      </div>
    </section>

    <!-- MCP Tools -->
    <section class="card">
      <h2>MCP Tools</h2>
      <div class="tools-list">
        <div class="tool">
          <code>voice_transcribe</code>
          <span id="tool-transcribe-desc">Transcribe base64 audio via configured provider</span>
        </div>
        <div class="tool">
          <code>voice_status</code>
          <span>Check service status and statistics</span>
        </div>
      </div>
    </section>
  </div>
`;

// ── Helpers ──────────────────────────────────────────────────────────

function $(sel) { return _container?.querySelector(sel); }

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

const AUDIO_EXTENSIONS = ['.wav', '.mp3', '.m4a', '.ogg', '.flac', '.webm', '.aac', '.wma', '.opus'];
function isAudioFile(file) {
  if (file.type && file.type.startsWith('audio/')) return true;
  return AUDIO_EXTENSIONS.some(ext => file.name.toLowerCase().endsWith(ext));
}

function setLoading(btn, loading) {
  btn.disabled = loading;
  btn.dataset.originalText = btn.dataset.originalText ?? btn.textContent.trim();
  btn.textContent = loading ? '...' : btn.dataset.originalText;
}

function showToast(message, type = 'info') {
  const container = $('#voice-toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  toast.getBoundingClientRect();
  toast.classList.add('toast--visible');
  setTimeout(() => {
    toast.classList.remove('toast--visible');
    const fallback = setTimeout(() => toast.remove(), 500);
    toast.addEventListener('transitionend', () => { clearTimeout(fallback); toast.remove(); }, { once: true });
  }, 3200);
}

// ── Status badge ────────────────────────────────────────────────────

function updateStatusBadge(configured) {
  const badge = $('#status-badge');
  if (!badge) return;
  if (configured === null) {
    badge.textContent = 'offline';
    badge.className = 'badge badge--error';
  } else if (configured) {
    badge.textContent = 'connected';
    badge.className = 'badge badge--ok';
  } else {
    badge.textContent = 'not configured';
    badge.className = 'badge badge--error';
  }
}

// ── Provider form ───────────────────────────────────────────────────

function getSelectedProvider() {
  return allProviders.find(p => p.id === currentProviderId) ?? null;
}

function populateProviderDropdown() {
  const select = $('#voice-provider-select');
  if (!select) return;
  select.innerHTML = allProviders.map(p => `<option value="${p.id}">${p.displayName}</option>`).join('');
  select.value = currentProviderId;
}

function updateFormForProvider(provider) {
  const apiKeyGroup = $('#api-key-group');
  const baseUrlGroup = $('#base-url-group');
  const modelInput = $('#voice-model-input');
  const apiKeyInput = $('#voice-api-key-input');
  const baseUrlInput = $('#voice-base-url-input');
  const apiKeyHint = $('#api-key-current');

  if (!modelInput) return;

  modelInput.value = provider.currentModel ?? provider.defaultModel;
  modelInput.placeholder = provider.defaultModel;

  if (provider.requiresApiKey) {
    apiKeyGroup.classList.remove('hidden');
    baseUrlGroup.classList.add('hidden');
    apiKeyInput.value = '';
    apiKeyInput.placeholder = provider.currentApiKeyMasked
      ? 'Leave blank to keep current key'
      : 'Paste API key';
    apiKeyHint.textContent = provider.currentApiKeyMasked
      ? `Current: ${provider.currentApiKeyMasked}`
      : '';
  } else {
    apiKeyGroup.classList.add('hidden');
    baseUrlGroup.classList.remove('hidden');
    baseUrlInput.value = provider.currentBaseURL ?? provider.defaultBaseURL ?? '';
    baseUrlInput.placeholder = provider.defaultBaseURL ?? 'http://localhost:8080';
  }
}

// ── API calls ───────────────────────────────────────────────────────

async function loadProviders() {
  try {
    const res = await fetch('/api/voice/config/providers');
    const data = await res.json();

    allProviders = data.providers;
    currentProviderId = data.current;

    populateProviderDropdown();

    const langSelect = $('#voice-language-select');
    if (langSelect) langSelect.value = data.language;

    const provider = getSelectedProvider();
    if (provider) updateFormForProvider(provider);

    const toolDesc = $('#tool-transcribe-desc');
    if (toolDesc && provider) {
      toolDesc.textContent = `Transcribe base64 audio via ${provider.displayName}`;
    }
  } catch {
    updateStatusBadge(null);
  }
}

async function fetchStatus() {
  try {
    const res = await fetch('/api/voice/config');
    const cfg = await res.json();
    updateStatusBadge(cfg.configured);
  } catch {
    updateStatusBadge(null);
  }
}

async function fetchStats() {
  if (!_container) return;
  try {
    const res = await fetch('/api/voice/config/stats');
    const stats = await res.json();
    const el = (id) => _container.querySelector('#' + id);
    const totalEl = el('total-transcriptions');
    if (totalEl) totalEl.textContent = stats.totalTranscriptions;
    const durEl = el('total-duration');
    if (durEl) durEl.textContent = stats.totalDurationSec + 's';
    const errEl = el('total-errors');
    if (errEl) errEl.textContent = stats.totalErrors;
    const lastEl = el('last-transcription');
    if (lastEl) lastEl.textContent = stats.lastTranscriptionAt
      ? new Date(stats.lastTranscriptionAt).toLocaleTimeString()
      : 'never';
  } catch {
    // ignore
  }
}

// ── Microphone check ────────────────────────────────────────────────

async function checkMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showMicModal('Your browser does not support microphone access.');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
  } catch (err) {
    let message;
    if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      message = 'No microphone device was found. Connect a microphone and reload the page.';
    } else if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      message = 'Microphone access was denied. Allow access in your browser settings and reload.';
    } else if (err.name === 'NotReadableError') {
      message = 'Microphone is in use by another application.';
    } else {
      message = err.message || 'Microphone is unavailable.';
    }
    showMicModal(message);
  }
}

function showMicModal(message) {
  const detail = $('#mic-modal-detail');
  const modal = $('#mic-modal');
  if (detail) detail.textContent = message;
  if (modal) modal.classList.remove('hidden');
}

// ── Audio file handling ─────────────────────────────────────────────

function setAudioFile(file) {
  audioFile = file;
  const nameEl = $('#chosen-file-name');
  if (nameEl) {
    nameEl.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
    nameEl.classList.remove('hidden');
  }
  const transcribeBtn = $('#transcribe-btn');
  if (transcribeBtn) transcribeBtn.disabled = false;
  const resultBox = $('#transcription-result');
  if (resultBox) resultBox.classList.add('hidden');
  const statusEl = $('#transcribe-status');
  if (statusEl) statusEl.textContent = '';
}

// ── Event wiring ────────────────────────────────────────────────────

function wireEvents() {
  if (!_container) return;

  // Config form submit
  const configForm = $('#config-form');
  if (configForm) {
    configForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('#save-btn');
      setLoading(btn, true);

      const provider = getSelectedProvider();
      const body = {
        provider: currentProviderId,
        language: $('#voice-language-select')?.value,
        model: $('#voice-model-input')?.value.trim() || undefined,
      };

      if (provider?.requiresApiKey) {
        const key = $('#voice-api-key-input')?.value.trim();
        if (key) body.apiKey = key;
      } else {
        const url = $('#voice-base-url-input')?.value.trim();
        if (url) body.baseURL = url;
      }

      try {
        const res = await fetch('/api/voice/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (data.ok) {
          showToast('Configuration saved', 'ok');
          const apiKeyInput = $('#voice-api-key-input');
          if (apiKeyInput) apiKeyInput.value = '';
          await loadProviders();
          await fetchStatus();
        } else {
          showToast(data.error ?? 'Save failed', 'error');
        }
      } catch {
        showToast('Network error', 'error');
      } finally {
        setLoading(btn, false);
      }
    });
  }

  // Provider change
  const providerSelect = $('#voice-provider-select');
  if (providerSelect) {
    providerSelect.addEventListener('change', (e) => {
      currentProviderId = e.target.value;
      const provider = getSelectedProvider();
      if (provider) updateFormForProvider(provider);
      const testResult = $('#test-result');
      if (testResult) testResult.textContent = '';
    });
  }

  // Toggle API key visibility
  const toggleKeyBtn = $('#toggle-key-btn');
  if (toggleKeyBtn) {
    toggleKeyBtn.addEventListener('click', () => {
      const input = $('#voice-api-key-input');
      const eye = $('#eye-icon');
      const eyeOff = $('#eye-off-icon');
      if (!input) return;
      const isPassword = input.type === 'password';
      input.type = isPassword ? 'text' : 'password';
      if (eye) eye.classList.toggle('hidden', isPassword);
      if (eyeOff) eyeOff.classList.toggle('hidden', !isPassword);
    });
  }

  // Test connection
  const testBtn = $('#test-btn');
  if (testBtn) {
    testBtn.addEventListener('click', async () => {
      const resultEl = $('#test-result');
      setLoading(testBtn, true);
      if (resultEl) { resultEl.textContent = ''; resultEl.className = 'test-result'; }

      const provider = getSelectedProvider();
      const testBody = {
        provider: currentProviderId,
        model: $('#voice-model-input')?.value.trim() || undefined,
      };
      if (provider?.requiresApiKey) {
        const key = $('#voice-api-key-input')?.value.trim();
        if (key) testBody.apiKey = key;
      } else {
        const url = $('#voice-base-url-input')?.value.trim();
        if (url) testBody.baseURL = url;
      }

      try {
        const res = await fetch('/api/voice/config/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(testBody),
        });
        const data = await res.json();
        if (data.ok) {
          if (resultEl) { resultEl.textContent = `\u2713 ${data.displayName} is reachable`; resultEl.classList.add('test-result--ok'); }
        } else {
          if (resultEl) { resultEl.textContent = `\u2717 ${data.reason}`; resultEl.classList.add('test-result--error'); }
        }
      } catch {
        if (resultEl) { resultEl.textContent = '\u2717 Network error'; resultEl.classList.add('test-result--error'); }
      } finally {
        setLoading(testBtn, false);
      }
    });
  }

  // Reset stats
  const resetStatsBtn = $('#reset-stats-btn');
  if (resetStatsBtn) {
    resetStatsBtn.addEventListener('click', async () => {
      setLoading(resetStatsBtn, true);
      try {
        await fetch('/api/voice/config/stats', { method: 'DELETE' });
        await fetchStats();
        showToast('Statistics reset', 'ok');
      } catch {
        showToast('Reset failed', 'error');
      } finally {
        setLoading(resetStatsBtn, false);
      }
    });
  }

  // File upload: browse button
  const chooseFileBtn = $('#choose-file-btn');
  const audioFileInput = $('#audio-file');
  if (chooseFileBtn && audioFileInput) {
    chooseFileBtn.addEventListener('click', () => audioFileInput.click());
  }

  // File upload: input change
  if (audioFileInput) {
    audioFileInput.addEventListener('change', () => {
      const file = audioFileInput.files?.[0];
      if (file) setAudioFile(file);
    });
  }

  // File upload: drag and drop
  const uploadArea = $('#upload-area');
  if (uploadArea) {
    uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadArea.classList.add('upload-area--drag');
    });
    uploadArea.addEventListener('dragleave', () => {
      uploadArea.classList.remove('upload-area--drag');
    });
    uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadArea.classList.remove('upload-area--drag');
      const file = e.dataTransfer?.files?.[0];
      if (file) {
        if (!isAudioFile(file)) {
          showToast('Invalid file type. Please drop an audio file.', 'error');
          return;
        }
        setAudioFile(file);
      }
    });
  }

  // Transcribe button
  const transcribeBtn = $('#transcribe-btn');
  if (transcribeBtn) {
    transcribeBtn.addEventListener('click', async () => {
      if (!audioFile) return;
      const statusEl = $('#transcribe-status');
      const resultBox = $('#transcription-result');
      setLoading(transcribeBtn, true);
      if (statusEl) statusEl.textContent = 'Transcribing...';
      if (resultBox) resultBox.classList.add('hidden');

      try {
        const buffer = await audioFile.arrayBuffer();
        const base64 = arrayBufferToBase64(buffer);

        const res = await fetch('/api/voice/config/test-transcription', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audioBase64: base64, filename: audioFile.name }),
        });
        const data = await res.json();

        if (data.ok) {
          const resultText = $('#result-text');
          if (resultText) resultText.textContent = data.text;
          const meta = [];
          if (data.language) meta.push(`language: ${data.language}`);
          if (data.duration != null) meta.push(`duration: ${data.duration.toFixed(1)}s`);
          const resultMeta = $('#result-meta');
          if (resultMeta) resultMeta.textContent = meta.join(' \u00b7 ');
          if (resultBox) resultBox.classList.remove('hidden');
          if (statusEl) statusEl.textContent = '';
          await fetchStats();
        } else {
          if (statusEl) {
            statusEl.textContent = `Error: ${data.error}`;
            statusEl.style.color = 'var(--df-color-state-error)';
          }
        }
      } catch {
        if (statusEl) statusEl.textContent = 'Network error';
      } finally {
        setLoading(transcribeBtn, false);
      }
    });
  }

  // Mic modal dismiss
  const micModalClose = $('#mic-modal-close');
  if (micModalClose) {
    micModalClose.addEventListener('click', () => {
      const modal = $('#mic-modal');
      if (modal) modal.classList.add('hidden');
    });
  }

  // Escape key to close mic modal
  _escapeHandler = (e) => {
    if (e.key === 'Escape') {
      const modal = $('#mic-modal');
      if (modal && !modal.classList.contains('hidden')) {
        modal.classList.add('hidden');
      }
    }
  };
  document.addEventListener('keydown', _escapeHandler);
}

// ── Stats polling ───────────────────────────────────────────────────

function startStatsPoll() {
  if (_statsTimer) return;
  fetchStats();
  _statsTimer = setInterval(fetchStats, 5000);
}

function stopStatsPoll() {
  if (_statsTimer) { clearInterval(_statsTimer); _statsTimer = null; }
}

// ── Lifecycle ───────────────────────────────────────────────────────

export function mount(container, ctx) {
  _container = container;

  // Reset module state
  allProviders = [];
  currentProviderId = 'openai';
  audioFile = null;

  // 1. Scope the container
  container.classList.add('page-voice');

  // 2. Build HTML
  container.innerHTML = BODY_HTML;

  // 3. Wire events
  wireEvents();

  // 4. Visibility change handler for stats polling
  _visibilityHandler = () => {
    if (document.hidden) stopStatsPoll();
    else startStatsPoll();
  };
  document.addEventListener('visibilitychange', _visibilityHandler);

  // 5. Initial data load
  loadProviders();
  fetchStatus();
  startStatsPoll();
  checkMicrophone();
}

export function unmount(container) {
  // 1. Stop stats polling
  stopStatsPoll();

  // 2. Remove visibility handler
  if (_visibilityHandler) {
    document.removeEventListener('visibilitychange', _visibilityHandler);
    _visibilityHandler = null;
  }

  // 3. Remove escape handler
  if (_escapeHandler) {
    document.removeEventListener('keydown', _escapeHandler);
    _escapeHandler = null;
  }

  // 4. Remove scope class & clear HTML
  if (container) {
    container.classList.remove('page-voice');
    container.innerHTML = '';
  }

  // 5. Clear module references
  _container = null;
  audioFile = null;
}

export function onProjectChange(project) {
  // Voice config is global (not per-project), so no action needed.
  // Kept for interface compliance.
}
