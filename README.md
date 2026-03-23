# PDF2DOC 📄➡️📝

Webapp professionale per convertire PDF in DOCX con qualità Adobe.  
Supporta **OCR automatico** per PDF scansionati (immagini → testo modificabile).

## Architettura

```
Frontend (GitHub Pages)  →  Backend (Render/Node.js)  →  Adobe PDF Services API
```

## Setup Rapido

### 1. Credenziali Adobe (gratis)

1. Vai su [Adobe Developer Console](https://developer.adobe.com/console)
2. Crea un progetto → Aggiungi **"PDF Services API"**
3. Copia **Client ID** e **Client Secret**

> 🎁 500 transazioni gratuite al mese — nessuna carta di credito richiesta!

### 2. Backend

```bash
cd server
cp .env.example .env
# Modifica .env con le tue credenziali Adobe

npm install
npm start
```

Il server sarà su `http://localhost:3000`

### 3. Frontend

Apri `index.html` nel browser. Nelle impostazioni (⚙️), imposta l'URL del backend.

## Deploy

### Frontend → GitHub Pages

1. Carica `index.html`, `style.css`, `app.js` su un repo GitHub
2. Settings → Pages → Deploy from main branch

### Backend → Render (gratis)

1. Carica la cartella `server/` su un repo GitHub separato
2. Su [Render](https://render.com): New → Web Service → collega il repo
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Aggiungi le variabili d'ambiente:
   - `PDF_SERVICES_CLIENT_ID`
   - `PDF_SERVICES_CLIENT_SECRET`

## Funzionalità

- ✅ Conversione PDF → DOCX professionale (Adobe)
- ✅ OCR integrato per PDF scansionati
- ✅ Preserva immagini, tabelle e layout
- ✅ Drag & drop
- ✅ Mobile-first, responsive
- ✅ Funziona su Windows, Mac, Linux, mobile
- ✅ 500 conversioni gratis/mese

## Tech Stack

| Componente | Tecnologia |
|---|---|
| Frontend | HTML5, CSS3 (Glassmorphism), vanilla JS |
| Backend | Node.js, Express.js |
| API | Adobe PDF Services REST API |
| Deploy | GitHub Pages + Render |
