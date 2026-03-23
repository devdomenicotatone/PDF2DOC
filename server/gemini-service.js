/* ============================================
   Gemini AI — Text Correction Service
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
 * Extract all text paragraphs from a DOCX buffer.
 * DOCX is a ZIP containing XML files. The main text is in word/document.xml.
 */
async function extractTextFromDocx(docxBuffer) {
  const zip = await JSZip.loadAsync(docxBuffer);
  const docXml = await zip.file('word/document.xml').async('string');

  // Extract text content between <w:t> tags
  const textRegex = /<w:t[^>]*>([^<]*)<\/w:t>/g;
  const paragraphs = [];
  let match;
  let currentParagraph = '';
  let lastIndex = 0;

  // Split by paragraph markers
  const paraRegex = /<w:p[\s>]/g;
  const paraPositions = [];
  while ((match = paraRegex.exec(docXml)) !== null) {
    paraPositions.push(match.index);
  }

  // Collect text per paragraph
  const fullText = [];
  const textMatches = [];
  while ((match = textRegex.exec(docXml)) !== null) {
    textMatches.push({ text: match[1], index: match.index });
    fullText.push(match[1]);
  }

  return {
    xml: docXml,
    zip: zip,
    fullText: fullText.join(''),
    textSegments: textMatches,
  };
}

/**
 * Send extracted text to Gemini for correction.
 * Returns the corrected text as a mapping of original → corrected segments.
 */
async function correctTextWithGemini(originalText) {
  if (!model) throw new Error('Gemini non configurato. Aggiungi GEMINI_API_KEY.');
  if (!originalText || originalText.trim().length < 10) return null;

  // Truncate very long texts (Gemini has context limits)
  const maxChars = 30000;
  const textToCorrect = originalText.length > maxChars
    ? originalText.substring(0, maxChars)
    : originalText;

  const prompt = `Sei un esperto correttore di testi OCR in italiano.

Ti viene fornito un testo estratto da un PDF scansionato tramite OCR. Il testo contiene probabilmente errori tipici dell'OCR:
- Lettere confuse (m↔n, o↔0, l↔1, rn↔m, ecc.)
- Parole spezzate o unite erroneamente
- Caratteri speciali al posto di lettere normali
- Numeri di sezione/paragrafo mal riconosciuti
- Possibili parentesi scambiate per numeri o viceversa

REGOLE:
1. Correggi SOLO gli errori evidenti dell'OCR
2. NON cambiare il significato, lo stile o la struttura del testo
3. NON aggiungere o rimuovere contenuto
4. Mantieni la stessa lunghezza approssimativa per ogni sezione
5. Se una parola è ambigua, usa il contesto per capire la correzione giusta
6. Mantieni titoli, numerazione e formattazione originale

TESTO OCR DA CORREGGERE:
---
${textToCorrect}
---

RISPONDI SOLO con il testo corretto, senza spiegazioni, senza markdown, senza commenti. Restituisci esattamente il testo corretto.`;

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1 },
  });

  const response = result.response;
  return response.text();
}

/**
 * Apply corrected text back into the DOCX XML.
 * Strategy: map corrected text back into <w:t> tags by position.
 */
async function applyCorrectionsToDocx(docxBuffer, correctedText) {
  const zip = await JSZip.loadAsync(docxBuffer);
  let docXml = await zip.file('word/document.xml').async('string');

  // Get original text segments
  const textRegex = /<w:t([^>]*)>([^<]*)<\/w:t>/g;
  const originalSegments = [];
  let match;
  while ((match = textRegex.exec(docXml)) !== null) {
    originalSegments.push({
      fullMatch: match[0],
      attrs: match[1],
      text: match[2],
      index: match.index,
    });
  }

  if (originalSegments.length === 0) return docxBuffer;

  // Build the original concatenated text for alignment
  const originalConcat = originalSegments.map(s => s.text).join('');

  // Simple proportional mapping: distribute corrected text across segments
  // keeping the same proportion of characters per segment
  const totalOrigLen = originalConcat.length;
  const totalCorrLen = correctedText.length;

  if (totalOrigLen === 0) return docxBuffer;

  let corrPos = 0;
  const newSegments = [];

  for (let i = 0; i < originalSegments.length; i++) {
    const seg = originalSegments[i];
    const origLen = seg.text.length;

    if (origLen === 0) {
      newSegments.push({ ...seg, newText: '' });
      continue;
    }

    // Calculate proportional length in corrected text
    const proportion = origLen / totalOrigLen;
    let corrLen;

    if (i === originalSegments.length - 1) {
      // Last segment takes all remaining
      corrLen = correctedText.length - corrPos;
    } else {
      corrLen = Math.round(proportion * totalCorrLen);
    }

    // Try to break at word boundaries
    let endPos = corrPos + corrLen;
    if (endPos < correctedText.length && i < originalSegments.length - 1) {
      // Look for nearest space within ±5 chars
      for (let delta = 0; delta <= 5; delta++) {
        if (endPos + delta < correctedText.length && correctedText[endPos + delta] === ' ') {
          endPos = endPos + delta;
          break;
        }
        if (endPos - delta >= corrPos && correctedText[endPos - delta] === ' ') {
          endPos = endPos - delta;
          break;
        }
      }
    }

    endPos = Math.min(endPos, correctedText.length);
    const newText = correctedText.substring(corrPos, endPos);
    newSegments.push({ ...seg, newText });
    corrPos = endPos;
  }

  // Apply replacements (in reverse order to preserve positions)
  let modifiedXml = docXml;
  for (let i = newSegments.length - 1; i >= 0; i--) {
    const seg = newSegments[i];
    // Escape XML entities
    const escapedText = seg.newText
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    const newTag = `<w:t${seg.attrs}>${escapedText}</w:t>`;
    modifiedXml =
      modifiedXml.substring(0, seg.index) +
      newTag +
      modifiedXml.substring(seg.index + seg.fullMatch.length);
  }

  // Save back to ZIP
  zip.file('word/document.xml', modifiedXml);
  const correctedBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  });

  return correctedBuffer;
}

/**
 * Full pipeline: extract text → correct with Gemini → apply back to DOCX
 */
async function correctDocxWithGemini(docxBuffer) {
  // Step 1: Extract text
  const { fullText } = await extractTextFromDocx(docxBuffer);

  if (!fullText || fullText.trim().length < 20) {
    console.log('⚠️ Testo insufficiente per correzione Gemini');
    return docxBuffer; // Return unchanged
  }

  console.log(`📝 Testo estratto: ${fullText.length} caratteri`);

  // Step 2: Correct with Gemini
  const correctedText = await correctTextWithGemini(fullText);

  if (!correctedText) {
    console.log('⚠️ Gemini non ha restituito correzioni');
    return docxBuffer;
  }

  console.log(`✅ Testo corretto: ${correctedText.length} caratteri`);

  // Step 3: Apply corrections back to DOCX
  const correctedDocx = await applyCorrectionsToDocx(docxBuffer, correctedText);

  return correctedDocx;
}

module.exports = {
  initGemini,
  correctDocxWithGemini,
  extractTextFromDocx,
  correctTextWithGemini,
};
