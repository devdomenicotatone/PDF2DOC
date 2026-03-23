/* ============================================
   Adobe PDF Services — API Integration Module
   ============================================ */

const TOKEN_ENDPOINT = 'https://ims-na1.adobelogin.com/ims/token/v3';
const UPLOAD_ENDPOINT = 'https://pdf-services.adobe.io/assets';
const EXPORT_ENDPOINT = 'https://pdf-services.adobe.io/operation/exportpdf';
const OCR_ENDPOINT = 'https://pdf-services.adobe.io/operation/ocr';

let cachedToken = null;
let tokenExpiry = 0;

/**
 * Get OAuth access token (with caching)
 */
async function getAccessToken(clientId, clientSecret) {
  // Return cached token if still valid (with 5 min buffer)
  if (cachedToken && Date.now() < tokenExpiry - 300000) {
    return cachedToken;
  }

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
      scope: 'openid,AdobeID,DCAPI',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Adobe auth failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

/**
 * Upload a PDF buffer to Adobe as an asset
 * Returns { assetID, uploadUri }
 */
async function uploadAsset(token, clientId, pdfBuffer, mimeType = 'application/pdf') {
  // Step 1: Request upload URI
  const res = await fetch(UPLOAD_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'x-api-key': clientId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      mediaType: mimeType,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Adobe upload init failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const uploadUri = data.uploadUri;
  const assetID = data.assetID;

  // Step 2: Upload the file to the presigned URI
  const uploadRes = await fetch(uploadUri, {
    method: 'PUT',
    headers: {
      'Content-Type': mimeType,
    },
    body: pdfBuffer,
  });

  if (!uploadRes.ok) {
    throw new Error(`Adobe file upload failed (${uploadRes.status})`);
  }

  return { assetID, uploadUri };
}

/**
 * Start Export PDF → DOCX job
 * Returns the job polling URL (Location header)
 */
async function exportPdfToDocx(token, clientId, assetID, withOCR = false) {
  const body = {
    assetID: assetID,
    targetFormat: 'docx',
  };

  if (withOCR) {
    body.ocrLang = 'it-IT'; // Italian OCR
  }

  const res = await fetch(EXPORT_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'x-api-key': clientId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Adobe export job failed (${res.status}): ${text}`);
  }

  // The Location header contains the polling URL
  const location = res.headers.get('location') || res.headers.get('x-request-id');

  if (res.status === 201) {
    // Job created, return polling URL from location header
    return location;
  }

  // Fallback: try body
  const data = await res.json().catch(() => ({}));
  return data.location || location;
}

/**
 * Poll a job until completion
 * Returns the result asset download URI
 */
async function pollJob(token, clientId, jobUrl, maxAttempts = 60) {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(jobUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'x-api-key': clientId,
      },
    });

    if (res.status === 200) {
      const data = await res.json();

      if (data.status === 'done' || data.status === 'succeeded') {
        // Get download URI from the result
        const asset = data.asset || data.content || (data.result && data.result.asset);
        if (asset && asset.downloadUri) {
          return asset.downloadUri;
        }
        // Try alternate format
        if (data.downloadUri) return data.downloadUri;
        throw new Error('Conversione completata ma manca il link di download.');
      }

      if (data.status === 'failed') {
        throw new Error(`Conversione fallita: ${data.error?.message || JSON.stringify(data)}`);
      }

      // Still in progress
    } else if (res.status === 202) {
      // Still in progress
    } else {
      const text = await res.text();
      throw new Error(`Polling failed (${res.status}): ${text}`);
    }

    // Wait 2 seconds before next poll
    await new Promise((r) => setTimeout(r, 2000));
  }

  throw new Error('Timeout: la conversione ha impiegato troppo tempo (2+ minuti).');
}

/**
 * Download the converted file
 * Returns a Buffer
 */
async function downloadResult(downloadUri) {
  const res = await fetch(downloadUri);

  if (!res.ok) {
    throw new Error(`Download failed (${res.status})`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = {
  getAccessToken,
  uploadAsset,
  exportPdfToDocx,
  pollJob,
  downloadResult,
};
