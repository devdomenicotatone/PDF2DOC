/* ============================================
   PDF2DOC â€” Backend Server (Express.js)
   ============================================ */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const adobe = require('./adobe-service');
const gemini = require('./gemini-service');

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
  console.error('âš ï¸  Manca PDF_SERVICES_CLIENT_ID o PDF_SERVICES_CLIENT_SECRET nel file .env');
  console.error('   Crea un file .env con le credenziali Adobe. Vedi .env.example');
  process.exit(1);
}

// --- Middleware ---
app.use(cors());
app.use(express.json());

// Serve frontend files from parent directory
app.use(express.static(path.join(__dirname, '..')));

// Multer config â€” in-memory storage (max 100 MB)
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

// Cleanup old jobs every 10 minutes
setInterval(() => {
  const maxAge = 30 * 60 * 1000; // 30 minutes
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > maxAge) {
      jobs.delete(id);
    }
  }
}, 10 * 60 * 1000);

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
 * POST /api/convert
 * Upload a PDF and start conversion to DOCX.
 * Body: multipart/form-data with 'pdf' file and optional 'ocr' flag
 */
app.post('/api/convert', requireApiKey, upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nessun file PDF caricato.' });
    }

    const useOCR = req.body.ocr === 'true';
    const useGemini = req.body.gemini === 'true';
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
    processConversion(jobId, req.file.buffer, useOCR, useGemini).catch((err) => {
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
    return res.status(400).json({ error: 'Il file non Ã¨ ancora pronto.' });
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

// --- Background Conversion ---
async function processConversion(jobId, pdfBuffer, useOCR, useGemini) {
  const job = jobs.get(jobId);
  if (!job) return;

  // Step 1: Auth with Adobe
  job.message = 'Autenticazione con Adobe...';
  const token = await adobe.getAccessToken(CLIENT_ID, CLIENT_SECRET);

  // Step 2: Upload PDF
  job.message = 'Caricamento PDF su Adobe Cloud...';
  const { assetID } = await adobe.uploadAsset(token, CLIENT_ID, pdfBuffer);

  // Step 3: Export to DOCX (1 single transaction)
  job.message = 'Conversione in DOCX con Adobe...';
  const exportJobUrl = await adobe.exportPdfToDocx(token, CLIENT_ID, assetID);

  // Step 4: Poll until done
  job.message = 'Adobe sta generando il DOCX...';
  const downloadUri = await adobe.pollJob(token, CLIENT_ID, exportJobUrl);

  // Step 5: Download DOCX
  job.message = 'Download del file convertito...';
  let docxBuffer = await adobe.downloadResult(downloadUri);

  // Step 6: If Gemini correction is requested AND configured, correct text with AI
  if (useGemini && geminiReady) {
    try {
      job.message = 'ðŸ¤– Gemini AI sta correggendo il testo OCR...';
      console.log(`ðŸ¤– Job ${jobId}: avvio correzione Gemini...`);
      docxBuffer = await gemini.correctDocxWithGemini(docxBuffer);
      console.log(`ðŸ¤– Job ${jobId}: correzione Gemini completata`);
    } catch (err) {
      // Gemini failure is non-fatal: return the uncorrected DOCX
      console.error(`âš ï¸ Job ${jobId}: Gemini correction failed: ${err.message}`);
      job.message = 'Conversione completata (senza correzione AI)';
    }
  }

  // Done!
  job.status = 'done';
  job.message = useGemini && geminiReady
    ? 'Conversione completata con correzione AI!'
    : 'Conversione completata!';
  job.result = docxBuffer;

  const mode = useGemini && geminiReady ? 'Adobe+Gemini' : 'Adobe';
  console.log(`âœ… Job ${jobId} completato (${mode}): ${job.fileName}`);
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
  console.log('PDF2DOC Backend avviato su http://localhost:' + PORT);
  console.log('Adobe Client ID: ' + CLIENT_ID.substring(0, 8) + '...');
  console.log('OCR: si (it-IT)');
  console.log('Protezione API: ' + (API_ACCESS_KEY ? 'ATTIVA' : 'disattiva'));
  console.log('Gemini AI: ' + (geminiReady ? 'ATTIVA (gemini-3.1-pro-preview)' : 'disattiva'));
});
