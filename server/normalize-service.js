/* ============================================
   Font Size Normalization Service
   Normalizza i font-size inconsistenti nei DOCX
   generati da OCR (Adobe PDF Services).
   Strategia: Moda Statistica + Heading Detection
   ============================================ */

const JSZip = require('jszip');

/**
 * Normalizza i font-size nel DOCX usando la strategia "Moda".
 * 1. Raccoglie tutti i <w:sz> dal documento
 * 2. Calcola il font-size più frequente (moda = "body text")
 * 3. Normalizza i run con size anomalo, preservando heading/titoli
 *
 * @param {Buffer} docxBuffer — DOCX come Buffer
 * @returns {Promise<Buffer>} — DOCX normalizzato
 */
async function normalizeDocxFontSize(docxBuffer) {
  const zip = await JSZip.loadAsync(docxBuffer);

  const docFile = zip.file('word/document.xml');
  if (!docFile) return docxBuffer; // Not a valid DOCX

  let docXml = await docFile.async('string');

  // --- Step 1: Collect all font sizes (half-points) ---
  const sizeRegex = /<w:sz\s+w:val="(\d+)"/g;
  const allSizes = [];
  let m;
  while ((m = sizeRegex.exec(docXml)) !== null) {
    allSizes.push(parseInt(m[1], 10));
  }

  if (allSizes.length < 3) return docxBuffer; // Too few runs to normalize

  // --- Step 2: Calculate MODE (most frequent size) ---
  const freq = new Map();
  for (const s of allSizes) {
    freq.set(s, (freq.get(s) || 0) + 1);
  }

  let modeSize = allSizes[0];
  let modeCount = 0;
  for (const [size, count] of freq) {
    if (count > modeCount) {
      modeSize = size;
      modeCount = count;
    }
  }

  // If the mode covers >90% of runs, nothing to fix
  if (modeCount / allSizes.length > 0.9) {
    console.log(`📐 Font size già uniforme (${modeSize / 2}pt, ${Math.round(modeCount / allSizes.length * 100)}% dei run)`);
    return docxBuffer;
  }

  // --- Step 3: Normalize run-by-run ---
  // Process each paragraph, skip headings
  const HEADING_PATTERN = /(?:Heading|heading|Titolo|titolo|Title|title|TOC|toc)/i;
  const MIN_DIFF = 4; // Minimum half-point difference to trigger normalization (2pt)

  let normalizedCount = 0;

  // Find all paragraphs and process them
  docXml = docXml.replace(
    /<w:p[\s>][\s\S]*?<\/w:p>/g,
    (paraXml) => {
      // Check if paragraph is a heading (skip normalization)
      if (HEADING_PATTERN.test(paraXml)) return paraXml;

      // Also detect heading by outline level
      if (/<w:outlineLvl\s/.test(paraXml)) return paraXml;

      // Normalize <w:sz> in this paragraph's runs
      return paraXml.replace(
        /<w:sz\s+w:val="(\d+)"/g,
        (match, val) => {
          const size = parseInt(val, 10);
          if (Math.abs(size - modeSize) >= MIN_DIFF) {
            normalizedCount++;
            return `<w:sz w:val="${modeSize}"`;
          }
          return match;
        }
      ).replace(
        // Also normalize szCs (complex script) for consistency
        /<w:szCs\s+w:val="(\d+)"/g,
        (match, val) => {
          const size = parseInt(val, 10);
          if (Math.abs(size - modeSize) >= MIN_DIFF) {
            return `<w:szCs w:val="${modeSize}"`;
          }
          return match;
        }
      );
    }
  );

  if (normalizedCount === 0) {
    console.log(`📐 Nessun font-size da normalizzare`);
    return docxBuffer;
  }

  // --- Step 4: Stats ---
  const otherSizes = [...freq.entries()]
    .filter(([s]) => Math.abs(s - modeSize) >= MIN_DIFF)
    .map(([s, c]) => `${s / 2}pt×${c}`)
    .join(', ');

  console.log(`📐 Normalizzati ${normalizedCount} run a ${modeSize / 2}pt (moda). Outlier: ${otherSizes}`);

  // --- Step 5: Repack ---
  zip.file('word/document.xml', docXml);
  return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ============================================
// Page Margin Normalization
// ============================================

// Margin presets (values in TWIPs: 1 cm = 567 twips)
const MARGIN_PRESETS = {
  normali: { top: 1417, bottom: 1417, left: 1417, right: 1417 },    // 2.5 cm
  stretti: { top: 720, bottom: 720, left: 720, right: 720 },        // 1.27 cm
  medi:    { top: 1417, bottom: 1417, left: 1077, right: 1077 },     // 2.5/1.9 cm
  larghi:  { top: 1417, bottom: 1417, left: 2880, right: 2880 },     // 2.5/5.08 cm
};

/**
 * Set page margins on all sections of a DOCX document.
 *
 * @param {Buffer} docxBuffer
 * @param {object} margins — { preset: 'normali' } or { top, bottom, left, right } in cm
 * @returns {Promise<Buffer>}
 */
async function setDocxMargins(docxBuffer, margins) {
  if (!margins) return docxBuffer;

  const zip = await JSZip.loadAsync(docxBuffer);
  const docFile = zip.file('word/document.xml');
  if (!docFile) return docxBuffer;

  let docXml = await docFile.async('string');

  // Resolve margin values (TWIPs)
  let tw;
  if (margins.preset && MARGIN_PRESETS[margins.preset]) {
    tw = MARGIN_PRESETS[margins.preset];
  } else if (margins.top != null) {
    // Custom values come in cm → convert to twips (1 cm = 567 twips)
    tw = {
      top: Math.round(parseFloat(margins.top) * 567),
      bottom: Math.round(parseFloat(margins.bottom) * 567),
      left: Math.round(parseFloat(margins.left) * 567),
      right: Math.round(parseFloat(margins.right) * 567),
    };
  } else {
    return docxBuffer; // No valid margins
  }

  // Replace all <w:pgMar> in all sections
  let count = 0;
  docXml = docXml.replace(
    /<w:pgMar\s[^/]*\/>/g,
    (match) => {
      count++;
      // Preserve header, footer, gutter from original
      const headerMatch = match.match(/w:header="(\d+)"/);
      const footerMatch = match.match(/w:footer="(\d+)"/);
      const gutterMatch = match.match(/w:gutter="(\d+)"/);
      const header = headerMatch ? headerMatch[1] : '720';
      const footer = footerMatch ? footerMatch[1] : '720';
      const gutter = gutterMatch ? gutterMatch[1] : '0';

      return `<w:pgMar w:top="${tw.top}" w:right="${tw.right}" w:bottom="${tw.bottom}" w:left="${tw.left}" w:header="${header}" w:footer="${footer}" w:gutter="${gutter}"/>`;
    }
  );

  if (count === 0) {
    console.log(`📏 Nessun <w:pgMar> trovato nel documento`);
    return docxBuffer;
  }

  const label = margins.preset || `${margins.top}/${margins.bottom}/${margins.left}/${margins.right}cm`;
  console.log(`📏 Margini impostati: ${label} (${count} sezioni)`);

  zip.file('word/document.xml', docXml);
  return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { normalizeDocxFontSize, setDocxMargins, MARGIN_PRESETS };
