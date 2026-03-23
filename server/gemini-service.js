/* ============================================
   Gemini AI — Text Correction Service
   Paragraph-Based Approach (v2)
   ============================================ */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const JSZip = require('jszip');

const GEMINI_MODEL = 'gemini-3.1-pro-preview';

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
 * Each <w:p> element is a paragraph. We extract the text from each one
 * while preserving the XML structure for later replacement.
 */
function extractParagraphs(docXml) {
  const paragraphs = [];

  // Match each <w:p ...>...</w:p> block
  const paraRegex = /<w:p[\s>][\s\S]*?<\/w:p>/g;
  let match;

  while ((match = paraRegex.exec(docXml)) !== null) {
    const paraXml = match[0];
    const paraStart = match.index;

    // Extract all <w:t> text within this paragraph
    const textRegex = /<w:t([^>]*)>([^<]*)<\/w:t>/g;
    let textMatch;
    const segments = [];
    let fullText = '';

    while ((textMatch = textRegex.exec(paraXml)) !== null) {
      segments.push({
        fullMatch: textMatch[0],
        attrs: textMatch[1],
        text: textMatch[2],
        localIndex: textMatch.index, // position within paragraph XML
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
 * Send paragraphs to Gemini for correction in a single API call.
 * Uses a numbered list format so Gemini returns corrections aligned by index.
 */
async function correctParagraphsWithGemini(paragraphs) {
  if (!model) throw new Error('Gemini non configurato. Aggiungi GEMINI_API_KEY.');

  // Filter paragraphs with actual text content (skip empty ones)
  const textParagraphs = paragraphs
    .map((p, i) => ({ index: i, text: p.text }))
    .filter(p => p.text.length > 3);

  if (textParagraphs.length === 0) return null;

  // Build numbered list for Gemini
  const numberedList = textParagraphs
    .map((p, i) => `[${i}] ${p.text}`)
    .join('\n');

  // Truncate if too long (Gemini context limits)
  const maxChars = 25000;
  let listToSend = numberedList;
  if (listToSend.length > maxChars) {
    // Find the last complete paragraph within limit
    const cutoff = listToSend.lastIndexOf('\n[', maxChars);
    if (cutoff > 0) {
      listToSend = listToSend.substring(0, cutoff);
    }
  }

  const prompt = `Sei un esperto correttore di testi OCR in italiano.

Ti invio una lista numerata di paragrafi estratti da un PDF scansionato via OCR. Ogni riga inizia con [N] seguito dal testo del paragrafo.

REGOLE FONDAMENTALI:
1. Correggi SOLO gli errori evidenti dell'OCR (lettere confuse come m↔n, o↔0, l↔1, rn↔m, parole spezzate, ecc.)
2. NON cambiare il significato, lo stile o la struttura
3. NON aggiungere o rimuovere contenuto
4. NON unire o dividere paragrafi — mantieni ESATTAMENTE lo stesso numero di righe
5. Ogni riga della risposta DEVE iniziare con lo stesso [N] dell'input
6. Se un paragrafo è già corretto, ripetilo identico
7. Mantieni titoli, numerazione e riferimenti biblici intatti

PARAGRAFI DA CORREGGERE:
${listToSend}

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
    const idxMatch = line.match(/^\[(\d+)\]\s*(.*)/);
    if (idxMatch) {
      // Save previous
      if (currentIdx !== null) {
        corrections.set(currentIdx, currentText.trim());
      }
      currentIdx = parseInt(idxMatch[1], 10);
      currentText = idxMatch[2];
    } else if (currentIdx !== null) {
      // Continuation of previous paragraph (Gemini might wrap long lines)
      currentText += ' ' + line.trim();
    }
  }
  // Save last
  if (currentIdx !== null) {
    corrections.set(currentIdx, currentText.trim());
  }

  // Map corrections back to original paragraph indices
  const result_map = new Map();
  textParagraphs.forEach((p, i) => {
    if (corrections.has(i)) {
      result_map.set(p.index, corrections.get(i));
    }
  });

  return result_map;
}

/**
 * Apply corrected text to a single paragraph's XML.
 * Replaces text in <w:t> tags while preserving formatting.
 * Strategy: put all corrected text in the first <w:t> tag,
 * clear the rest. This preserves the paragraph's XML structure.
 */
function applyParagraphCorrection(paraXml, correctedText, segments) {
  if (segments.length === 0) return paraXml;

  let modifiedXml = paraXml;

  // Work backwards to preserve positions
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    let newText;

    if (i === 0) {
      // First segment gets all the corrected text
      newText = correctedText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    } else {
      // Other segments are emptied
      newText = '';
    }

    // Ensure xml:space="preserve" on the first tag to keep whitespace
    let attrs = seg.attrs;
    if (i === 0 && !attrs.includes('xml:space')) {
      attrs = ' xml:space="preserve"';
    }

    const newTag = `<w:t${attrs}>${newText}</w:t>`;
    modifiedXml =
      modifiedXml.substring(0, seg.localIndex) +
      newTag +
      modifiedXml.substring(seg.localIndex + seg.fullMatch.length);
  }

  return modifiedXml;
}

/**
 * Full pipeline: extract paragraphs → correct with Gemini → apply back
 */
async function correctDocxWithGemini(docxBuffer) {
  const zip = await JSZip.loadAsync(docxBuffer);
  let docXml = await zip.file('word/document.xml').async('string');

  // Step 1: Extract paragraphs
  const paragraphs = extractParagraphs(docXml);
  const textParas = paragraphs.filter(p => p.text.length > 3);

  if (textParas.length === 0) {
    console.log('⚠️ Nessun testo trovato nel DOCX');
    return docxBuffer;
  }

  console.log(`📝 Paragrafi con testo: ${textParas.length} su ${paragraphs.length} totali`);

  // Step 2: Get corrections from Gemini
  const corrections = await correctParagraphsWithGemini(paragraphs);

  if (!corrections || corrections.size === 0) {
    console.log('⚠️ Gemini non ha restituito correzioni');
    return docxBuffer;
  }

  console.log(`✅ Paragrafi corretti da Gemini: ${corrections.size}`);

  // Step 3: Apply corrections - work backwards to preserve positions
  const sortedIndices = [...corrections.keys()].sort((a, b) => b - a);

  for (const idx of sortedIndices) {
    const para = paragraphs[idx];
    const correctedText = corrections.get(idx);

    // Skip if text is identical (no correction needed)
    if (correctedText === para.text) continue;

    const correctedParaXml = applyParagraphCorrection(
      para.xml,
      correctedText,
      para.segments
    );

    // Replace in the document XML
    docXml =
      docXml.substring(0, para.globalStart) +
      correctedParaXml +
      docXml.substring(para.globalStart + para.xml.length);
  }

  // Step 4: Save back to ZIP
  zip.file('word/document.xml', docXml);
  const correctedBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  });

  return correctedBuffer;
}

module.exports = {
  initGemini,
  correctDocxWithGemini,
  extractParagraphs,
  correctParagraphsWithGemini,
};
