/* ============================================
   Gemini AI — Text Correction Service
   v4: Structure-Aware + Token Counting + Parallel
   ============================================ */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const JSZip = require('jszip');

const GEMINI_MODEL = 'gemini-3.1-pro-preview';
const CHARS_PER_TOKEN = 3.5;          // Italian text avg (conservative)
const MAX_TOKENS_PER_BATCH = 6000;    // ~21K chars — safe for input+output
const CONTEXT_OVERLAP = 2;            // Paragraphs of overlap between batches
const PARALLEL_CONCURRENCY = 3;       // Max simultaneous Gemini calls
const RETRY_DELAY_MS = 1000;          // Delay on rate-limit retry
const MAX_RETRIES = 2;                // Max retries per batch

let genAI = null;
let model = null;

function initGemini(apiKey) {
  if (!apiKey) return false;
  genAI = new GoogleGenerativeAI(apiKey);
  model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
  return true;
}

// --- Token Estimation ---

function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// --- Paragraph Extraction ---

/**
 * Extract paragraphs from DOCX XML with structure detection.
 * Detects headings via <w:pStyle> to enable structure-aware batching.
 */
function extractParagraphs(docXml) {
  const paragraphs = [];
  const paraRegex = /<w:p[\s>][\s\S]*?<\/w:p>/g;
  let match;

  while ((match = paraRegex.exec(docXml)) !== null) {
    const paraXml = match[0];
    const paraStart = match.index;

    // Detect heading style
    const headingMatch = paraXml.match(/<w:pStyle\s+w:val="([^"]*[Hh]eading\d?[^"]*)"/);
    const tocMatch = paraXml.match(/<w:pStyle\s+w:val="([^"]*[Tt]itle[^"]*)"/);
    const isHeading = !!(headingMatch || tocMatch);
    const headingLevel = headingMatch
      ? parseInt((headingMatch[1].match(/\d/) || ['9'])[0], 10)
      : tocMatch ? 0 : null;

    // Extract <w:t> segments
    const textRegex = /<w:t([^>]*)>([^<]*)<\/w:t>/g;
    let textMatch;
    const segments = [];
    let fullText = '';

    while ((textMatch = textRegex.exec(paraXml)) !== null) {
      segments.push({
        fullMatch: textMatch[0],
        attrs: textMatch[1],
        text: textMatch[2],
        localIndex: textMatch.index,
      });
      fullText += textMatch[2];
    }

    paragraphs.push({
      xml: paraXml,
      globalStart: paraStart,
      text: fullText.trim(),
      segments,
      isHeading,
      headingLevel,
    });
  }

  return paragraphs;
}

// --- Structure-Aware Batching ---

/**
 * Groups paragraphs into semantic sections based on headings.
 * Each section starts with a heading and contains all following paragraphs
 * until the next heading of equal or higher level.
 */
function groupBySections(textParagraphs) {
  const sections = [];
  let currentSection = { heading: null, paragraphs: [] };

  for (const para of textParagraphs) {
    if (para.isHeading) {
      // Save current section if it has content
      if (currentSection.paragraphs.length > 0) {
        sections.push(currentSection);
      }
      currentSection = { heading: para, paragraphs: [para] };
    } else {
      currentSection.paragraphs.push(para);
    }
  }

  // Don't forget the last section
  if (currentSection.paragraphs.length > 0) {
    sections.push(currentSection);
  }

  return sections;
}

/**
 * Create smart batches respecting:
 * 1. Section boundaries (never split a section if possible)
 * 2. Token limits (MAX_TOKENS_PER_BATCH)
 * 3. Contextual overlap (CONTEXT_OVERLAP paragraphs)
 */
function createBatches(textParagraphs) {
  const sections = groupBySections(textParagraphs);
  const batches = [];
  let currentBatch = { paragraphs: [], context: [], tokens: 0 };
  let prevBatchLastParas = [];

  for (const section of sections) {
    const sectionTokens = section.paragraphs.reduce(
      (sum, p) => sum + estimateTokens(p.text) + 5, 0 // +5 for [N] overhead
    );

    // If section fits in current batch, add it
    if (currentBatch.tokens + sectionTokens <= MAX_TOKENS_PER_BATCH) {
      currentBatch.paragraphs.push(...section.paragraphs);
      currentBatch.tokens += sectionTokens;
    }
    // If section is too big for any single batch, split it by paragraphs
    else if (sectionTokens > MAX_TOKENS_PER_BATCH) {
      // Flush current batch first
      if (currentBatch.paragraphs.length > 0) {
        currentBatch.context = [...prevBatchLastParas];
        batches.push(currentBatch);
        prevBatchLastParas = currentBatch.paragraphs.slice(-CONTEXT_OVERLAP);
        currentBatch = { paragraphs: [], context: [], tokens: 0 };
      }

      // Split large section paragraph by paragraph
      for (const para of section.paragraphs) {
        const paraTokens = estimateTokens(para.text) + 5;

        if (currentBatch.tokens + paraTokens > MAX_TOKENS_PER_BATCH && currentBatch.paragraphs.length > 0) {
          currentBatch.context = [...prevBatchLastParas];
          batches.push(currentBatch);
          prevBatchLastParas = currentBatch.paragraphs.slice(-CONTEXT_OVERLAP);
          currentBatch = { paragraphs: [], context: [], tokens: 0 };
        }

        currentBatch.paragraphs.push(para);
        currentBatch.tokens += paraTokens;
      }
    }
    // Section doesn't fit in current batch but fits in a new one
    else {
      if (currentBatch.paragraphs.length > 0) {
        currentBatch.context = [...prevBatchLastParas];
        batches.push(currentBatch);
        prevBatchLastParas = currentBatch.paragraphs.slice(-CONTEXT_OVERLAP);
      }
      currentBatch = {
        paragraphs: [...section.paragraphs],
        context: [...prevBatchLastParas],
        tokens: sectionTokens,
      };
    }
  }

  // Flush remaining
  if (currentBatch.paragraphs.length > 0) {
    currentBatch.context = [...prevBatchLastParas];
    batches.push(currentBatch);
  }

  return batches;
}

