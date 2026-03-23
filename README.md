# PDF2DOC 📄➡️📝

Webapp professionale per convertire PDF in DOCX con qualità Adobe.  
Supporta **OCR automatico** per PDF scansionati e **correzione AI** con Gemini.

> 🎁 **500 conversioni gratuite/mese** per utente con Adobe PDF Services API

## Architettura

```
Frontend (Browser)  →  Backend (Node.js/Render)  →  Adobe PDF Services API
                                                 →  Gemini 3.1 Pro (correzione AI)
```

## Flusso di conversione

| Modalità | Cosa fa | Transazioni Adobe |
|---|---|---|
| **Base** | PDF → DOCX (Adobe Export) | 1 |
| **OCR** | PDF → DOCX con riconoscimento testo | 1 |
| **OCR + Gemini** | PDF → DOCX → AI corregge errori OCR | 1 Adobe + 1 Gemini |

### Come funziona la correzione AI

1. **Adobe** converte il PDF in DOCX preservando immagini e layout
2. **Gemini 3.1 Pro** estrae il testo dal DOCX, lo corregge contestualmente (errori OCR come lettere confuse, parole spezzate), e lo rimappa nel documento
3. Il risultato è un DOCX con **immagini preservate** e **testo corretto**

## Quick Start (10 minuti)

### 1. 🔑 Credenziali (gratis)

**Adobe PDF Services:**
1. Registrati su [Adobe Developer Console](https://developer.adobe.com/console)
2. Crea un progetto → Aggiungi **"PDF Services API"** → **OAuth Server-to-Server**
3. Copia **Client ID** e **Client Secret**

**Gemini AI (opzionale ma consigliato):**
1. Vai su [Google AI Studio](https://aistudio.google.com/apikey)
2. Crea una API key gratuita

### 2. 🚀 Deploy Backend su Render (gratis)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/devdomenicotatone/PDF2DOC)

Oppure manualmente:

1. Fai **Fork** di questo repo
2. Su [Render](https://render.com): New → Web Service → seleziona il tuo fork
3. Configura:
   - **Root Directory**: `server`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. Aggiungi le variabili d'ambiente:
   - `PDF_SERVICES_CLIENT_ID` → Client ID Adobe
   - `PDF_SERVICES_CLIENT_SECRET` → Client Secret Adobe
   - `API_ACCESS_KEY` → scegli una password per proteggere il server
   - `GEMINI_API_KEY` → (opzionale) API key di Google AI Studio

### 3. 🌐 Usa la Webapp

1. Apri la webapp (GitHub Pages, Render, o `localhost:3000`)
2. Clicca **⚙️ Impostazioni Backend** → inserisci URL e password
3. Attiva/disattiva **OCR** e **Correzione AI (Gemini)** dal pannello opzioni
4. Carica un PDF e converti! 🎉

## 🔒 Sicurezza

- **Password**: ogni richiesta API richiede la password (`API_ACCESS_KEY`)
- **Credenziali**: Adobe e Gemini API key mai esposte, solo sul server
- **Self-hosted**: ogni utente usa le proprie credenziali e il proprio server

### Uso locale (sviluppo)

```bash
cd server
cp .env.example .env   # inserisci credenziali + password + Gemini key
npm install
npm start              # backend + frontend su http://localhost:3000
```

## Funzionalità

- ✅ Conversione PDF → DOCX professionale (Adobe)
- ✅ OCR integrato per PDF scansionati
- ✅ **Correzione AI** — Gemini 3.1 Pro corregge errori OCR contestualmente
- ✅ Preserva immagini, tabelle e layout
- ✅ Toggle OCR e Gemini indipendenti nell'interfaccia
- ✅ Drag & drop con design premium mobile-first
- ✅ **Protetto da password**
- ✅ **Self-hosted** — ogni utente usa le proprie credenziali

## Tech Stack

| Componente | Tecnologia |
|---|---|
| Frontend | HTML5, CSS3 (Glassmorphism), vanilla JS |
| Backend | Node.js, Express.js |
| Conversione | Adobe PDF Services REST API |
| AI Correction | Google Gemini 3.1 Pro Preview |
| Auth | API Key (header `x-api-key`) |
| Deploy | GitHub Pages + Render (free tier) |

## License

MIT
