// ── Voice App — Page Module ──────────────────────────────────────────
// ES module: mount(container, ctx), unmount(container), onProjectChange(project)

let _container = null;
let _statsTimer = null;
let _visibilityHandler = null;
let allProviders = [];
let currentProviderId = 'openai';
let audioFile = null;

// Recording state
let _mediaRecorder = null;
let _recordingChunks = [];
let _recordingTimer = null;
let _recordingStartTime = 0;
const MAX_RECORDING_SECONDS = 300; // 5 min

// ── HTML ─────────────────────────────────────────────────────────────

const BODY_HTML = `
  <div class="voice-toast-container" id="voice-toast-container"></div>

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

        <!-- Model: text input (default) or dropdown (for providers with model list) -->
        <div id="model-text-group" class="form-group">
          <label for="voice-model-input">Model</label>
          <input type="text" id="voice-model-input" placeholder="e.g. whisper-1" spellcheck="false">
        </div>
        <div id="model-select-group" class="form-group hidden">
          <label for="voice-model-select">Model</label>
          <select id="voice-model-select"></select>
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

        <div id="local-info" class="form-hint hidden">
          Runs whisper.cpp locally — no server needed. Requires FFmpeg and compiled whisper.cpp binary.
          To compile: <code>cd node_modules/nodejs-whisper/cpp/whisper.cpp && cmake -B build && cmake --build build --config Release</code>
          <div id="ffmpeg-status" class="ffmpeg-status"></div>
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

    <!-- Vocabulary Biasing -->
    <section class="card">
      <div class="card-header">
        <h2>Vocabulary Biasing</h2>
        <label class="toggle-label">
          <input type="checkbox" id="vocab-biasing-toggle">
          <span class="toggle-text" id="vocab-biasing-status">off</span>
        </label>
      </div>
      <p class="card-desc">Improve accuracy for developer terminology by injecting a vocabulary prompt into Whisper. Built-in terms (AWS, Kubernetes, TypeScript, etc.) are included automatically.</p>
      <div class="form-group">
        <label for="custom-vocab-input">Custom Terms <span class="field-hint">(one per line)</span></label>
        <textarea id="custom-vocab-input" rows="4" placeholder="MyCompanyName&#10;InternalAPIName&#10;ProjectCodename" spellcheck="false"></textarea>
      </div>
      <div class="form-actions">
        <button type="button" id="save-vocab-btn" class="btn btn-primary">Save</button>
      </div>
    </section>

    <!-- AI Text Cleanup -->
    <section class="card">
      <div class="card-header">
        <h2>AI Text Cleanup</h2>
        <label class="toggle-label">
          <input type="checkbox" id="cleanup-toggle">
          <span class="toggle-text" id="cleanup-status">off</span>
        </label>
      </div>
      <p class="card-desc">Transform rambling voice input into polished text via LLM post-processing. Removes filler words, fixes grammar, preserves technical terms.</p>
      <div id="cleanup-config" class="hidden">
        <div class="form-row">
          <div class="form-group">
            <label for="cleanup-provider-input">Provider</label>
            <input type="text" id="cleanup-provider-input" placeholder="openai" spellcheck="false">
          </div>
          <div class="form-group">
            <label for="cleanup-model-input">Model</label>
            <input type="text" id="cleanup-model-input" placeholder="gpt-4o-mini" spellcheck="false">
          </div>
        </div>
        <div class="form-group">
          <label for="cleanup-api-key-input">API Key</label>
          <input type="password" id="cleanup-api-key-input" placeholder="API key for cleanup LLM" autocomplete="new-password" spellcheck="false">
        </div>
        <div class="form-group">
          <label for="cleanup-base-url-input">Base URL <span class="field-hint">(optional)</span></label>
          <input type="url" id="cleanup-base-url-input" placeholder="https://api.openai.com/v1" spellcheck="false">
        </div>
        <div class="form-actions">
          <button type="button" id="save-cleanup-btn" class="btn btn-primary">Save</button>
        </div>
      </div>
    </section>

    <!-- Text-to-Speech -->
    <section class="card">
      <div class="card-header">
        <h2>Text-to-Speech</h2>
        <label class="toggle-label">
          <input type="checkbox" id="tts-toggle">
          <span class="toggle-text" id="tts-status">on</span>
        </label>
      </div>
      <p class="card-desc">JARVIS-style neural voice for Claude to speak results aloud. Uses Microsoft Edge TTS (free, no API key).</p>
      <div id="tts-config">
        <div class="form-row">
          <div class="form-group">
            <label for="tts-voice-input">Voice</label>
            <input type="text" id="tts-voice-input" placeholder="en-GB-RyanNeural" spellcheck="false">
          </div>
          <div class="form-group">
            <label for="tts-volume-input">Volume <span class="field-hint">(0-100)</span></label>
            <input type="number" id="tts-volume-input" min="0" max="100" value="80">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="tts-edge-rate-input">Edge Rate</label>
            <input type="text" id="tts-edge-rate-input" placeholder="+5%" spellcheck="false">
          </div>
          <div class="form-group">
            <label for="tts-edge-pitch-input">Edge Pitch</label>
            <input type="text" id="tts-edge-pitch-input" placeholder="-2Hz" spellcheck="false">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="tts-fallback-rate-input">Fallback WPM <span class="field-hint">(SAPI/say)</span></label>
            <input type="number" id="tts-fallback-rate-input" min="50" max="400" value="200">
          </div>
          <div class="form-group"></div>
        </div>
        <div class="form-actions">
          <button type="button" id="tts-test-btn" class="btn btn-secondary">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
            </svg>
            Test Voice
          </button>
          <button type="button" id="tts-stop-btn" class="btn btn-secondary hidden">Stop</button>
          <span id="tts-test-result" class="field-hint"></span>
          <button type="button" id="save-tts-btn" class="btn btn-primary">Save</button>
        </div>
      </div>
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
      <!-- Analytics mini-dashboard -->
      <div id="analytics-section" class="analytics-section hidden">
        <div class="stats-grid" style="margin-top: var(--df-space-3);">
          <div class="stat-card">
            <span class="stat-value" id="avg-wpm">0</span>
            <span class="stat-label">Avg WPM</span>
          </div>
          <div class="stat-card">
            <span class="stat-value" id="total-words">0</span>
            <span class="stat-label">Total Words</span>
          </div>
        </div>
        <div id="top-fillers" class="filler-list"></div>
      </div>
    </section>

    <!-- Test Transcription -->
    <section class="card">
      <h2>Test Transcription</h2>
      <!-- Mode selector -->
      <div class="mode-selector">
        <label class="mode-option">
          <input type="radio" name="transcribe-mode" value="raw" checked> Raw
        </label>
        <label class="mode-option">
          <input type="radio" name="transcribe-mode" value="cleanup"> AI Cleanup
        </label>
      </div>
      <!-- Mic recording -->
      <div class="record-row">
        <button type="button" id="record-btn" class="btn btn-record" title="Record from microphone">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="23"/>
            <line x1="8" y1="23" x2="16" y2="23"/>
          </svg>
          <span id="record-btn-text">Record</span>
        </button>
        <span id="record-timer" class="record-timer hidden">0:00</span>
        <span id="record-status" class="field-hint"></span>
      </div>
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
        <div id="result-cleaned" class="result-cleaned hidden">
          <div class="result-cleaned-label">AI Cleaned</div>
          <p id="result-cleaned-text"></p>
        </div>
      </div>
    </section>

    <!-- History -->
    <section class="card">
      <div class="card-header">
        <h2>History</h2>
        <button id="clear-history-btn" class="btn btn-secondary">Clear</button>
      </div>
      <div id="history-list" class="history-list">
        <p class="empty-state">No transcriptions yet.</p>
      </div>
      <div id="history-more" class="hidden" style="text-align:center; margin-top: var(--df-space-2);">
        <button id="history-load-more" class="btn btn-secondary">Load more</button>
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
        <div class="tool">
          <code>voice_history</code>
          <span>List transcription history with text analysis</span>
        </div>
        <div class="tool">
          <code>voice_analytics</code>
          <span>Get transcription analytics (WPM, filler words)</span>
        </div>
        <div class="tool">
          <code>voice_speak</code>
          <span>Speak text aloud (JARVIS-style neural TTS)</span>
        </div>
        <div class="tool">
          <code>voice_stop</code>
          <span>Stop current speech playback</span>
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

// 5 min timeout for local provider (model download + compile), 60s for remote
function getTranscriptionTimeout() {
  return currentProviderId === 'local' ? 300_000 : 60_000;
}

function getTranscriptionStatusText() {
  return currentProviderId === 'local'
    ? 'Transcribing (local model may download on first use)...'
    : 'Transcribing...';
}

async function fetchTranscription(body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getTranscriptionTimeout());
  try {
    const res = await fetch('/api/voice/config/test-transcription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
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

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Dependency checks ────────────────────────────────────────────────

async function checkFfmpeg() {
  const el = $('#ffmpeg-status');
  if (!el) return;
  el.textContent = 'Checking FFmpeg...';
  el.className = 'ffmpeg-status';
  try {
    const res = await fetch('/api/voice/config/check-ffmpeg');
    const data = await res.json();
    if (data.ok) {
      el.textContent = `FFmpeg ${data.version} found`;
      el.className = 'ffmpeg-status ffmpeg-status--ok';
    } else {
      el.innerHTML =
        '<b>FFmpeg not found.</b> Required for audio conversion.<br>' +
        'Install: <code>winget install ffmpeg</code> (Windows) · ' +
        '<code>brew install ffmpeg</code> (macOS) · ' +
        '<code>sudo apt install ffmpeg</code> (Linux)';
      el.className = 'ffmpeg-status ffmpeg-status--error';
    }
  } catch {
    el.textContent = 'Could not check FFmpeg status';
    el.className = 'ffmpeg-status';
  }
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
  const modelTextGroup = $('#model-text-group');
  const modelSelectGroup = $('#model-select-group');
  const modelInput = $('#voice-model-input');
  const modelSelect = $('#voice-model-select');
  const apiKeyInput = $('#voice-api-key-input');
  const baseUrlInput = $('#voice-base-url-input');
  const apiKeyHint = $('#api-key-current');
  const localInfo = $('#local-info');
  const testBtn = $('#test-btn');

  if (!modelInput) return;

  // Model: dropdown if provider has models list, text input otherwise
  if (provider.models && provider.models.length > 0) {
    modelTextGroup.classList.add('hidden');
    modelSelectGroup.classList.remove('hidden');
    modelSelect.innerHTML = provider.models.map(m => `<option value="${m}">${m}</option>`).join('');
    modelSelect.value = provider.currentModel ?? provider.defaultModel;
  } else {
    modelTextGroup.classList.remove('hidden');
    modelSelectGroup.classList.add('hidden');
    modelInput.value = provider.currentModel ?? provider.defaultModel;
    modelInput.placeholder = provider.defaultModel;
  }

  // Local provider: no API key, no base URL, show info + check FFmpeg
  const isLocal = provider.id === 'local';
  localInfo.classList.toggle('hidden', !isLocal);
  testBtn.classList.toggle('hidden', isLocal);
  if (isLocal) checkFfmpeg();

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
  } else if (!isLocal) {
    apiKeyGroup.classList.add('hidden');
    baseUrlGroup.classList.remove('hidden');
    baseUrlInput.value = provider.currentBaseURL ?? provider.defaultBaseURL ?? '';
    baseUrlInput.placeholder = provider.defaultBaseURL ?? 'http://localhost:8080';
  } else {
    apiKeyGroup.classList.add('hidden');
    baseUrlGroup.classList.add('hidden');
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

    // Load vocab biasing state
    const vocabToggle = $('#vocab-biasing-toggle');
    const vocabStatus = $('#vocab-biasing-status');
    if (vocabToggle) {
      vocabToggle.checked = data.vocabBiasing ?? false;
      if (vocabStatus) vocabStatus.textContent = vocabToggle.checked ? 'on' : 'off';
    }
    const customVocab = $('#custom-vocab-input');
    if (customVocab && data.customVocabulary) {
      customVocab.value = data.customVocabulary.join('\n');
    }

    // Load TTS state
    const ttsToggle = $('#tts-toggle');
    const ttsStatusEl = $('#tts-status');
    if (ttsToggle && data.tts) {
      ttsToggle.checked = data.tts.enabled ?? true;
      if (ttsStatusEl) ttsStatusEl.textContent = ttsToggle.checked ? 'on' : 'off';
      const vi = $('#tts-voice-input');
      const vol = $('#tts-volume-input');
      const eri = $('#tts-edge-rate-input');
      const epi = $('#tts-edge-pitch-input');
      const fri = $('#tts-fallback-rate-input');
      if (vi) vi.value = data.tts.voice ?? '';
      if (vol) vol.value = data.tts.volume ?? 80;
      if (eri) eri.value = data.tts.edgeRate ?? '';
      if (epi) epi.value = data.tts.edgePitch ?? '';
      if (fri) fri.value = data.tts.fallbackRate ?? 200;
    }

    // Load cleanup state
    const cleanupToggle = $('#cleanup-toggle');
    const cleanupStatus = $('#cleanup-status');
    const cleanupConfig = $('#cleanup-config');
    if (cleanupToggle && data.cleanup) {
      cleanupToggle.checked = data.cleanup.enabled ?? false;
      if (cleanupStatus) cleanupStatus.textContent = cleanupToggle.checked ? 'on' : 'off';
      if (cleanupConfig) cleanupConfig.classList.toggle('hidden', !cleanupToggle.checked);
      const cpInput = $('#cleanup-provider-input');
      const cmInput = $('#cleanup-model-input');
      const cuInput = $('#cleanup-base-url-input');
      if (cpInput) cpInput.value = data.cleanup.provider ?? '';
      if (cmInput) cmInput.value = data.cleanup.model ?? '';
      if (cuInput) cuInput.value = data.cleanup.baseURL ?? '';
    }
  } catch {
    updateStatusBadge(null);
  }
}

async function fetchStatus() {
  try {
    const res = await fetch('/api/voice/config');
    const cfg = await res.json();
    // Local provider is always "configured"
    if (cfg.provider === 'local') {
      updateStatusBadge(true);
    } else {
      updateStatusBadge(cfg.configured);
    }
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

  // Fetch analytics
  try {
    const res = await fetch('/api/voice/history/analytics');
    const analytics = await res.json();
    const section = $('#analytics-section');
    if (analytics.totalTranscriptions > 0 && section) {
      section.classList.remove('hidden');
      const avgWpm = $('#avg-wpm');
      if (avgWpm) avgWpm.textContent = analytics.avgWPM;
      const totalWords = $('#total-words');
      if (totalWords) totalWords.textContent = analytics.totalWords;
      const fillerEl = $('#top-fillers');
      if (fillerEl && analytics.topFillerWords.length > 0) {
        fillerEl.innerHTML = '<span class="filler-title">Top Filler Words</span> ' +
          analytics.topFillerWords.slice(0, 5).map(f =>
            `<span class="filler-tag">${escapeHtml(f.word)} <b>${f.count}</b></span>`
          ).join(' ');
      } else if (fillerEl) {
        fillerEl.innerHTML = '';
      }
    }
  } catch {
    // ignore
  }
}

async function fetchHistory() {
  if (!_container) return;
  try {
    const res = await fetch('/api/voice/history?limit=10');
    const data = await res.json();
    const list = $('#history-list');
    if (!list) return;
    if (data.entries.length === 0) {
      list.innerHTML = '<p class="empty-state">No transcriptions yet.</p>';
      return;
    }
    list.innerHTML = data.entries.map(e => `
      <div class="history-entry" data-id="${e.id}">
        <div class="history-entry-header">
          <span class="history-meta">${escapeHtml(e.provider)} / ${escapeHtml(e.model)} \u00b7 ${timeAgo(e.timestamp)}</span>
          <span class="history-stats">${e.wordCount}w${e.wpm > 0 ? ` \u00b7 ${e.wpm} WPM` : ''}${e.duration ? ` \u00b7 ${e.duration.toFixed(1)}s` : ''}</span>
        </div>
        <p class="history-text">${escapeHtml(e.text.slice(0, 200))}${e.text.length > 200 ? '...' : ''}</p>
        ${e.cleanedText ? `<p class="history-cleaned">${escapeHtml(e.cleanedText.slice(0, 200))}${e.cleanedText.length > 200 ? '...' : ''}</p>` : ''}
        ${e.fillerWords.length > 0 ? `<div class="history-fillers">${e.fillerWords.slice(0, 3).map(f => `<span class="filler-tag filler-tag--sm">${escapeHtml(f.word)} ${f.count}</span>`).join('')}</div>` : ''}
      </div>
    `).join('');

    const moreBtn = $('#history-more');
    if (moreBtn) moreBtn.classList.toggle('hidden', data.total <= 10);
  } catch {
    // ignore
  }
}

// (Mic check removed — permission is requested on first record click.
//  If getUserMedia fails, startRecording() shows an error toast.)

// ── Recording ───────────────────────────────────────────────────────

function startRecording() {
  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    _recordingChunks = [];
    _mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

    _mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) _recordingChunks.push(e.data);
    };

    _mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(_recordingChunks, { type: 'audio/webm' });
      _recordingChunks = [];
      handleRecordedBlob(blob);
    };

    _mediaRecorder.start(250); // collect chunks every 250ms
    _recordingStartTime = Date.now();

    const btn = $('#record-btn');
    const btnText = $('#record-btn-text');
    const timer = $('#record-timer');
    if (btn) btn.classList.add('btn-record--active');
    if (btnText) btnText.textContent = 'Stop';
    if (timer) { timer.classList.remove('hidden'); timer.textContent = '0:00'; }

    _recordingTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - _recordingStartTime) / 1000);
      if (timer) {
        const m = Math.floor(elapsed / 60);
        const s = String(elapsed % 60).padStart(2, '0');
        timer.textContent = `${m}:${s}`;
      }
      if (elapsed >= MAX_RECORDING_SECONDS) stopRecording();
    }, 500);
  }).catch((err) => {
    let msg = 'Could not access microphone';
    if (err?.name === 'NotFoundError' || err?.name === 'DevicesNotFoundError') {
      msg = 'No microphone found — connect a mic and try again';
    } else if (err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError') {
      msg = 'Microphone access denied — allow in browser settings';
    } else if (err?.name === 'NotReadableError') {
      msg = 'Microphone in use by another app';
    } else if (!navigator.mediaDevices?.getUserMedia) {
      msg = 'Browser does not support microphone access (HTTPS required)';
    }
    showToast(msg, 'error');
  });
}

function stopRecording() {
  if (_recordingTimer) { clearInterval(_recordingTimer); _recordingTimer = null; }
  if (_mediaRecorder && _mediaRecorder.state !== 'inactive') {
    _mediaRecorder.stop();
  }
  const btn = $('#record-btn');
  const btnText = $('#record-btn-text');
  if (btn) btn.classList.remove('btn-record--active');
  if (btnText) btnText.textContent = 'Record';
}

async function handleRecordedBlob(blob) {
  const statusEl = $('#record-status');
  if (statusEl) statusEl.textContent = getTranscriptionStatusText();

  try {
    const buffer = await blob.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);
    const mode = _container?.querySelector('input[name="transcribe-mode"]:checked')?.value ?? 'raw';

    const data = await fetchTranscription({ audioBase64: base64, filename: 'recording.webm', mode });

    if (data.ok) {
      showTranscriptionResult(data);
      if (statusEl) statusEl.textContent = '';
      await fetchStats();
      await fetchHistory();
    } else {
      if (statusEl) statusEl.textContent = `Error: ${data.error}`;
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = err?.name === 'AbortError' ? 'Request timed out' : 'Network error';
  }
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

// ── Transcription result display ────────────────────────────────────

function showTranscriptionResult(data) {
  const resultBox = $('#transcription-result');
  const resultText = $('#result-text');
  if (resultText) resultText.textContent = data.text;
  const meta = [];
  if (data.language) meta.push(`language: ${data.language}`);
  if (data.duration != null) meta.push(`duration: ${data.duration.toFixed(1)}s`);
  if (data.historyId) meta.push(`id: ${data.historyId}`);
  const resultMeta = $('#result-meta');
  if (resultMeta) resultMeta.textContent = meta.join(' \u00b7 ');

  // Show cleaned text if available
  const cleanedBox = $('#result-cleaned');
  const cleanedText = $('#result-cleaned-text');
  if (data.cleanedText && cleanedBox && cleanedText) {
    cleanedText.textContent = data.cleanedText;
    cleanedBox.classList.remove('hidden');
  } else if (cleanedBox) {
    cleanedBox.classList.add('hidden');
  }

  if (resultBox) resultBox.classList.remove('hidden');
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
      };

      // Model: from dropdown or text input
      if (provider?.models?.length > 0) {
        body.model = $('#voice-model-select')?.value || undefined;
      } else {
        body.model = $('#voice-model-input')?.value.trim() || undefined;
      }

      if (provider?.requiresApiKey) {
        const key = $('#voice-api-key-input')?.value.trim();
        if (key) body.apiKey = key;
      } else if (provider?.id !== 'local') {
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
        model: provider?.models?.length > 0
          ? ($('#voice-model-select')?.value || undefined)
          : ($('#voice-model-input')?.value.trim() || undefined),
      };
      if (provider?.requiresApiKey) {
        const key = $('#voice-api-key-input')?.value.trim();
        if (key) testBody.apiKey = key;
      } else if (provider?.id !== 'local') {
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
      if (statusEl) { statusEl.textContent = getTranscriptionStatusText(); statusEl.style.color = ''; }
      if (resultBox) resultBox.classList.add('hidden');

      try {
        const buffer = await audioFile.arrayBuffer();
        const base64 = arrayBufferToBase64(buffer);
        const mode = _container?.querySelector('input[name="transcribe-mode"]:checked')?.value ?? 'raw';

        const data = await fetchTranscription({ audioBase64: base64, filename: audioFile.name, mode });

        if (data.ok) {
          showTranscriptionResult(data);
          if (statusEl) statusEl.textContent = '';
          await fetchStats();
          await fetchHistory();
        } else {
          if (statusEl) {
            statusEl.textContent = `Error: ${data.error}`;
            statusEl.style.color = 'var(--df-color-state-error)';
          }
        }
      } catch (err) {
        if (statusEl) statusEl.textContent = err?.name === 'AbortError' ? 'Request timed out' : 'Network error';
      } finally {
        setLoading(transcribeBtn, false);
      }
    });
  }

  // Record button
  const recordBtn = $('#record-btn');
  if (recordBtn) {
    recordBtn.addEventListener('click', () => {
      if (_mediaRecorder && _mediaRecorder.state === 'recording') {
        stopRecording();
      } else {
        startRecording();
      }
    });
  }

  // Vocab biasing toggle
  const vocabToggle = $('#vocab-biasing-toggle');
  if (vocabToggle) {
    vocabToggle.addEventListener('change', () => {
      const status = $('#vocab-biasing-status');
      if (status) status.textContent = vocabToggle.checked ? 'on' : 'off';
    });
  }

  // Save vocab
  const saveVocabBtn = $('#save-vocab-btn');
  if (saveVocabBtn) {
    saveVocabBtn.addEventListener('click', async () => {
      setLoading(saveVocabBtn, true);
      const vocabToggle = $('#vocab-biasing-toggle');
      const customVocab = $('#custom-vocab-input');
      const terms = (customVocab?.value ?? '').split('\n').map(t => t.trim()).filter(Boolean);
      try {
        const res = await fetch('/api/voice/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vocabBiasing: vocabToggle?.checked ?? false,
            customVocabulary: terms,
          }),
        });
        const data = await res.json();
        if (data.ok) showToast('Vocabulary saved', 'ok');
        else showToast(data.error ?? 'Save failed', 'error');
      } catch {
        showToast('Network error', 'error');
      } finally {
        setLoading(saveVocabBtn, false);
      }
    });
  }

  // Cleanup toggle
  const cleanupToggle = $('#cleanup-toggle');
  if (cleanupToggle) {
    cleanupToggle.addEventListener('change', () => {
      const status = $('#cleanup-status');
      const config = $('#cleanup-config');
      if (status) status.textContent = cleanupToggle.checked ? 'on' : 'off';
      if (config) config.classList.toggle('hidden', !cleanupToggle.checked);
    });
  }

  // Save cleanup
  const saveCleanupBtn = $('#save-cleanup-btn');
  if (saveCleanupBtn) {
    saveCleanupBtn.addEventListener('click', async () => {
      setLoading(saveCleanupBtn, true);
      const cleanupToggle = $('#cleanup-toggle');
      try {
        const res = await fetch('/api/voice/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cleanup: {
              enabled: cleanupToggle?.checked ?? false,
              provider: $('#cleanup-provider-input')?.value.trim() || undefined,
              model: $('#cleanup-model-input')?.value.trim() || undefined,
              apiKey: $('#cleanup-api-key-input')?.value.trim() || undefined,
              baseURL: $('#cleanup-base-url-input')?.value.trim() || undefined,
            },
          }),
        });
        const data = await res.json();
        if (data.ok) showToast('Cleanup config saved', 'ok');
        else showToast(data.error ?? 'Save failed', 'error');
      } catch {
        showToast('Network error', 'error');
      } finally {
        setLoading(saveCleanupBtn, false);
      }
    });
  }

  // TTS toggle
  const ttsToggle = $('#tts-toggle');
  if (ttsToggle) {
    ttsToggle.addEventListener('change', () => {
      const status = $('#tts-status');
      if (status) status.textContent = ttsToggle.checked ? 'on' : 'off';
    });
  }

  // Save TTS config
  const saveTtsBtn = $('#save-tts-btn');
  if (saveTtsBtn) {
    saveTtsBtn.addEventListener('click', async () => {
      setLoading(saveTtsBtn, true);
      const ttsToggle = $('#tts-toggle');
      try {
        const res = await fetch('/api/voice/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tts: {
              enabled: ttsToggle?.checked ?? true,
              voice: $('#tts-voice-input')?.value.trim() || undefined,
              edgeRate: $('#tts-edge-rate-input')?.value.trim() || undefined,
              edgePitch: $('#tts-edge-pitch-input')?.value.trim() || undefined,
              fallbackRate: parseInt($('#tts-fallback-rate-input')?.value) || 200,
              volume: parseInt($('#tts-volume-input')?.value) || 80,
            },
          }),
        });
        const data = await res.json();
        if (data.ok) showToast('TTS config saved', 'ok');
        else showToast(data.error ?? 'Save failed', 'error');
      } catch {
        showToast('Network error', 'error');
      } finally {
        setLoading(saveTtsBtn, false);
      }
    });
  }

  // Test TTS voice
  const ttsTestBtn = $('#tts-test-btn');
  const ttsStopBtn = $('#tts-stop-btn');
  if (ttsTestBtn) {
    ttsTestBtn.addEventListener('click', async () => {
      const resultEl = $('#tts-test-result');
      setLoading(ttsTestBtn, true);
      if (ttsStopBtn) ttsStopBtn.classList.remove('hidden');
      if (resultEl) resultEl.textContent = 'Speaking...';
      try {
        const res = await fetch('/api/voice/config/tts/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'Systems online. All modules operational, sir.' }),
        });
        const data = await res.json();
        if (data.ok) {
          if (resultEl) resultEl.textContent = '';
        } else {
          if (resultEl) resultEl.textContent = data.error ?? 'TTS failed';
        }
      } catch {
        if (resultEl) resultEl.textContent = 'Network error';
      } finally {
        setLoading(ttsTestBtn, false);
        setTimeout(() => { if (ttsStopBtn) ttsStopBtn.classList.add('hidden'); }, 5000);
      }
    });
  }

  if (ttsStopBtn) {
    ttsStopBtn.addEventListener('click', async () => {
      try { await fetch('/api/voice/config/tts/stop', { method: 'POST' }); } catch {}
      ttsStopBtn.classList.add('hidden');
    });
  }

  // Clear history
  const clearHistoryBtn = $('#clear-history-btn');
  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', async () => {
      setLoading(clearHistoryBtn, true);
      try {
        await fetch('/api/voice/history', { method: 'DELETE' });
        await fetchHistory();
        showToast('History cleared', 'ok');
      } catch {
        showToast('Clear failed', 'error');
      } finally {
        setLoading(clearHistoryBtn, false);
      }
    });
  }
}

// ── Stats polling ───────────────────────────────────────────────────

function startStatsPoll() {
  if (_statsTimer) return;
  fetchStats();
  _statsTimer = setInterval(fetchStats, 15000);
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
  _mediaRecorder = null;
  _recordingChunks = [];

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
  fetchHistory();
}

export function unmount(container) {
  // 1. Stop recording if active
  stopRecording();

  // 2. Stop stats polling
  stopStatsPoll();

  // 3. Remove visibility handler
  if (_visibilityHandler) {
    document.removeEventListener('visibilitychange', _visibilityHandler);
    _visibilityHandler = null;
  }

  // 4. Remove scope class & clear HTML
  if (container) {
    container.classList.remove('page-voice');
    container.innerHTML = '';
  }

  // 6. Clear module references
  _container = null;
  audioFile = null;
  _mediaRecorder = null;
  _recordingChunks = [];
}

export function onProjectChange(project) {
  // Reload data when project changes (history, config may differ per project)
  if (_container) {
    loadProviders();
    fetchStatus();
    fetchStats();
    fetchHistory();
  }
}
