/* ============================================
   Gemini AI — Text Correction Service
   Paragraph-Based with Smart Batching (v3)
   ============================================ */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const JSZip = require('jszip');

const GEMINI_MODEL = 'gemini-3.1-pro-preview';
const BATCH_CHAR_LIMIT = 20000;  // Max chars per Gemini batch
const CONTEXT_OVERLAP = 2;       // Paragraphs of overlap between batches

let genAI = null;
let model = null;

function initGemini(apiKey) {
  if (!apiKey) return false;
  genAI = new GoogleGenerativeAI(apiKey);
  model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
  return true;
}

/**
 * Extract paragraphs from DOCX XML.
 * Each <w:p> element is a paragraph with its own text segments.
 */
function extractParagraphs(docXml) {
  const paragraphs = [];
  const paraRegex = /<w:p[\s>][\s\S]*?<\/w:p>/g;
  let match;

  while ((match = paraRegex.exec(docXml)) !== null) {
    const paraXml = match[0];
    const paraStart = match.index;
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
      segments: segments,
    });
  }

  return paragraphs;
}

/**
 * Group text paragraphs into smart batches.
 * - Each batch stays under BATCH_CHAR_LIMIT
 * - Never splits mid-paragraph
 * - Includes CONTEXT_OVERLAP paragraphs from previous batch as context
 */
function createBatches(textParagraphs) {
  const batches = [];
  let batchStart = 0;

  while (batchStart < textParagraphs.length) {
    let charCount = 0;
    let batchEnd = batchStart;

    // Fill batch until char limit
    while (batchEnd < textParagraphs.length) {
      const paraLen = textParagraphs[batchEnd].text.length + 10; // +10 for [N] prefix
      if (charCount + paraLen > BATCH_CHAR_LIMIT && batchEnd > batchStart) {
        break; // Would exceed limit, stop here
      }
      charCount += paraLen;
      batchEnd++;
    }

    // Build context: last N paragraphs from previous batch
    const contextParas = [];
    if (batches.length > 0 && batchStart > 0) {
      const contextStart = Math.max(0, batchStart - CONTEXT_OVERLAP);
      for (let i = contextStart; i < batchStart; i++) {
        contextParas.push(textParagraphs[i]);
      }
    }

    batches.push({
      paragraphs: textParagraphs.slice(batchStart, batchEnd),
      context: contextParas,
      startIdx: batchStart,
      endIdx: batchEnd,
    });

    batchStart = batchEnd;
  }

  return batches;
}

/**
 * Send a single batch to Gemini for correction.
 * Context paragraphs are included but marked as non-correctable.
 */
