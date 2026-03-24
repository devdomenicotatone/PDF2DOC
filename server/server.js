/* ============================================
   PDF2DOC — Backend Server (Express.js)
   ============================================ */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const adobe = require('./adobe-service');
const gemini = require('./gemini-service');
const { normalizeDocxFontSize, setDocxMargins, setDocxFontFamily, setDocxFontSize, setDocxLineSpacing, setDocxPageSize, setDocxParagraphSpacing, setDocxTextAlignment, removeDocxImages, addDocxPageNumbers } = require('./normalize-service');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Config ---
const CLIENT_ID = process.env.PDF_SERVICES_CLIENT_ID;
const CLIENT_SECRET = process.env.PDF_SERVICES_CLIENT_SECRET;
const API_ACCESS_KEY = process.env.API_ACCESS_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// Init Gemini
const geminiReady = gemini.initGemini(GEMINI_API_KEY);

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('⚠️  Manca PDF_SERVICES_CLIENT_ID o PDF_SERVICES_CLIENT_SECRET nel file .env');
  console.error('   Crea un file .env con le credenziali Adobe. Vedi .env.example');
  process.exit(1);
}

// --- Middleware ---
app.use(cors());
app.use(express.json());

// Serve frontend files from parent directory
app.use(express.static(path.join(__dirname, '..')));

// Multer config — in-memory storage (max 100 MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Solo file PDF accettati.'));
    }
  },
});

// --- In-memory job store ---
const jobs = new Map();

// --- Transaction Counter (file-persisted) ---
const STATS_FILE = path.join(__dirname, '.stats.json');
const ADOBE_FREE_LIMIT = 500; // Adobe free tier: 500 Document Transactions/month

