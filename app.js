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
  const ocrToggle = $('#ocrToggle');
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

  // --- State ---
  let selectedFile = null;
  let downloadUrl = null;

  // --- Init ---
  function init() {
    loadSettings();
    loadStats();
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

  // --- Stats ---
  function loadStats() {
    try {
      const stats = JSON.parse(localStorage.getItem(CONFIG.STATS_KEY) || '{}');
      const now = new Date();
      const monthKey = `${now.getFullYear()}-${now.getMonth()}`;

      if (stats.month !== monthKey) {
        stats.month = monthKey;
        stats.converted = 0;
        stats.remaining = 500;
      }

      statConverted.textContent = stats.converted || 0;
      statRemaining.textContent = stats.remaining ?? 500;
    } catch {
      statConverted.textContent = '0';
      statRemaining.textContent = '500';
    }
  }

  function updateStats() {
    try {
      const now = new Date();
      const monthKey = `${now.getFullYear()}-${now.getMonth()}`;
      const stats = JSON.parse(localStorage.getItem(CONFIG.STATS_KEY) || '{}');

      if (stats.month !== monthKey) {
        stats.month = monthKey;
        stats.converted = 0;
        stats.remaining = 500;
      }

      stats.converted = (stats.converted || 0) + 1;
      stats.remaining = Math.max(0, (stats.remaining ?? 500) - 1);

      localStorage.setItem(CONFIG.STATS_KEY, JSON.stringify(stats));
      statConverted.textContent = stats.converted;
      statRemaining.textContent = stats.remaining;
    } catch { /* silent */ }
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
    const useOCR = ocrToggle.checked;

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
      formData.append('ocr', useOCR ? 'true' : 'false');

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
    const maxAttempts = 60;
    let attempts = 0;

    const poll = async () => {
      attempts++;

      if (attempts > maxAttempts) {
        throw new Error('Timeout: la conversione ha impiegato troppo tempo.');
      }

      const res = await fetch(`${backendUrl}/api/status/${jobId}`);
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
      const fakeProgress = Math.min(85, 40 + attempts * 2);
      setProgress(fakeProgress, data.message || 'Elaborazione con Adobe AI...');

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

  // --- Start ---
  init();
})();
