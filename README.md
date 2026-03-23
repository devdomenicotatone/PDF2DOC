# PDF2DOC 📄➡️📝

Webapp professionale per convertire PDF in DOCX con qualità Adobe.  
Supporta **OCR automatico** per PDF scansionati (immagini → testo modificabile).

> 🎁 **500 conversioni gratuite/mese** per utente con Adobe PDF Services API

## Architettura

Ogni utente deploya la propria istanza:

```
Tuo Frontend (GitHub Pages)  →  Tuo Backend (Render)  →  Adobe PDF Services API
                                  (le tue credenziali)
                                  (protetto da password)
```

## Quick Start (10 minuti)

### 1. 🔑 Credenziali Adobe (gratis)

1. Registrati su [Adobe Developer Console](https://developer.adobe.com/console)
2. Crea un progetto → Aggiungi **"PDF Services API"**
3. Seleziona **"OAuth Server-to-Server"**
4. Copia **Client ID** e **Client Secret**

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
   - `PDF_SERVICES_CLIENT_ID` → il tuo Client ID Adobe
   - `PDF_SERVICES_CLIENT_SECRET` → il tuo Client Secret Adobe
   - `API_ACCESS_KEY` → scegli una password per proteggere il tuo server

### 3. 🌐 Usa la Webapp

1. Apri la webapp (GitHub Pages, Render, o `localhost:3000`)
2. Clicca **⚙️ Impostazioni Backend** in basso
3. Inserisci l'URL del tuo servizio Render (es. `https://tuo-nome.onrender.com`)
4. Inserisci la **password** che hai scelto come `API_ACCESS_KEY`
5. Clicca **Salva Impostazioni** (la password è salvata localmente sul dispositivo)
6. Carica un PDF e converti! 🎉

## 🔒 Protezione

Il backend è protetto da una **password** (variabile `API_ACCESS_KEY` su Render):

- ✅ Chi conosce la password → può convertire
- ❌ Chi non la conosce → errore 401 "Password non valida"
- 🔐 Credenziali Adobe → mai esposte, solo sul server
- 💾 Password salvata in localStorage → inserisci una volta, funziona sempre

### Uso locale (sviluppo)

```bash
cd server
cp .env.example .env   # inserisci credenziali Adobe + password
npm install
npm start              # backend + frontend su http://localhost:3000
```

Apri `http://localhost:3000` nel browser → inserisci la password → converti!

## Funzionalità

- ✅ Conversione PDF → DOCX professionale (Adobe)
- ✅ OCR integrato per PDF scansionati
- ✅ Preserva immagini, tabelle e layout
- ✅ Drag & drop con design premium mobile-first
- ✅ Cross-platform: Windows, Mac, Linux, mobile
- ✅ **Protetto da password** — solo utenti autorizzati
- ✅ **Self-hosted** — ognuno usa le proprie credenziali e il proprio server

## Tech Stack

| Componente | Tecnologia |
|---|---|
| Frontend | HTML5, CSS3 (Glassmorphism), vanilla JS |
| Backend | Node.js, Express.js |
| API | Adobe PDF Services REST API |
| Auth | API Key (header `x-api-key`) |
| Deploy | GitHub Pages + Render (free tier) |

## License

MIT