function loadStats() {
  try {
    const data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
    // Reset monthly if month changed
    const now = new Date();
    const statsMonth = data.month || '';
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    if (statsMonth !== currentMonth) {
      return { month: currentMonth, conversions: 0, transactions: 0 };
    }
    return data;
  } catch {
    const now = new Date();
    return { month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`, conversions: 0, transactions: 0 };
  }
}

function saveStats(stats) {
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats)); } catch {}
}

let stats = loadStats();

// Cleanup old jobs every 30 minutes + old conversions daily
setInterval(() => {
  const maxAge = 2 * 60 * 60 * 1000; // 2 hours
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > maxAge) {
      jobs.delete(id);
    }
  }
  // Cleanup old DOCX files from DB (> 7 days)
  const cleaned = db.cleanupOldConversions();
  if (cleaned > 0) console.log(`🧹 Pulite ${cleaned} conversioni vecchie`);
}, 30 * 60 * 1000);

// --- Auth Middleware ---
function requireApiKey(req, res, next) {
  if (!API_ACCESS_KEY) return next(); // No protection if key not set
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_ACCESS_KEY) {
    return res.status(401).json({ error: 'Password non valida.' });
  }
  next();
}

// --- Routes ---

/**
 * GET /api/models
 * Returns available Gemini models and current selection.
 */
app.get('/api/models', (req, res) => {
  res.json({
    current: gemini.getModelName(),
    models: gemini.AVAILABLE_MODELS,
  });
});

/**
 * POST /api/convert
 * Upload a PDF and start conversion to DOCX.
 * Body: multipart/form-data with 'pdf' file, optional 'gemini' flag, 'geminiModel', 'margins'
 */
app.post('/api/convert', requireApiKey, upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nessun file PDF caricato.' });
    }

    const useGemini = req.body.gemini === 'true';
    const geminiModel = req.body.geminiModel || '';
    let margins = null;
    try {
      if (req.body.margins) margins = JSON.parse(req.body.margins);
    } catch {}
    const fontFamily = req.body.fontFamily || null;
    const fontSize = req.body.fontSize ? parseFloat(req.body.fontSize) : null;
    const lineSpacing = req.body.lineSpacing || null;
    const pageSize = req.body.pageSize || null;
    const paraSpacing = req.body.paraSpacing || null;
    const textAlign = req.body.textAlign || null;
    const removeImages = req.body.removeImages === 'true';
    const pageNumbers = req.body.pageNumbers || null;

    // Switch Gemini model if requested
    if (geminiModel && useGemini) {
      gemini.setModel(geminiModel);
    }

    const jobId = crypto.randomUUID();

    // Create job entry
    jobs.set(jobId, {
      status: 'processing',
      message: 'Autenticazione con Adobe...',
      createdAt: Date.now(),
      result: null,
      error: null,
      fileName: req.file.originalname,
    });

    // Respond immediately with job ID
    res.json({ jobId, status: 'processing' });

    // Process in background
    processConversion(jobId, req.file.buffer, useGemini, margins, { fontFamily, fontSize, lineSpacing, pageSize, paraSpacing, textAlign, removeImages, pageNumbers }).catch((err) => {
      console.error(`Job ${jobId} failed:`, err.message);
      const job = jobs.get(jobId);
      if (job) {
        job.status = 'failed';
        job.error = err.message;
      }
    });

  } catch (err) {
    console.error('Convert error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/status/:jobId
 * Check status of a conversion job
 */
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job non trovato.' });
  }

  res.json({
    status: job.status,
    message: job.message,
    error: job.error,
    fileName: job.fileName,
  });
});

/**
 * GET /api/download/:jobId
 * Download the converted DOCX file
 */
app.get('/api/download/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job non trovato.' });
  }

  if (job.status !== 'done' || !job.result) {
    return res.status(400).json({ error: 'Il file non è ancora pronto.' });
  }

  const docxName = job.fileName
    ? job.fileName.replace(/\.pdf$/i, '.docx')
    : 'converted.docx';

  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'Content-Disposition': `attachment; filename="${docxName}"`,
    'Content-Length': job.result.length,
  });

  res.send(job.result);

  // Clean up after download
  setTimeout(() => jobs.delete(req.params.jobId), 60000);
});

/**
 * GET /api/health
 * Health check endpoint
 */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * GET /api/stats
 * Return conversion stats
 */
app.get('/api/stats', (req, res) => {
  stats = loadStats();
  res.json({
    conversions: stats.conversions,
    transactions: stats.transactions,
    remaining: Math.max(0, ADOBE_FREE_LIMIT - stats.transactions),
    month: stats.month,
    limit: ADOBE_FREE_LIMIT,
  });
});

/**
 * GET /api/conversions
 * List recent conversions stored in DB
 */
app.get('/api/conversions', requireApiKey, (req, res) => {
  const list = db.listConversions(20);
  res.json(list);
});

/**
 * POST /api/reprocess/:id
 * Re-apply font normalization, margins, and/or Gemini on a stored raw DOCX
 */
app.post('/api/reprocess/:id', requireApiKey, express.json(), async (req, res) => {
  try {
    const conv = db.getConversion(req.params.id);
    if (!conv) {
      return res.status(404).json({ error: 'Conversione non trovata.' });
    }

    const rawBuffer = db.getRawDocxBuffer(req.params.id);
    if (!rawBuffer) {
      return res.status(404).json({ error: 'File DOCX grezzo non trovato su disco.' });
    }

    const { margins, geminiModel, useGemini, fontFamily, fontSize, lineSpacing, pageSize, paraSpacing, textAlign, removeImages, pageNumbers } = req.body;
    const jobId = crypto.randomUUID();

    // Create job entry for progress tracking
    jobs.set(jobId, {
      status: 'processing',
      message: 'Ri-processamento in corso...',
      createdAt: Date.now(),
      result: null,
      error: null,
      fileName: conv.originalName,
    });

    res.json({ jobId, status: 'processing' });

    // Process in background
    processReprocess(jobId, rawBuffer, margins, useGemini, geminiModel, conv.id, { fontFamily, fontSize: fontSize ? parseFloat(fontSize) : null, lineSpacing, pageSize, paraSpacing, textAlign, removeImages, pageNumbers }).catch((err) => {
      console.error(`Reprocess ${jobId} failed:`, err.message);
      const job = jobs.get(jobId);
      if (job) {
        job.status = 'failed';
        job.error = err.message;
      }
    });

  } catch (err) {
    console.error('Reprocess error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/conversions/:id
 * Delete a stored conversion + file
 */
app.delete('/api/conversions/:id', requireApiKey, (req, res) => {
  db.deleteConversion(req.params.id);
  res.json({ ok: true });
});

// --- Background Conversion ---
async function processConversion(jobId, pdfBuffer, useGemini, margins, formatting = {}) {
  const job = jobs.get(jobId);
  if (!job) return;

  // Step 1: Auth with Adobe
  job.message = 'Autenticazione con Adobe...';
  const token = await adobe.getAccessToken(CLIENT_ID, CLIENT_SECRET);

  // Step 2: Upload PDF
  job.message = 'Caricamento PDF su Adobe Cloud...';
  const { assetID } = await adobe.uploadAsset(token, CLIENT_ID, pdfBuffer);

  // Step 3: Export to DOCX (1 single transaction, OCR auto-detected)
  job.message = 'Conversione in DOCX con Adobe...';
  const exportJobUrl = await adobe.exportPdfToDocx(token, CLIENT_ID, assetID);

  // Step 4: Poll until done
  job.message = 'Adobe sta generando il DOCX...';
  const downloadUri = await adobe.pollJob(token, CLIENT_ID, exportJobUrl);

  // Step 5: Download DOCX
  job.message = 'Download del file convertito...';
  let docxBuffer = await adobe.downloadResult(downloadUri);

  // Step 5.1: Save raw DOCX to disk (for future reprocessing)
  const convId = jobId;
  try {
    db.saveConversion(convId, job.fileName, docxBuffer);
    console.log(`💾 Job ${jobId}: DOCX grezzo salvato (${(docxBuffer.length / 1024).toFixed(1)} KB)`);
  } catch (err) {
    console.error(`⚠️ Job ${jobId}: Salvataggio DB fallito: ${err.message}`);
  }

  // Step 5.5: Normalize font sizes (fix OCR size inconsistencies)
  job.message = '📐 Normalizzazione font-size...';
  try {
    docxBuffer = await normalizeDocxFontSize(docxBuffer);
  } catch (err) {
    console.error(`⚠️ Job ${jobId}: Font normalization failed: ${err.message}`);
  }

  // Step 5.6: Apply page margins
  if (margins) {
    job.message = '📏 Impostazione margini pagina...';
    try {
      docxBuffer = await setDocxMargins(docxBuffer, margins);
    } catch (err) {
      console.error(`⚠️ Job ${jobId}: Margin setting failed: ${err.message}`);
    }
  }

  // Step 5.7: Apply Tier 1 formatting
  if (formatting.fontFamily) {
    job.message = '🔤 Cambio font...';
    try { docxBuffer = await setDocxFontFamily(docxBuffer, formatting.fontFamily); } catch (err) { console.error(`⚠️ Font family: ${err.message}`); }
  }
  if (formatting.fontSize) {
    job.message = '🔠 Ridimensionamento font...';
    try { docxBuffer = await setDocxFontSize(docxBuffer, formatting.fontSize); } catch (err) { console.error(`⚠️ Font size: ${err.message}`); }
  }
  if (formatting.lineSpacing) {
    job.message = '📝 Impostazione interlinea...';
    try { docxBuffer = await setDocxLineSpacing(docxBuffer, formatting.lineSpacing); } catch (err) { console.error(`⚠️ Line spacing: ${err.message}`); }
  }
  if (formatting.pageSize) {
    job.message = '📄 Impostazione formato pagina...';
    try { docxBuffer = await setDocxPageSize(docxBuffer, formatting.pageSize); } catch (err) { console.error(`⚠️ Page size: ${err.message}`); }
  }

  // Step 5.8: Apply Tier 2 formatting
  if (formatting.paraSpacing) {
    job.message = '↕️ Spaziatura paragrafi...';
    try { docxBuffer = await setDocxParagraphSpacing(docxBuffer, formatting.paraSpacing); } catch (err) { console.error(`⚠️ Para spacing: ${err.message}`); }
  }
  if (formatting.textAlign) {
    job.message = '↔️ Allineamento testo...';
    try { docxBuffer = await setDocxTextAlignment(docxBuffer, formatting.textAlign); } catch (err) { console.error(`⚠️ Text align: ${err.message}`); }
  }
  if (formatting.removeImages) {
    job.message = '🖼️ Rimozione immagini...';
    try { docxBuffer = await removeDocxImages(docxBuffer); } catch (err) { console.error(`⚠️ Remove images: ${err.message}`); }
  }
  if (formatting.pageNumbers) {
    job.message = '🔢 Numerazione pagine...';
    try { docxBuffer = await addDocxPageNumbers(docxBuffer, formatting.pageNumbers); } catch (err) { console.error(`⚠️ Page numbers: ${err.message}`); }
  }

  // Step 6: If Gemini correction is requested AND configured, correct text with AI
  if (useGemini && geminiReady) {
    try {
      job.message = '🤖 Gemini AI sta correggendo il testo OCR...';
      console.log(`🤖 Job ${jobId}: avvio correzione Gemini...`);
      docxBuffer = await gemini.correctDocxWithGemini(docxBuffer, job);
      console.log(`🤖 Job ${jobId}: correzione Gemini completata`);
    } catch (err) {
      // Gemini failure is non-fatal: return the uncorrected DOCX
      console.error(`⚠️ Job ${jobId}: Gemini correction failed: ${err.message}`);
      job.message = 'Conversione completata (senza correzione AI)';
    }
  }

  // Update DB with processing info
  db.updateProcessedInfo(convId, margins, gemini.getModelName());

  // Done — update stats
  stats = loadStats();
  stats.conversions++;
  stats.transactions++; // 1 export = 1 Document Transaction
  saveStats(stats);

  job.status = 'done';
  job.message = useGemini && geminiReady
    ? 'Conversione completata con correzione AI!'
    : 'Conversione completata!';
  job.result = docxBuffer;

  const mode = useGemini && geminiReady ? 'Adobe+Gemini' : 'Adobe';
  console.log(`✅ Job ${jobId} completato (${mode}): ${job.fileName} [${stats.transactions}/${ADOBE_FREE_LIMIT} transazioni]`);
}

/**
 * Re-process a stored raw DOCX with new settings (no Adobe transaction)
 */
async function processReprocess(jobId, rawBuffer, margins, useGemini, geminiModel, convId, formatting = {}) {
  const job = jobs.get(jobId);
  if (!job) return;

  let docxBuffer = Buffer.from(rawBuffer);

  // Font normalization
  job.message = '📐 Normalizzazione font-size...';
  try {
    docxBuffer = await normalizeDocxFontSize(docxBuffer);
  } catch (err) {
    console.error(`⚠️ Reprocess ${jobId}: Font normalization failed: ${err.message}`);
  }

  // Margins
  if (margins) {
    job.message = '📏 Impostazione margini pagina...';
    try {
      docxBuffer = await setDocxMargins(docxBuffer, margins);
    } catch (err) {
      console.error(`⚠️ Reprocess ${jobId}: Margin setting failed: ${err.message}`);
    }
  }

  // Tier 1 formatting
  if (formatting.fontFamily) {
    job.message = '🔤 Cambio font...';
    try { docxBuffer = await setDocxFontFamily(docxBuffer, formatting.fontFamily); } catch (err) { console.error(`⚠️ Font family: ${err.message}`); }
  }
  if (formatting.fontSize) {
    job.message = '🔠 Ridimensionamento font...';
    try { docxBuffer = await setDocxFontSize(docxBuffer, formatting.fontSize); } catch (err) { console.error(`⚠️ Font size: ${err.message}`); }
  }
  if (formatting.lineSpacing) {
    job.message = '📝 Impostazione interlinea...';
    try { docxBuffer = await setDocxLineSpacing(docxBuffer, formatting.lineSpacing); } catch (err) { console.error(`⚠️ Line spacing: ${err.message}`); }
  }
  if (formatting.pageSize) {
    job.message = '📄 Impostazione formato pagina...';
    try { docxBuffer = await setDocxPageSize(docxBuffer, formatting.pageSize); } catch (err) { console.error(`⚠️ Page size: ${err.message}`); }
  }

  // Tier 2 formatting
  if (formatting.paraSpacing) {
    job.message = '↕️ Spaziatura paragrafi...';
    try { docxBuffer = await setDocxParagraphSpacing(docxBuffer, formatting.paraSpacing); } catch (err) { console.error(`⚠️ Para spacing: ${err.message}`); }
  }
  if (formatting.textAlign) {
    job.message = '↔️ Allineamento testo...';
    try { docxBuffer = await setDocxTextAlignment(docxBuffer, formatting.textAlign); } catch (err) { console.error(`⚠️ Text align: ${err.message}`); }
  }
  if (formatting.removeImages) {
    job.message = '🖼️ Rimozione immagini...';
    try { docxBuffer = await removeDocxImages(docxBuffer); } catch (err) { console.error(`⚠️ Remove images: ${err.message}`); }
  }
  if (formatting.pageNumbers) {
    job.message = '🔢 Numerazione pagine...';
    try { docxBuffer = await addDocxPageNumbers(docxBuffer, formatting.pageNumbers); } catch (err) { console.error(`⚠️ Page numbers: ${err.message}`); }
  }

  // Gemini
  if (useGemini && geminiReady) {
    if (geminiModel) gemini.setModel(geminiModel);
    try {
      job.message = '🤖 Gemini AI sta correggendo il testo OCR...';
      docxBuffer = await gemini.correctDocxWithGemini(docxBuffer, job);
    } catch (err) {
      console.error(`⚠️ Reprocess ${jobId}: Gemini correction failed: ${err.message}`);
    }
  }

  // Update DB
  db.updateProcessedInfo(convId, margins, gemini.getModelName());

  job.status = 'done';
  job.message = '♻️ Ri-processamento completato!';
  job.result = docxBuffer;
  console.log(`♻️ Reprocess ${jobId} completato: ${job.fileName} (0 transazioni Adobe)`);
}

// --- Error Handler ---
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File troppo grande (max 100 MB).' });
    }
  }
  console.error('Server error:', err);
  res.status(500).json({ error: err.message || 'Errore interno del server.' });
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`🚀 PDF2DOC Backend avviato su http://localhost:${PORT}`);
  console.log(`📄 Adobe Client ID: ${CLIENT_ID.substring(0, 8)}...`);
  console.log(`🔒 OCR: sempre attivo (it-IT)`);
  console.log(`🔑 Protezione API: ${API_ACCESS_KEY ? 'ATTIVA' : 'disattiva'}`);
  console.log(`🤖 Gemini AI: ${geminiReady ? 'ATTIVA (' + gemini.getModelName() + ')' : 'disattiva'}`);
});