async function correctBatch(batch, batchNum, totalBatches) {
  // Build the context section (if any)
  let contextSection = '';
  if (batch.context.length > 0) {
    const contextLines = batch.context
      .map(p => `[CTX] ${p.text}`)
      .join('\n');
    contextSection = `\nCONTESTO PRECEDENTE (NON correggere, solo per riferimento):\n${contextLines}\n\n`;
  }

  // Build the numbered list of paragraphs to correct
  const numberedList = batch.paragraphs
    .map((p, i) => `[${i}] ${p.text}`)
    .join('\n');

  const prompt = `Sei un esperto correttore di testi OCR in italiano.

Ti invio una lista numerata di paragrafi estratti da un PDF scansionato via OCR (batch ${batchNum}/${totalBatches}). Ogni riga inizia con [N] seguito dal testo del paragrafo.
${contextSection}
REGOLE FONDAMENTALI:
1. Correggi SOLO gli errori evidenti dell'OCR (lettere confuse come m↔n, o↔0, l↔1, rn↔m, parole spezzate, ecc.)
2. NON cambiare il significato, lo stile o la struttura
3. NON aggiungere o rimuovere contenuto
4. NON unire o dividere paragrafi — mantieni ESATTAMENTE lo stesso numero di righe
5. Ogni riga della risposta DEVE iniziare con lo stesso [N] dell'input
6. Se un paragrafo è già corretto, ripetilo identico
7. Mantieni titoli, numerazione e riferimenti biblici intatti
8. NON correggere le righe [CTX] — sono solo contesto

PARAGRAFI DA CORREGGERE:
${numberedList}

RISPONDI con la lista corretta nello STESSO formato [N], una riga per paragrafo. Nessuna spiegazione.`;

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 30000 },
  });

  const response = result.response.text();

  // Parse response: extract [N] → text mapping
  const corrections = new Map();
  const lines = response.split('\n');
  let currentIdx = null;
  let currentText = '';

  for (const line of lines) {
    // Skip context lines in response (if Gemini echoes them)
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

/**
 * Main correction pipeline with smart batching.
 * Handles documents of any size by splitting into batches.
 */
async function correctParagraphsWithGemini(paragraphs) {
  if (!model) throw new Error('Gemini non configurato. Aggiungi GEMINI_API_KEY.');

  // Filter paragraphs with actual text content
  const textParagraphs = paragraphs
    .map((p, i) => ({ index: i, text: p.text }))
    .filter(p => p.text.length > 3);

  if (textParagraphs.length === 0) return null;

  // Create smart batches
  const batches = createBatches(textParagraphs);

  console.log(`📦 Batch creati: ${batches.length} (${textParagraphs.length} paragrafi, ~${Math.round(textParagraphs.reduce((s, p) => s + p.text.length, 0) / 1000)}K chars)`);

  // Process each batch
  const allCorrections = new Map();

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    console.log(`🤖 Batch ${b + 1}/${batches.length}: ${batch.paragraphs.length} paragrafi (contesto: ${batch.context.length})`);

    try {
      const batchCorrections = await correctBatch(batch, b + 1, batches.length);

      // Map batch-local indices back to global paragraph indices
      batchCorrections.forEach((correctedText, localIdx) => {
        if (localIdx >= 0 && localIdx < batch.paragraphs.length) {
          const globalIdx = batch.paragraphs[localIdx].index;
          allCorrections.set(globalIdx, correctedText);
        }
      });

      // Small delay between batches to avoid rate limiting
      if (b < batches.length - 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (err) {
      console.error(`⚠️ Batch ${b + 1} failed: ${err.message}`);
      // Continue with other batches — partial correction is better than none
    }
  }

  return allCorrections.size > 0 ? allCorrections : null;
}

/**
 * Apply corrected text to a single paragraph's XML.
 * Distributes text proportionally across existing <w:t> tags
 * to preserve each run's formatting (font size, bold, italic, etc.)
 */
function applyParagraphCorrection(paraXml, correctedText, segments) {
  if (segments.length === 0) return paraXml;

  // Single segment: direct replacement
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

  // Multiple segments: proportional distribution
  const totalOrigLen = segments.reduce((sum, s) => sum + s.text.length, 0);
  if (totalOrigLen === 0) return paraXml;

  const distribution = [];
  let correctedRemaining = correctedText;

  for (let i = 0; i < segments.length; i++) {
    if (i === segments.length - 1) {
      distribution.push(correctedRemaining);
    } else {
      const ratio = segments[i].text.length / totalOrigLen;
      let targetLen = Math.round(correctedText.length * ratio);

      // Find nearest word boundary
      let cutPos = targetLen;
      let bestCut = cutPos;
      let bestDist = Infinity;

      for (let d = 0; d <= 10 && cutPos + d <= correctedRemaining.length; d++) {
        if (correctedRemaining[cutPos + d] === ' ') {
          bestCut = cutPos + d;
          bestDist = d;
          break;
        }
        if (cutPos - d >= 0 && correctedRemaining[cutPos - d] === ' ') {
          bestCut = cutPos - d;
          bestDist = d;
          break;
        }
      }

      if (bestDist === Infinity) bestCut = targetLen;
      bestCut = Math.max(0, Math.min(bestCut, correctedRemaining.length));

      distribution.push(correctedRemaining.substring(0, bestCut));
      correctedRemaining = correctedRemaining.substring(bestCut);
      if (correctedRemaining.startsWith(' ')) {
        correctedRemaining = correctedRemaining.substring(1);
      }
    }
  }

  // Apply backwards to preserve positions
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

/**
 * Full pipeline: extract → batch → correct → apply
 */
async function correctDocxWithGemini(docxBuffer) {
  const zip = await JSZip.loadAsync(docxBuffer);
  let docXml = await zip.file('word/document.xml').async('string');

  // Step 1: Extract
  const paragraphs = extractParagraphs(docXml);
  const textParas = paragraphs.filter(p => p.text.length > 3);

  if (textParas.length === 0) {
    console.log('⚠️ Nessun testo trovato nel DOCX');
    return docxBuffer;
  }

  console.log(`📝 Paragrafi con testo: ${textParas.length} su ${paragraphs.length} totali`);

  // Step 2: Correct with batching
  const corrections = await correctParagraphsWithGemini(paragraphs);

  if (!corrections || corrections.size === 0) {
    console.log('⚠️ Gemini non ha restituito correzioni');
    return docxBuffer;
  }

  console.log(`✅ Paragrafi corretti: ${corrections.size}`);

  // Step 3: Apply corrections backwards
  const sortedIndices = [...corrections.keys()].sort((a, b) => b - a);

  for (const idx of sortedIndices) {
    const para = paragraphs[idx];
    const correctedText = corrections.get(idx);
    if (correctedText === para.text) continue;

    const correctedParaXml = applyParagraphCorrection(
      para.xml,
      correctedText,
      para.segments
    );

    docXml =
      docXml.substring(0, para.globalStart) +
      correctedParaXml +
      docXml.substring(para.globalStart + para.xml.length);
  }

  // Step 4: Save
  zip.file('word/document.xml', docXml);
  return await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  });
}

module.exports = {
  initGemini,
  correctDocxWithGemini,
  extractParagraphs,
  correctParagraphsWithGemini,
};
