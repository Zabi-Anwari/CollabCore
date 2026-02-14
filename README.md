<div align="center">
  <h1>Collaborative CRDT Editor</h1>
  <p>Real-time rich-text editing powered by a custom LSEQ CRDT and WebSocket sync.</p>
</div>

## 📌 Overview

This project is a browser-based collaborative editor built with React + Vite. Clients maintain the document locally using an LSEQ CRDT implementation and exchange operations over a lightweight Node.js WebSocket relay. The UI supports formatting (bold/italic/underline, font size & family), remote cursor indicators, undo/redo, bulk deletes, and text import/export.

## ✨ Features

- **Conflict-free collaboration** via a custom CRDT (Fractional/LSEQ indexing)
- **WebSocket transport** for bi-directional real-time sync
- **Rich-text attributes** (bold/italic/underline/font size/font family, incl. Times New Roman & Arial)
- **Remote cursor presence** with color/name labels
- **Undo/redo stacks** that replay CRDT operations
- **TXT/DOC export** using Mammoth for Word-compatible output

## 🛠 Tech Stack

- React 19 + Vite 6
- TypeScript
- Node.js WebSocket server (`ws`)
- Custom CRDT implementation (no external libs)

## 🚀 Getting Started

### Prerequisites

- Node.js 18+ (or any version that supports ES modules)
- npm (ships with Node) – or swap for pnpm/yarn if you prefer and update commands accordingly

### Installation & Local Development

```bash
git clone https://github.com/Zabi-Anwari/CollabCore.git
cd collab
npm install

# Runs Vite dev server + WebSocket relay concurrently
npm run dev
```

- Frontend dev server: http://localhost:5173 (Vite default)
- WebSocket relay: ws://localhost:8080

Open two browser tabs pointing at the same dev URL to test collaboration.

### Running Servers Separately (optional)

```bash
# Terminal 1 – WebSocket relay
node server.js

# Terminal 2 – Vite dev server
npm run dev -- --host
```

### Production Build

```bash
npm run build        # outputs static assets to dist/
npm run preview      # serves dist/ locally (still needs server.js running)
```

## 🌐 Deployment Notes

| Component  | How to host | Notes |
|------------|-------------|-------|
| `dist/` static bundle | Any static host (GitHub Pages, Vercel, Netlify, Azure Static Web Apps, etc.) | Remember to set `window.location.hostname` logic if serving behind custom domains. |
| `server.js` WebSocket relay | Any Node host that supports long-lived WebSocket connections (Railway, Render, Fly.io, Azure App Service, VM, etc.) | Must be publicly reachable; update the client to point to the deployed WebSocket URL. |

> ⚠️ GitHub Pages **cannot** run the WebSocket server. Deploy the frontend there and host `server.js` elsewhere, then update the client to use the public WebSocket endpoint.

## 📂 Project Structure (high-level)

```
│ App.tsx              # Shell UI & layout
│ components/Editor.tsx# Collaborative editor UI + CRDT orchestration
│ lib/crdt.ts          # LSEQ implementation (insert/delete/batch ops)
│ server.js            # Node.js WebSocket relay (broadcast hub)
│ types.ts             # Shared TypeScript types
│ package.json         # Scripts & dependencies
```

## 🤝 Contributing

1. Fork & clone
2. Create a feature branch (`git checkout -b feature/awesome`)
3. Commit with clear messages
4. Push & open a PR

## 📄 License

This project is licensed under the [MIT License](LICENSE).