// --- Gemini API Calls ---

/**
 * Send a single batch to Gemini with retry on rate-limit.
 */
async function correctBatch(batch, batchNum, totalBatches) {
  let contextSection = '';
  if (batch.context.length > 0) {
    const contextLines = batch.context.map(p => `[CTX] ${p.text}`).join('\n');
    contextSection = `\nCONTESTO PRECEDENTE (NON correggere, solo per riferimento):\n${contextLines}\n\n`;
  }

  const numberedList = batch.paragraphs
    .map((p, i) => `[${i}] ${p.text}`)
    .join('\n');

  const prompt = `Sei un esperto correttore di testi OCR in italiano.

Ti invio una lista di paragrafi da un PDF scansionato (batch ${batchNum}/${totalBatches}).
${contextSection}
REGOLE:
1. Correggi SOLO errori OCR evidenti (m↔n, o↔0, l↔1, rn↔m, parole spezzate)
2. NON cambiare significato, stile o struttura
3. NON aggiungere/rimuovere contenuto né unire/dividere paragrafi
4. Ogni riga DEVE mantenere lo stesso [N]. Paragrafi già corretti: ripetili identici
5. NON correggere le righe [CTX]

PARAGRAFI:
${numberedList}

RISPONDI nello STESSO formato [N]. Nessuna spiegazione.`;

  // Retry loop for rate limiting
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 30000 },
      });

      return parseGeminiResponse(result.response.text());
    } catch (err) {
      const isRateLimit = err.message?.includes('429') || err.message?.includes('RESOURCE_EXHAUSTED');
      if (isRateLimit && attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * (attempt + 1) * 2; // Exponential backoff
        console.log(`⏳ Rate limit batch ${batchNum}, retry in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

/**
 * Parse Gemini's [N] response format into a Map.
 */
function parseGeminiResponse(response) {
  const corrections = new Map();
  const lines = response.split('\n');
  let currentIdx = null;
  let currentText = '';

  for (const line of lines) {
    if (line.startsWith('[CTX]')) continue;

    const idxMatch = line.match(/^\[(\d+)\]\s*(.*)/);
    if (idxMatch) {
      if (currentIdx !== null) {
        corrections.set(currentIdx, currentText.trim());
      }
      currentIdx = parseInt(idxMatch[1], 10);
      currentText = idxMatch[2];
    } else if (currentIdx !== null) {
      currentText += ' ' + line.trim();
    }
  }
  if (currentIdx !== null) {
    corrections.set(currentIdx, currentText.trim());
  }

  return corrections;
}

// --- Parallel Execution ---

/**
 * Execute batches with controlled concurrency.
 * Runs up to PARALLEL_CONCURRENCY batches simultaneously.
 */
async function processBatchesParallel(batches) {
  const allCorrections = [];
  const totalBatches = batches.length;

  // Process in waves of PARALLEL_CONCURRENCY
  for (let i = 0; i < batches.length; i += PARALLEL_CONCURRENCY) {
    const wave = batches.slice(i, i + PARALLEL_CONCURRENCY);
    const waveStart = i;

    const promises = wave.map(async (batch, waveIdx) => {
      const batchNum = waveStart + waveIdx + 1;
      try {
        console.log(`🤖 Batch ${batchNum}/${totalBatches}: ${batch.paragraphs.length} para, ~${batch.tokens} token, ctx: ${batch.context.length}`);
        const corrections = await correctBatch(batch, batchNum, totalBatches);
        return { batchNum, batch, corrections };
      } catch (err) {
        console.error(`⚠️ Batch ${batchNum} failed: ${err.message}`);
        return { batchNum, batch, corrections: new Map() };
      }
    });

    const results = await Promise.all(promises);
    allCorrections.push(...results);

    // Small delay between waves
    if (i + PARALLEL_CONCURRENCY < batches.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  return allCorrections;
}

// --- Main Pipeline ---

async function correctParagraphsWithGemini(paragraphs) {
  if (!model) throw new Error('Gemini non configurato. Aggiungi GEMINI_API_KEY.');

  const textParagraphs = paragraphs
    .map((p, i) => ({ ...p, origIndex: i }))
    .filter(p => p.text.length > 3);

  if (textParagraphs.length === 0) return null;

  const totalChars = textParagraphs.reduce((s, p) => s + p.text.length, 0);
  const totalTokens = estimateTokens(totalChars.toString()) + textParagraphs.reduce((s, p) => s + estimateTokens(p.text), 0);

  // Create structure-aware batches
  const batches = createBatches(textParagraphs);

  const sectionCount = groupBySections(textParagraphs).length;
  console.log(`📦 ${batches.length} batch | ${textParagraphs.length} paragrafi | ${sectionCount} sezioni | ~${Math.round(totalChars / 1000)}K chars (~${totalTokens} token)`);
  console.log(`🚀 Concorrenza: ${Math.min(PARALLEL_CONCURRENCY, batches.length)} batch simultanei`);

  // Process in parallel
  const results = await processBatchesParallel(batches);

  // Map corrections back to global paragraph indices
  const globalCorrections = new Map();

  for (const { batch, corrections } of results) {
    corrections.forEach((correctedText, localIdx) => {
      if (localIdx >= 0 && localIdx < batch.paragraphs.length) {
        const globalIdx = batch.paragraphs[localIdx].origIndex;
        globalCorrections.set(globalIdx, correctedText);
      }
    });
  }

  return globalCorrections.size > 0 ? globalCorrections : null;
}

// --- Text Replacement ---

function applyParagraphCorrection(paraXml, correctedText, segments) {
  if (segments.length === 0) return paraXml;

  if (segments.length === 1) {
    const seg = segments[0];
    const escaped = escapeXml(correctedText);
    let attrs = seg.attrs;
    if (!attrs.includes('xml:space')) attrs = ' xml:space="preserve"';
    const newTag = `<w:t${attrs}>${escaped}</w:t>`;
    return paraXml.substring(0, seg.localIndex) +
      newTag +
      paraXml.substring(seg.localIndex + seg.fullMatch.length);
  }

  // Proportional distribution across runs
  const totalOrigLen = segments.reduce((sum, s) => sum + s.text.length, 0);
  if (totalOrigLen === 0) return paraXml;

  const distribution = [];
  let remaining = correctedText;

  for (let i = 0; i < segments.length; i++) {
    if (i === segments.length - 1) {
      distribution.push(remaining);
    } else {
      const ratio = segments[i].text.length / totalOrigLen;
      let targetLen = Math.round(correctedText.length * ratio);
      let cutPos = Math.max(0, Math.min(targetLen, remaining.length));

      // Snap to nearest word boundary (±10 chars)
      let bestCut = cutPos;
      for (let d = 0; d <= 10; d++) {
        if (cutPos + d < remaining.length && remaining[cutPos + d] === ' ') {
          bestCut = cutPos + d; break;
        }
        if (cutPos - d >= 0 && remaining[cutPos - d] === ' ') {
          bestCut = cutPos - d; break;
        }
      }

      distribution.push(remaining.substring(0, bestCut));
      remaining = remaining.substring(bestCut).replace(/^ /, '');
    }
  }

  let modifiedXml = paraXml;
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    const newText = escapeXml(distribution[i] || '');
    let attrs = seg.attrs;
    if (!attrs.includes('xml:space')) attrs = ' xml:space="preserve"';
    const newTag = `<w:t${attrs}>${newText}</w:t>`;
    modifiedXml =
      modifiedXml.substring(0, seg.localIndex) +
      newTag +
      modifiedXml.substring(seg.localIndex + seg.fullMatch.length);
  }

  return modifiedXml;
}

function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- Full Pipeline ---

async function correctDocxWithGemini(docxBuffer) {
  const zip = await JSZip.loadAsync(docxBuffer);
  let docXml = await zip.file('word/document.xml').async('string');

  const paragraphs = extractParagraphs(docXml);
  const textParas = paragraphs.filter(p => p.text.length > 3);

  if (textParas.length === 0) {
    console.log('⚠️ Nessun testo trovato nel DOCX');
    return docxBuffer;
  }

  console.log(`📝 Paragrafi: ${textParas.length}/${paragraphs.length} (heading: ${textParas.filter(p => p.isHeading).length})`);

  const corrections = await correctParagraphsWithGemini(paragraphs);

  if (!corrections || corrections.size === 0) {
    console.log('⚠️ Nessuna correzione da Gemini');
    return docxBuffer;
  }

  console.log(`✅ Corretti: ${corrections.size} paragrafi`);

  // Apply backwards
  const sortedIndices = [...corrections.keys()].sort((a, b) => b - a);

  for (const idx of sortedIndices) {
    const para = paragraphs[idx];
    const correctedText = corrections.get(idx);
    if (correctedText === para.text) continue;

    const correctedXml = applyParagraphCorrection(para.xml, correctedText, para.segments);
    docXml =
      docXml.substring(0, para.globalStart) +
      correctedXml +
      docXml.substring(para.globalStart + para.xml.length);
  }

  zip.file('word/document.xml', docXml);
  return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = {
  initGemini,
  correctDocxWithGemini,
  extractParagraphs,
  correctParagraphsWithGemini,
};
