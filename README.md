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

