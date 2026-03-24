/* ============================================
   PDF2DOC — Frontend Application Logic
   ============================================ */

(function () {
  'use strict';

  // --- Configuration ---
  const CONFIG = {
    MAX_FILE_SIZE: 100 * 1024 * 1024, // 100 MB
    BACKEND_URL_KEY: 'pdf2doc_backend_url',
    API_KEY_KEY: 'pdf2doc_api_key',
    STATS_KEY: 'pdf2doc_stats',
    DEFAULT_BACKEND: 'https://pdf2doc-api.onrender.com',
  };

  // --- DOM References ---
  const $ = (sel) => document.querySelector(sel);
  const dropzone = $('#dropzone');
  const fileInput = $('#fileInput');
  const fileInfo = $('#fileInfo');
  const fileName = $('#fileName');
  const fileSize = $('#fileSize');
  const fileRemove = $('#fileRemove');
  const ocrToggle = null; // OCR is always on (Adobe auto-detects)
  const geminiToggle = $('#geminiToggle');
  const geminiHint = $('#geminiHint');
  const convertBtn = $('#convertBtn');
  const progressSection = $('#progressSection');
  const progressBar = $('#progressBar');
  const progressText = $('#progressText');
  const resultSection = $('#resultSection');
  const resultSubtitle = $('#resultSubtitle');
  const downloadBtn = $('#downloadBtn');
  const newConversion = $('#newConversion');
  const errorBanner = $('#errorBanner');
  const errorText = $('#errorText');
  const errorClose = $('#errorClose');
  const uploadCard = $('#uploadCard');
  const optionsCard = $('#optionsCard');
  const settingsToggle = $('#settingsToggle');
  const settingsPanel = $('#settingsPanel');
  const apiPasswordInput = $('#apiPassword');
  const backendUrlInput = $('#backendUrl');
  const saveSettings = $('#saveSettings');
  const statConverted = $('#statConverted');
  const statRemaining = $('#statRemaining');
  const marginPreset = $('#marginPreset');
  const marginCustom = $('#marginCustom');
  const geminiModelSelect = $('#geminiModelSelect');
  const geminiModelRow = $('#geminiModelRow');

  // --- State ---
  let selectedFile = null;
  let downloadUrl = null;

  // --- Init ---
  function init() {
    loadSettings();
    loadStats();
    loadConversions();
    bindEvents();
  }

  // --- Settings ---
  function loadSettings() {
    const url = localStorage.getItem(CONFIG.BACKEND_URL_KEY);
    if (url) backendUrlInput.value = url;
    const key = localStorage.getItem(CONFIG.API_KEY_KEY);
    if (key) apiPasswordInput.value = key;
  }

  function getApiKey() {
    return apiPasswordInput.value.trim() || localStorage.getItem(CONFIG.API_KEY_KEY) || '';
  }

  function getBackendUrl() {
    return localStorage.getItem(CONFIG.BACKEND_URL_KEY)?.replace(/\/+$/, '') || backendUrlInput.value.trim().replace(/\/+$/, '') || CONFIG.DEFAULT_BACKEND;
  }

  function isBackendConfigured() {
    return !!getBackendUrl();
  }

  // --- Stats (from backend API) ---
  async function loadStats() {
    try {
      const backendUrl = getBackendUrl();
      const res = await fetch(`${backendUrl}/api/stats`);
      if (!res.ok) throw new Error('Stats not available');
      const data = await res.json();
      statConverted.textContent = data.conversions || 0;
      statRemaining.textContent = data.remaining ?? 500;
    } catch {
      statConverted.textContent = '-';
      statRemaining.textContent = '-';
    }
  }

  async function updateStats() {
    await loadStats(); // Reload from backend after conversion
  }

  // --- Event Binding ---
  function bindEvents() {
    // Dropzone click
    dropzone.addEventListener('click', () => fileInput.click());

    // Drag & drop
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dropzone--active');
    });

    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('dropzone--active');
    });

    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dropzone--active');
      const files = e.dataTransfer.files;
      if (files.length > 0) handleFile(files[0]);
    });

    // File input change
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length > 0) handleFile(fileInput.files[0]);
    });

    // File remove
    fileRemove.addEventListener('click', () => {
      clearFile();
    });

    // Convert
    convertBtn.addEventListener('click', () => {
      if (!isBackendConfigured()) {
        showError('⚙️ Configura prima l\'URL del tuo backend nelle Impostazioni in basso.');
        settingsPanel.classList.add('settings-panel--open');
        return;
      }
      if (selectedFile) startConversion();
    });

    // New conversion
    newConversion.addEventListener('click', () => {
      resetAll();
    });

    // Error close
    errorClose.addEventListener('click', () => {
      hideError();
    });

    // Settings toggle
    settingsToggle.addEventListener('click', () => {
      settingsPanel.classList.toggle('settings-panel--open');
    });

    // Save settings
    saveSettings.addEventListener('click', () => {
      const url = backendUrlInput.value.trim();
      const key = apiPasswordInput.value.trim();
      if (url) {
        localStorage.setItem(CONFIG.BACKEND_URL_KEY, url);
      } else {
        localStorage.removeItem(CONFIG.BACKEND_URL_KEY);
      }
      if (key) {
        localStorage.setItem(CONFIG.API_KEY_KEY, key);
      } else {
        localStorage.removeItem(CONFIG.API_KEY_KEY);
      }
      settingsPanel.classList.remove('settings-panel--open');
      showTemporaryButtonText(saveSettings, '✓ Salvato!', 'Salva Impostazioni');
    });

    // Margin preset toggle
    marginPreset.addEventListener('change', () => {
      if (marginPreset.value === 'custom') {
        marginCustom.classList.add('margin-custom--visible');
      } else {
        marginCustom.classList.remove('margin-custom--visible');
      }
    });

    // Gemini toggle — show/hide model selector
    geminiToggle.addEventListener('change', () => {
      geminiModelRow.style.display = geminiToggle.checked ? '' : 'none';
      geminiHint.style.display = geminiToggle.checked ? '' : 'none';
    });
  }

  // --- File Handling ---
  function handleFile(file) {
    hideError();

    if (file.type !== 'application/pdf') {
      showError('Seleziona un file PDF valido.');
      return;
    }

    if (file.size > CONFIG.MAX_FILE_SIZE) {
      showError('Il file supera il limite di 100 MB.');
      return;
    }

    selectedFile = file;
    fileName.textContent = file.name;
    fileSize.textContent = formatFileSize(file.size);

    dropzone.style.display = 'none';
    fileInfo.classList.add('file-info--visible');
    convertBtn.disabled = false;
  }

  function clearFile() {
    selectedFile = null;
    fileInput.value = '';
    dropzone.style.display = '';
    fileInfo.classList.remove('file-info--visible');
    convertBtn.disabled = true;
  }

  // --- Conversion ---
  async function startConversion() {
    const backendUrl = getBackendUrl();
    const useGemini = geminiToggle.checked;

    // Show progress, hide others
    hideError();
    convertBtn.disabled = true;
    convertBtn.textContent = 'Conversione in corso...';
    uploadCard.style.display = 'none';
    optionsCard.style.display = 'none';
    convertBtn.style.display = 'none';
    progressSection.classList.add('progress-section--visible');
    resultSection.classList.remove('result-section--visible');

    try {
      // Step 1: Upload
      setProgress(10, 'Caricamento del PDF...');

      const formData = new FormData();
      formData.append('pdf', selectedFile);
      formData.append('gemini', useGemini ? 'true' : 'false');
      if (useGemini) {
        formData.append('geminiModel', geminiModelSelect.value);
      }

      // Margins
      const margins = getMargins();
      if (margins) formData.append('margins', JSON.stringify(margins));

      // Tier 1 formatting
      const fontFamily = document.getElementById('fontFamilySelect').value;
      const fontSize = document.getElementById('fontSizeSelect').value;
      const lineSpacing = document.getElementById('lineSpacingSelect').value;
      const pageSize = document.getElementById('pageSizeSelect').value;
      if (fontFamily) formData.append('fontFamily', fontFamily);
      if (fontSize) formData.append('fontSize', fontSize);
      if (lineSpacing) formData.append('lineSpacing', lineSpacing);
      if (pageSize) formData.append('pageSize', pageSize);

      // Tier 2 formatting
      const paraSpacing = document.getElementById('paraSpacingSelect').value;
      const textAlign = document.getElementById('textAlignSelect').value;
      const removeImages = document.getElementById('removeImagesToggle').checked;
      const pageNumbers = document.getElementById('pageNumbersSelect').value;
      if (paraSpacing) formData.append('paraSpacing', paraSpacing);
      if (textAlign) formData.append('textAlign', textAlign);
      if (removeImages) formData.append('removeImages', 'true');
      if (pageNumbers) formData.append('pageNumbers', pageNumbers);

      setProgress(20, 'Invio al server di conversione...');

      const headers = {};
      const apiKey = getApiKey();
      if (apiKey) headers['x-api-key'] = apiKey;

      const response = await fetch(`${backendUrl}/api/convert`, {
        method: 'POST',
        headers,
        body: formData,
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        if (response.status === 401) {
          throw new Error('🔑 Password non valida. Controlla nelle Impostazioni.');
        }
        throw new Error(errData.error || `Errore server (${response.status})`);
      }

      setProgress(40, 'Conversione in corso con Adobe AI...');

      // Check if response is a poll-based flow or direct download
      const contentType = response.headers.get('content-type');

      if (contentType && contentType.includes('application/json')) {
        // Polling flow
        const data = await response.json();
        await pollConversion(backendUrl, data.jobId);
      } else {
        // Direct download flow
        setProgress(90, 'Download del DOCX...');
        const blob = await response.blob();
        finishConversion(blob);
      }

    } catch (err) {
      showError(err.message || 'Errore durante la conversione.');
      resetUI();
    }
  }

  async function pollConversion(backendUrl, jobId) {
    let pollCount = 0;
    let networkErrors = 0;
    const poll = async () => {
      pollCount++;

      let res;
      try {
        res = await fetch(`${backendUrl}/api/status/${jobId}`);
      } catch (e) {
        // Network error (server down, CORS, etc.)
        networkErrors++;
        if (networkErrors > 30) {
          throw new Error('Impossibile contattare il server. Verifica la connessione.');
        }
        await new Promise((r) => setTimeout(r, 3000));
        return poll();
      }

      if (res.status === 404) {
        throw new Error('Job non trovato. Il server potrebbe essersi riavviato. Riprova la conversione.');
      }

      if (!res.ok) {
        throw new Error(`Errore server (${res.status}). Riprova.`);
      }

      const data = await res.json();

      if (data.status === 'done') {
        setProgress(90, 'Download del DOCX...');

        const docxRes = await fetch(`${backendUrl}/api/download/${jobId}`);
        if (!docxRes.ok) throw new Error('Errore nel download del file convertito.');

        const blob = await docxRes.blob();
        finishConversion(blob);
        return;
      }

      if (data.status === 'failed') {
        throw new Error(data.error || 'Adobe PDF Services ha restituito un errore.');
      }

      // Still processing
      networkErrors = 0; // reset on success
      const fakeProgress = Math.min(85, 40 + pollCount * 2);
      setProgress(fakeProgress, data.message || 'Elaborazione in corso...');

      await new Promise((r) => setTimeout(r, 2000));
      return poll();
    };

    return poll();
  }

  function finishConversion(blob) {
    setProgress(100, 'Completato!');

    // Create download URL
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(blob);

    const docxName = selectedFile
      ? selectedFile.name.replace(/\.pdf$/i, '.docx')
      : 'converted.docx';

    downloadBtn.href = downloadUrl;
    downloadBtn.download = docxName;
    resultSubtitle.textContent = docxName;

    updateStats();
    loadConversions();

    // Transition to result
    setTimeout(() => {
      progressSection.classList.remove('progress-section--visible');
      resultSection.classList.add('result-section--visible');
    }, 600);
  }

  // --- UI Helpers ---
  function setProgress(percent, text) {
    progressBar.style.width = `${percent}%`;
    if (text) progressText.textContent = text;
  }

  function showError(message) {
    errorText.textContent = message;
    errorBanner.classList.add('error-banner--visible');
  }

  function hideError() {
    errorBanner.classList.remove('error-banner--visible');
  }

  function resetUI() {
    progressSection.classList.remove('progress-section--visible');
    resultSection.classList.remove('result-section--visible');
    uploadCard.style.display = '';
    optionsCard.style.display = '';
    convertBtn.style.display = '';
    convertBtn.disabled = !selectedFile;
    convertBtn.textContent = 'Converti in DOCX';
  }

  function resetAll() {
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl);
      downloadUrl = null;
    }
    clearFile();
    resetUI();
    setProgress(0, 'Preparazione...');
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function showTemporaryButtonText(btn, tempText, originalText) {
    btn.textContent = tempText;
    setTimeout(() => {
      btn.textContent = originalText;
    }, 1500);
  }

  function getMargins() {
    const preset = marginPreset.value;
    if (!preset) return null; // "Originali" — don't touch margins
    if (preset === 'custom') {
      return {
        top: parseFloat($('#marginTop').value) || 2.5,
        bottom: parseFloat($('#marginBottom').value) || 2.5,
        left: parseFloat($('#marginLeft').value) || 2.5,
        right: parseFloat($('#marginRight').value) || 2.5,
      };
    }
    return { preset };
  }

  // --- Conversions History ---

  async function loadConversions() {
    const backendUrl = getBackendUrl();
    if (!backendUrl) return;
    try {
      const headers = {};
      const key = getApiKey();
      if (key) headers['x-api-key'] = key;

      const resp = await fetch(`${backendUrl}/api/conversions`, { headers });
      if (!resp.ok) return;
      const list = await resp.json();
      renderConversions(list);
    } catch {}
  }

  function renderConversions(list) {
    const section = $('#conversionsSection');
    const container = $('#conversionsList');
    if (!list || list.length === 0) {
      section.style.display = 'none';
      return;
    }
    section.style.display = '';
    container.innerHTML = list.map(c => {
      const date = new Date(c.createdAt + 'Z');
      const timeStr = date.toLocaleDateString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      const sizeStr = c.fileSize ? formatFileSize(c.fileSize) : '';
      const name = c.originalName.replace(/\.pdf$/i, '');
      return `
        <div class="conv-item">
          <div class="conv-item__info">
            <div class="conv-item__name" title="${c.originalName}">📄 ${name}</div>
            <div class="conv-item__meta">${timeStr} · ${sizeStr}</div>
          </div>
          <div class="conv-item__actions">
            <button class="conv-item__btn conv-item__btn--reprocess" onclick="window.__reprocess('${c.id}')">♻️ Ri-processa</button>
            <button class="conv-item__btn conv-item__btn--delete" onclick="window.__deleteConv('${c.id}')">✕</button>
          </div>
        </div>
      `;
    }).join('');
  }

  window.__reprocess = async function(convId) {
    const backendUrl = getBackendUrl();
    if (!backendUrl) return;

    const margins = getMargins();
    const useGemini = geminiToggle.checked;
    const geminiModel = geminiModelSelect.value;
    const fontFamily = document.getElementById('fontFamilySelect').value || undefined;
    const fontSize = document.getElementById('fontSizeSelect').value || undefined;
    const lineSpacing = document.getElementById('lineSpacingSelect').value || undefined;
    const pageSize = document.getElementById('pageSizeSelect').value || undefined;
    const paraSpacing = document.getElementById('paraSpacingSelect').value || undefined;
    const textAlign = document.getElementById('textAlignSelect').value || undefined;
    const removeImages = document.getElementById('removeImagesToggle').checked || undefined;
    const pageNumbers = document.getElementById('pageNumbersSelect').value || undefined;

    hideError();
    progressSection.classList.add('progress-section--visible');
    resultSection.classList.remove('result-section--visible');
    setProgress(10, '♻️ Avvio ri-processamento...');

    try {
      const headers = { 'Content-Type': 'application/json' };
      const key = getApiKey();
      if (key) headers['x-api-key'] = key;

      const resp = await fetch(`${backendUrl}/api/reprocess/${convId}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ margins, useGemini, geminiModel, fontFamily, fontSize, lineSpacing, pageSize, paraSpacing, textAlign, removeImages, pageNumbers }),
      });

      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.error || 'Errore nel ri-processamento');
      }

      const { jobId } = await resp.json();
      setProgress(30, 'Ri-processamento in corso...');
      await pollConversion(backendUrl, jobId);
    } catch (err) {
      showError(err.message);
      progressSection.classList.remove('progress-section--visible');
    }
  };

  window.__deleteConv = async function(convId) {
    const backendUrl = getBackendUrl();
    if (!backendUrl) return;
    try {
      const headers = {};
      const key = getApiKey();
      if (key) headers['x-api-key'] = key;

      await fetch(`${backendUrl}/api/conversions/${convId}`, { method: 'DELETE', headers });
      loadConversions();
    } catch {}
  };

  // --- Start ---
  init();
})();
