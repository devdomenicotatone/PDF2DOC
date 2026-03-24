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

// ============================================
// Font Family
// ============================================

const FONT_PRESETS = {
  'times':     'Times New Roman',
  'arial':     'Arial',
  'calibri':   'Calibri',
  'courier':   'Courier New',
  'georgia':   'Georgia',
  'verdana':   'Verdana',
  'garamond':  'Garamond',
  'trebuchet': 'Trebuchet MS',
};

/**
 * Change all fonts in the DOCX to the specified font family.
 */
async function setDocxFontFamily(docxBuffer, fontKey) {
  if (!fontKey || !FONT_PRESETS[fontKey]) return docxBuffer;

  const fontName = FONT_PRESETS[fontKey];
  const zip = await JSZip.loadAsync(docxBuffer);
  const docFile = zip.file('word/document.xml');
  if (!docFile) return docxBuffer;

  let docXml = await docFile.async('string');
  let count = 0;

  // Replace w:rFonts (run fonts)
  docXml = docXml.replace(
    /<w:rFonts\s[^/]*\/>/g,
    () => {
      count++;
      return `<w:rFonts w:ascii="${fontName}" w:hAnsi="${fontName}" w:cs="${fontName}"/>`;
    }
  );

  if (count === 0) {
    console.log(`🔤 Nessun <w:rFonts> trovato`);
    return docxBuffer;
  }

  console.log(`🔤 Font cambiato: ${fontName} (${count} run)`);
  zip.file('word/document.xml', docXml);
  return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ============================================
// Font Size Scaling
// ============================================

/**
 * Scale all font sizes in the DOCX to a target body size.
 * Preserves relative differences (headings stay proportionally bigger).
 * @param {Buffer} docxBuffer
 * @param {number} targetPt — target body text size in points (e.g. 11, 12)
 */
async function setDocxFontSize(docxBuffer, targetPt) {
  if (!targetPt || targetPt < 6 || targetPt > 36) return docxBuffer;

  const targetHalf = Math.round(targetPt * 2); // DOCX uses half-points
  const zip = await JSZip.loadAsync(docxBuffer);
  const docFile = zip.file('word/document.xml');
  if (!docFile) return docxBuffer;

  let docXml = await docFile.async('string');

  // Find the current mode (most frequent size) to calculate ratio
  const sizeRegex = /<w:sz\s+w:val="(\d+)"/g;
  const freq = new Map();
  let m;
  while ((m = sizeRegex.exec(docXml)) !== null) {
    const s = parseInt(m[1], 10);
    freq.set(s, (freq.get(s) || 0) + 1);
  }

  if (freq.size === 0) return docxBuffer;

  let modeSize = 24; // default 12pt
  let modeCount = 0;
  for (const [size, count] of freq) {
    if (count > modeCount) { modeSize = size; modeCount = count; }
  }

  const ratio = targetHalf / modeSize;
  if (Math.abs(ratio - 1) < 0.05) {
    console.log(`🔠 Font size già a ~${targetPt}pt`);
    return docxBuffer;
  }

  let count = 0;
  // Scale w:sz and w:szCs
  docXml = docXml.replace(
    /<w:sz\s+w:val="(\d+)"/g,
    (match, val) => {
      const scaled = Math.round(parseInt(val, 10) * ratio);
      const clamped = Math.max(12, Math.min(144, scaled)); // 6pt–72pt
      count++;
      return `<w:sz w:val="${clamped}"`;
    }
  );
  docXml = docXml.replace(
    /<w:szCs\s+w:val="(\d+)"/g,
    (match, val) => {
      const scaled = Math.round(parseInt(val, 10) * ratio);
      const clamped = Math.max(12, Math.min(144, scaled));
      return `<w:szCs w:val="${clamped}"`;
    }
  );

  console.log(`🔠 Font-size scalato: ${modeSize / 2}pt → ${targetPt}pt (ratio ${ratio.toFixed(2)}, ${count} run)`);
  zip.file('word/document.xml', docXml);
  return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ============================================
// Line Spacing
// ============================================

// Line spacing values (in 240ths of a line)
const LINE_SPACING_PRESETS = {
  'singola': 240,   // 1.0
  '1.15':    276,   // 1.15
  '1.5':     360,   // 1.5
  'doppia':  480,   // 2.0
};

/**
 * Set line spacing for all paragraphs in the DOCX.
 */
async function setDocxLineSpacing(docxBuffer, spacingKey) {
  if (!spacingKey || !LINE_SPACING_PRESETS[spacingKey]) return docxBuffer;

  const lineVal = LINE_SPACING_PRESETS[spacingKey];
  const zip = await JSZip.loadAsync(docxBuffer);
  const docFile = zip.file('word/document.xml');
  if (!docFile) return docxBuffer;

  let docXml = await docFile.async('string');
  let replaced = 0;
  let added = 0;

  // Replace existing w:spacing with line attribute
  docXml = docXml.replace(
    /<w:spacing\s([^/]*)\/?>/g,
    (match, attrs) => {
      replaced++;
      // Remove existing line/lineRule, keep before/after
      const cleaned = attrs
        .replace(/w:line="[^"]*"/g, '')
        .replace(/w:lineRule="[^"]*"/g, '')
        .trim();
      return `<w:spacing ${cleaned} w:line="${lineVal}" w:lineRule="auto"/>`;
    }
  );

  // For paragraphs without w:spacing, add it inside w:pPr
  if (replaced === 0) {
    docXml = docXml.replace(
      /<w:pPr>([\s\S]*?)<\/w:pPr>/g,
      (match, inner) => {
        if (inner.includes('<w:spacing')) return match;
        added++;
        return `<w:pPr>${inner}<w:spacing w:line="${lineVal}" w:lineRule="auto"/></w:pPr>`;
      }
    );
  }

  console.log(`📝 Interlinea: ${spacingKey} (${replaced + added} paragrafi)`);
  zip.file('word/document.xml', docXml);
  return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ============================================
// Page Size
// ============================================

const PAGE_SIZE_PRESETS = {
  'a4':     { w: 11906, h: 16838 },  // 210 × 297 mm
  'letter': { w: 12240, h: 15840 },  // 8.5 × 11 in
  'legal':  { w: 12240, h: 20160 },  // 8.5 × 14 in
  'a3':     { w: 16838, h: 23811 },  // 297 × 420 mm
};

/**
 * Set page size on all sections of a DOCX.
 */
async function setDocxPageSize(docxBuffer, sizeKey) {
  if (!sizeKey || !PAGE_SIZE_PRESETS[sizeKey]) return docxBuffer;

  const pgSize = PAGE_SIZE_PRESETS[sizeKey];
  const zip = await JSZip.loadAsync(docxBuffer);
  const docFile = zip.file('word/document.xml');
  if (!docFile) return docxBuffer;

  let docXml = await docFile.async('string');
  let count = 0;

  docXml = docXml.replace(
    /<w:pgSz\s[^/]*\/>/g,
    (match) => {
      count++;
      // Preserve orientation if present
      const orientMatch = match.match(/w:orient="([^"]*)"/);
      const orient = orientMatch ? ` w:orient="${orientMatch[1]}"` : '';
      return `<w:pgSz w:w="${pgSize.w}" w:h="${pgSize.h}"${orient}/>`;
    }
  );

  if (count === 0) {
    console.log(`📄 Nessun <w:pgSz> trovato`);
    return docxBuffer;
  }

  console.log(`📄 Formato pagina: ${sizeKey.toUpperCase()} (${count} sezioni)`);
  zip.file('word/document.xml', docXml);
  return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ============================================
// Tier 2: Paragraph Spacing
// ============================================

const PARA_SPACING_PRESETS = {
  'compatto':  { before: 0, after: 0 },
  'stretto':   { before: 60, after: 60 },    // 3pt / 3pt
  'normale':   { before: 0, after: 160 },     // 0pt / 8pt (Word default)
  'rilassato': { before: 120, after: 200 },   // 6pt / 10pt
  'largo':     { before: 240, after: 240 },   // 12pt / 12pt
};

/**
 * Set paragraph spacing (before/after) for all paragraphs.
 * Values in twips (1pt = 20 twips).
 */
async function setDocxParagraphSpacing(docxBuffer, spacingKey) {
  if (!spacingKey || !PARA_SPACING_PRESETS[spacingKey]) return docxBuffer;

  const sp = PARA_SPACING_PRESETS[spacingKey];
  const zip = await JSZip.loadAsync(docxBuffer);
  const docFile = zip.file('word/document.xml');
  if (!docFile) return docxBuffer;

  let docXml = await docFile.async('string');
  let replaced = 0;
  let added = 0;

  // Update existing w:spacing before/after (preserve line/lineRule)
  docXml = docXml.replace(
    /<w:spacing\s([^/]*)\/?>/g,
    (match, attrs) => {
      replaced++;
      const cleaned = attrs
        .replace(/w:before="[^"]*"/g, '')
        .replace(/w:after="[^"]*"/g, '')
        .replace(/w:beforeAutospacing="[^"]*"/g, '')
        .replace(/w:afterAutospacing="[^"]*"/g, '')
        .trim();
      return `<w:spacing w:before="${sp.before}" w:after="${sp.after}" ${cleaned}/>`;
    }
  );

  // For paragraphs with w:pPr but no w:spacing
  if (replaced === 0) {
    docXml = docXml.replace(
      /<w:pPr>([\s\S]*?)<\/w:pPr>/g,
      (match, inner) => {
        if (inner.includes('<w:spacing')) return match;
        added++;
        return `<w:pPr>${inner}<w:spacing w:before="${sp.before}" w:after="${sp.after}"/></w:pPr>`;
      }
    );
  }

  console.log(`↕️ Spaziatura paragrafi: ${spacingKey} (${replaced + added} paragrafi)`);
  zip.file('word/document.xml', docXml);
  return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ============================================
// Tier 2: Text Alignment
// ============================================

const TEXT_ALIGNMENT_MAP = {
  'sinistra':    'left',
  'centro':      'center',
  'destra':      'right',
  'giustificato':'both',
};

/**
 * Set text alignment for all non-heading paragraphs.
 */
async function setDocxTextAlignment(docxBuffer, alignKey) {
  if (!alignKey || !TEXT_ALIGNMENT_MAP[alignKey]) return docxBuffer;

  const jcVal = TEXT_ALIGNMENT_MAP[alignKey];
  const zip = await JSZip.loadAsync(docxBuffer);
  const docFile = zip.file('word/document.xml');
  if (!docFile) return docxBuffer;

  let docXml = await docFile.async('string');
  const HEADING_PATTERN = /(?:Heading|heading|Titolo|titolo|Title|title)/i;
  let count = 0;

  docXml = docXml.replace(
    /<w:p[\s>][\s\S]*?<\/w:p>/g,
    (paraXml) => {
      // Skip headings
      if (HEADING_PATTERN.test(paraXml)) return paraXml;
      if (/<w:outlineLvl\s/.test(paraXml)) return paraXml;

      // If has w:pPr, update/add w:jc inside it
      if (paraXml.includes('<w:pPr>') || paraXml.includes('<w:pPr ')) {
        if (/<w:jc\s/.test(paraXml)) {
          count++;
          return paraXml.replace(/<w:jc\s+w:val="[^"]*"\/?>/, `<w:jc w:val="${jcVal}"/>`);
        } else {
          count++;
          return paraXml.replace(/<\/w:pPr>/, `<w:jc w:val="${jcVal}"/></w:pPr>`);
        }
      }

      // No w:pPr — add one with jc
      if (paraXml.includes('<w:r')) {
        count++;
        return paraXml.replace(/<w:r/, `<w:pPr><w:jc w:val="${jcVal}"/></w:pPr><w:r`);
      }
      return paraXml;
    }
  );

  console.log(`↔️ Allineamento: ${alignKey} (${count} paragrafi)`);
  zip.file('word/document.xml', docXml);
  return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ============================================
// Tier 2: Remove Images
// ============================================

/**
 * Remove all images from the DOCX (for a text-only version).
 * Removes <w:drawing> and <w:pict> elements.
 */
async function removeDocxImages(docxBuffer) {
  const zip = await JSZip.loadAsync(docxBuffer);
  const docFile = zip.file('word/document.xml');
  if (!docFile) return docxBuffer;

  let docXml = await docFile.async('string');
  let count = 0;

  // Remove <w:drawing>...</w:drawing>
  docXml = docXml.replace(/<w:drawing>[\s\S]*?<\/w:drawing>/g, () => { count++; return ''; });

  // Remove <w:pict>...</w:pict>
  docXml = docXml.replace(/<w:pict>[\s\S]*?<\/w:pict>/g, () => { count++; return ''; });

  // Remove empty runs left behind
  docXml = docXml.replace(/<w:r>\s*<w:rPr>[\s\S]*?<\/w:rPr>\s*<\/w:r>/g, '');

  // Remove empty paragraphs (no text, no runs)
  docXml = docXml.replace(/<w:p[\s>][^]*?<\/w:p>/g, (para) => {
    if (!/<w:t[\s>]/.test(para) && !/<w:r[\s>]/.test(para)) return '';
    return para;
  });

  if (count === 0) {
    console.log(`🖼️ Nessuna immagine trovata`);
    return docxBuffer;
  }

  // Also remove image files from media folder
  const mediaFiles = Object.keys(zip.files).filter(f => f.startsWith('word/media/'));
  for (const f of mediaFiles) zip.remove(f);

  console.log(`🖼️ Rimosse ${count} immagini (+ ${mediaFiles.length} file media)`);
  zip.file('word/document.xml', docXml);
  return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ============================================
// Tier 2: Page Numbers
// ============================================

/**
 * Add page numbers to all sections.
 * Creates/updates footer with centered page number.
 */
async function addDocxPageNumbers(docxBuffer, position = 'centro') {
  const zip = await JSZip.loadAsync(docxBuffer);
  const docFile = zip.file('word/document.xml');
  if (!docFile) return docxBuffer;

  let docXml = await docFile.async('string');

  // Check if footer already exists
  const existingFooter = zip.file('word/footer_pagenum.xml');
  const footerFile = 'word/footer_pagenum.xml';
  const rId = 'rIdPageNumFooter';

  const jcVal = TEXT_ALIGNMENT_MAP[position] || 'center';

  // Create footer XML with PAGE field
  const footerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:p>
    <w:pPr><w:jc w:val="${jcVal}"/></w:pPr>
    <w:r>
      <w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>
      <w:fldChar w:fldCharType="begin"/>
    </w:r>
    <w:r>
      <w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>
      <w:instrText xml:space="preserve"> PAGE </w:instrText>
    </w:r>
    <w:r>
      <w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>
      <w:fldChar w:fldCharType="end"/>
    </w:r>
  </w:p>
</w:ftr>`;

  zip.file(footerFile, footerXml);

  // Add relationship in word/_rels/document.xml.rels
  const relsFile = zip.file('word/_rels/document.xml.rels');
  if (relsFile) {
    let relsXml = await relsFile.async('string');
    // Remove existing reference if present
    relsXml = relsXml.replace(new RegExp(`<Relationship[^>]*Id="${rId}"[^>]*/>`, 'g'), '');
    // Add new relationship before </Relationships>
    relsXml = relsXml.replace(
      '</Relationships>',
      `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer_pagenum.xml"/></Relationships>`
    );
    zip.file('word/_rels/document.xml.rels', relsXml);
  }

  // Reference footer in all sectPr
  docXml = docXml.replace(
    /<w:sectPr[\s>]/g,
    (match) => {
      return `${match.slice(0, -1)}><w:footerReference w:type="default" r:id="${rId}"/>`;
    }
  );

  // Ensure [Content_Types].xml includes footer content type
  const ctFile = zip.file('[Content_Types].xml');
  if (ctFile) {
    let ctXml = await ctFile.async('string');
    if (!ctXml.includes('footer_pagenum.xml')) {
      ctXml = ctXml.replace(
        '</Types>',
        `<Override PartName="/word/footer_pagenum.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`
      );
      zip.file('[Content_Types].xml', ctXml);
    }
  }

  console.log(`🔢 Numerazione pagine aggiunta (${position})`);
  zip.file('word/document.xml', docXml);
  return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = {
  normalizeDocxFontSize,
  setDocxMargins, MARGIN_PRESETS,
  setDocxFontFamily, FONT_PRESETS,
  setDocxFontSize,
  setDocxLineSpacing, LINE_SPACING_PRESETS,
  setDocxPageSize, PAGE_SIZE_PRESETS,
  setDocxParagraphSpacing, PARA_SPACING_PRESETS,
  setDocxTextAlignment, TEXT_ALIGNMENT_MAP,
  removeDocxImages,
  addDocxPageNumbers,
};
