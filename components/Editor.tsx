import React, { useEffect, useRef, useState, useCallback, useImperativeHandle, useLayoutEffect } from 'react';
import { LSEQ } from '../lib/crdt';
import { Collaborator, CRDTOperation, CRDTAttributes, CRDTChar } from '../types';

export interface EditorHandle {
  importText: (text: string) => void;
}

interface RemoteCursor {
  cursor: number;
  name: string;
  color: string;
  lastSeen: number;
}

interface UndoOperation {
  type: 'insert' | 'delete' | 'format';
  char: CRDTChar;
  prevAttributes?: CRDTAttributes;
}

type UndoBatch = UndoOperation[];

interface EditorProps {
  user: Collaborator;
  channelName: string;
  darkMode?: boolean;
  ref?: React.Ref<EditorHandle>;
  onActiveUsersChange?: (users: Collaborator[]) => void;
}

const FONT_SIZES = ['12px', '14px', '16px', '18px', '24px', '32px', '48px'];
const FONT_FAMILIES = [
  { name: 'Sans', value: 'Inter, system-ui, sans-serif' },
  { name: 'Serif', value: 'Georgia, serif' },
  { name: 'Times New Roman', value: '"Times New Roman", Times, serif' },
  { name: 'Arial', value: 'Arial, Helvetica, sans-serif' },
  { name: 'Mono', value: 'JetBrains Mono, monospace' }
];

const CURSOR_TIMEOUT = 5000;

const escapeHTML = (text: string) => {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

const Editor: React.FC<EditorProps> = ({ user, channelName, darkMode, ref, onActiveUsersChange }) => {
  const [chars, setChars] = useState<CRDTChar[]>([]);
  const [remoteCursors, setRemoteCursors] = useState<Record<string, RemoteCursor>>({});
  const [currentAttributes, setCurrentAttributes] = useState<CRDTAttributes>({
    fontSize: '18px',
    fontFamily: 'Inter, system-ui, sans-serif'
  });
  
  const lseqRef = useRef(new LSEQ(user.id));
  const socketRef = useRef<WebSocket | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const [isFocused, setIsFocused] = useState(false);
  const [isDownloadOpen, setIsDownloadOpen] = useState(false);

  // Undo/Redo stacks - now using batches for multi-char operations
  const undoStack = useRef<UndoBatch[]>([]);
  const redoStack = useRef<UndoBatch[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const desiredCursorRef = useRef<number | null>(null);

  const getCursorLogicalIndex = () => {
      const selection = window.getSelection();
      if (!selection || !selection.rangeCount || !editorRef.current) return null;
      // Ensure the selection is inside the editor
      if (!editorRef.current.contains(selection.anchorNode)) return null;
      try {
        const range = selection.getRangeAt(0);
        return getLogicalIndex(range.startContainer, range.startOffset);
      } catch (e) {
          return null;
      }
  };

  const syncToReact = useCallback(() => {
    setChars([...lseqRef.current.rawChars]);
    setCanUndo(undoStack.current.length > 0);
    setCanRedo(redoStack.current.length > 0);
  }, []);

  useLayoutEffect(() => {
    if (desiredCursorRef.current !== null) {
        setCursorAt(desiredCursorRef.current);
        desiredCursorRef.current = null;
    }
  }, [chars]);

  const broadcast = useCallback((data: any) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(data));
    }
  }, []);

  const broadcastCursor = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || !editorRef.current || !isFocused) return;
    
    try {
      const range = selection.getRangeAt(0);
      const index = getLogicalIndex(range.startContainer, range.startOffset);
      broadcast({
        type: 'cursor',
        siteId: user.id,
        cursor: index,
        name: user.id,
        color: user.color
      });
    } catch (e) {}
  }, [user, isFocused, broadcast]);

  const pushToUndo = useCallback((batch: UndoBatch) => {
    if (batch.length === 0) return;
    undoStack.current.push(batch);
    if (undoStack.current.length > 100) undoStack.current.shift();
    redoStack.current = []; // Clear redo on new action
    setCanUndo(true);
    setCanRedo(false);
  }, []);

  useImperativeHandle(ref, () => ({
    importText: (text: string) => {
      lseqRef.current.loadState([]);
      undoStack.current = [];
      redoStack.current = [];

      // Pre-compute all characters with evenly-spaced positions in O(n)
      // instead of calling localInsert per char which is O(n²) and creates
      // exponentially deep position arrays for sequential appends.
      const SPACING = 10; // gap between positions for future collaborative edits
      const newChars: CRDTChar[] = [];
      for (let i = 0; i < text.length; i++) {
        newChars.push({
          value: text[i],
          position: [(i + 1) * SPACING],
          siteId: user.id,
          attributes: currentAttributes ? { ...currentAttributes } : undefined,
        });
      }

      lseqRef.current.loadState(newChars);

      // Broadcast full state as import-document so remote clients
      // replace their state in O(n) via loadState (instead of processing
      // thousands of individual remoteInsert calls which is O(n²)).
      broadcast({ type: 'import-document', siteId: user.id, state: lseqRef.current.state });

      syncToReact();
      desiredCursorRef.current = 0;
    }
  }));

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.hostname}:8080`;
    const socket = new WebSocket(wsUrl);
    socketRef.current = socket;

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'join', user }));
      socket.send(JSON.stringify({ type: 'request-sync', siteId: user.id }));
    };

    socket.onmessage = (event) => {
      try {
        const op = JSON.parse(event.data);
        
        if (op.type === 'user-list' && Array.isArray(op.users)) {
            onActiveUsersChange?.(op.users);
            // Don't return, as we might have user-list + other logic later
            return; 
        }

        if (op.siteId === user.id) return;
        
        // Capture current cursor before applying remote ops
        const currentCursor = getCursorLogicalIndex();
        let adjustment = 0;

        switch (op.type) {
          case 'batch-insert':
            if (Array.isArray(op.ops)) {
              op.ops.forEach((subOp: any) => {
                const idx = lseqRef.current.remoteInsert(subOp.char);
                if (currentCursor !== null && idx !== undefined && idx <= currentCursor + adjustment) {
                    adjustment++;
                }
              });
              syncToReact();
            }
            break;
          case 'batch-delete':
            if (Array.isArray(op.ops)) {
              // batchRemoteDelete returns count of deleted chars
              // We'd ideally want to know WHICH ones to adjust cursor perfectly.
              // For robustness, we assume if deletion happened, it MIGHT affect us.
              // But without iterating check, we can't be perfect on "shift back".
              // However, typically "batch-delete" is a selection delete.
              // If it returns 0 (no op), no adjustment.
              // If we really want to support remote deletion shifting cursor:
              // We need to iterate ops inside batchRemoteDelete or here.
              // Since we are not rewriting CRDT batch logic completely, 
              // we will fallback to "Preserve Index" strategy (adjustment=0) for batch delete
              // unless we decompose it. 
              // Decomposing is safer for cursor:
              // op.ops.forEach(subOp => { const idx = ...remoteDelete... })
              // BUT batchRemoteDelete is O(N) optimized. Decomposing is O(M*logN).
              // Let's stick to preservation. The user mainly complained about "jumping to beginning".
              // Keeping cursor at index X is better than 0. 
              lseqRef.current.batchRemoteDelete(op.ops);
              syncToReact();
            }
            break;
          case 'batch-format':
            if (Array.isArray(op.ops)) {
              op.ops.forEach((subOp: any) => {
                lseqRef.current.remoteFormat(subOp.position, subOp.charSiteId, subOp.attributes);
              });
              syncToReact();
            }
            break;
          case 'insert':
            const insertIdx = lseqRef.current.remoteInsert(op.char);
            if (currentCursor !== null && insertIdx !== undefined && insertIdx <= currentCursor) {
                adjustment++;
            }
            syncToReact();
            break;
          case 'delete':
            // remoteDelete now returns index of deletion or -1
            const deleteIdx = lseqRef.current.remoteDelete(op.position, op.siteId);
            if (currentCursor !== null && deleteIdx !== -1 && deleteIdx < currentCursor) {
                adjustment--;
            }
            syncToReact();
            break;
          case 'format':
            lseqRef.current.remoteFormat(op.position, op.charSiteId, op.attributes);
            syncToReact();
            break;
          case 'cursor':
            setRemoteCursors(prev => ({ 
              ...prev, 
              [op.siteId]: { cursor: op.cursor, name: op.name, color: op.color, lastSeen: Date.now() } 
            }));
            break;
          case 'request-sync':
            broadcast({ type: 'sync-response', siteId: user.id, state: lseqRef.current.state });
            break;
          case 'sync-response':
            if (lseqRef.current.rawChars.length === 0 && op.state && op.state.length > 0) {
              lseqRef.current.loadState(op.state);
              syncToReact();
            }
            break;
          case 'import-document':
            // A remote user imported a document – replace our state entirely
            if (op.state) {
              lseqRef.current.loadState(op.state);
              syncToReact();
            }
            break;
        }
        
        if (currentCursor !== null && op.type !== 'cursor') {
            desiredCursorRef.current = Math.max(0, currentCursor + adjustment);
        }
      } catch (e) {
        console.error("Failed to parse WebSocket message", e);
      }
    };

    const interval = setInterval(() => {
      const now = Date.now();
      setRemoteCursors(prev => {
        const next = { ...prev };
        let changed = false;
        for (const siteId in next) {
          if (now - next[siteId].lastSeen > CURSOR_TIMEOUT) {
            delete next[siteId];
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 1000);

    return () => {
      socket.close();
      clearInterval(interval);
    };
  }, [channelName, user.id, syncToReact, broadcast]);

  const handleUndo = useCallback(() => {
    const batch = undoStack.current.pop();
    if (!batch) return;

    const redoBatch: UndoBatch = [];
    const deleteOps: any[] = [];
    const insertOps: any[] = [];
    const formatOps: any[] = [];

    // Process backwards to maintain ordering consistency
    for (let i = batch.length - 1; i >= 0; i--) {
      const entry = batch[i];
      if (entry.type === 'insert') {
        lseqRef.current.remoteDelete(entry.char.position, entry.char.siteId);
        deleteOps.push({ type: 'delete', position: entry.char.position, siteId: entry.char.siteId });
        redoBatch.unshift(entry);
      } else if (entry.type === 'delete') {
        lseqRef.current.remoteInsert(entry.char);
        insertOps.push({ type: 'insert', char: entry.char, siteId: user.id });
        redoBatch.unshift(entry);
      } else if (entry.type === 'format') {
        const currentAttrs = { ...(entry.char.attributes || {}) };
        lseqRef.current.remoteFormat(entry.char.position, entry.char.siteId, entry.prevAttributes || {});
        formatOps.push({ 
          type: 'format', 
          position: entry.char.position, 
          charSiteId: entry.char.siteId, 
          attributes: entry.prevAttributes || {}, 
          siteId: user.id 
        });
        redoBatch.unshift({ ...entry, prevAttributes: currentAttrs });
      }
    }

    if (deleteOps.length > 0) broadcast({ type: 'batch-delete', ops: deleteOps, siteId: user.id });
    if (insertOps.length > 0) broadcast({ type: 'batch-insert', ops: insertOps, siteId: user.id });
    if (formatOps.length > 0) broadcast({ type: 'batch-format', ops: formatOps, siteId: user.id });

    redoStack.current.push(redoBatch);
    syncToReact();
    // broadcastCursor();
  }, [user.id, syncToReact, broadcastCursor, broadcast]);

  const handleRedo = useCallback(() => {
    const batch = redoStack.current.pop();
    if (!batch) return;

    const undoBatch: UndoBatch = [];
    const deleteOps: any[] = [];
    const insertOps: any[] = [];
    const formatOps: any[] = [];

    for (const entry of batch) {
      if (entry.type === 'insert') {
        lseqRef.current.remoteInsert(entry.char);
        insertOps.push({ type: 'insert', char: entry.char, siteId: user.id });
        undoBatch.push(entry);
      } else if (entry.type === 'delete') {
        lseqRef.current.remoteDelete(entry.char.position, entry.char.siteId);
        deleteOps.push({ type: 'delete', position: entry.char.position, siteId: entry.char.siteId });
        undoBatch.push(entry);
      } else if (entry.type === 'format') {
        const currentAttrs = { ...(entry.char.attributes || {}) };
        lseqRef.current.remoteFormat(entry.char.position, entry.char.siteId, entry.prevAttributes || {});
        formatOps.push({ 
          type: 'format', 
          position: entry.char.position, 
          charSiteId: entry.char.siteId, 
          attributes: entry.prevAttributes || {}, 
          siteId: user.id 
        });
        undoBatch.push({ ...entry, prevAttributes: currentAttrs });
      }
    }

    if (deleteOps.length > 0) broadcast({ type: 'batch-delete', ops: deleteOps, siteId: user.id });
    if (insertOps.length > 0) broadcast({ type: 'batch-insert', ops: insertOps, siteId: user.id });
    if (formatOps.length > 0) broadcast({ type: 'batch-format', ops: formatOps, siteId: user.id });

    undoStack.current.push(undoBatch);
    syncToReact();
    // broadcastCursor(); // Cursor stays on redo usually
  }, [user.id, syncToReact, broadcastCursor, broadcast]);

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    const start = getLogicalIndex(range.startContainer, range.startOffset);
    const end = getLogicalIndex(range.endContainer, range.endOffset);

    const batch: UndoBatch = [];
    const deleteOps: any[] = [];
    const insertOps: any[] = [];

    if (start !== end) {
      const batchResults = lseqRef.current.localBatchDelete(start, end);
        batchResults.forEach(({ char, op }) => {
            deleteOps.push({
                position: op.position,
                siteId: op.siteId,
                type: 'delete',
                deleterId: user.id
            });
            batch.push({ type: 'delete', char });
        });
      if (deleteOps.length > 0) broadcast({ type: 'batch-delete', ops: deleteOps, siteId: user.id });
    }

    for (let i = 0; i < text.length; i++) {
      const char = lseqRef.current.localInsert(start + i, text[i], currentAttributes);
      insertOps.push({ type: 'insert', char, siteId: user.id });
      batch.push({ type: 'insert', char });
    }

    if (insertOps.length > 0) {
        broadcast({ type: 'batch-insert', ops: insertOps, siteId: user.id });
    }

    pushToUndo(batch);
    syncToReact();
    desiredCursorRef.current = start + text.length;
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'b') { e.preventDefault(); toggleAttribute('bold'); return; }
      if (e.key === 'i') { e.preventDefault(); toggleAttribute('italic'); return; }
      if (e.key === 'u') { e.preventDefault(); toggleAttribute('underline'); return; }
      if (e.key === 'z') { 
        e.preventDefault(); 
        if (e.shiftKey) handleRedo(); else handleUndo(); 
        return; 
      }
      if (e.key === 'y') { e.preventDefault(); handleRedo(); return; }
      if (e.key === 'v') return; 
    }

    if (e.key === 'Backspace') {
      e.preventDefault();
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      let start = getLogicalIndex(range.startContainer, range.startOffset);
      let end = getLogicalIndex(range.endContainer, range.endOffset);

      const batch: UndoBatch = [];
      let targetPos = start;
      const deleteOps: any[] = [];

      if (start === end && start > 0) {
        const char = lseqRef.current.rawChars[start - 1];
        const op = lseqRef.current.localDelete(start - 1);
        if (op) {
          // op contains { position, siteId } where siteId is the character's creator
          // Use a different property for the message sender if needed, but 'op' must preserve the character's ID.
          // The network message structure for 'delete' usually expects { position, siteId } to identify the char.
          // However, the broadcast wrapper adds 'siteId' as the sender.
          // We must ensure the payload inside 'ops' list has the character's siteId.
          
          // Construct the operation payload correctly. 
          // If we spread ...op first, then siteId: user.id, we overwrite the char's siteId with the deleter's siteId.
          // This breaks deletion of other users' characters.
          
          deleteOps.push({ 
            position: op.position, 
            siteId: op.siteId, // Keep the character's siteId
            type: 'delete',
            deleterId: user.id // Optional: track who deleted it
          });
          batch.push({ type: 'delete', char });
        }
        targetPos = start - 1;
      } else if (start !== end) {
        const batchResults = lseqRef.current.localBatchDelete(start, end);
        batchResults.forEach(({ char, op }) => {
            deleteOps.push({ 
                position: op.position, 
                siteId: op.siteId, // Keep the character's siteId
                type: 'delete',
                deleterId: user.id
            });
            batch.push({ type: 'delete', char });
        });
        targetPos = start;
      }
      
      if (deleteOps.length > 0) {
        broadcast({ type: 'batch-delete', ops: deleteOps, siteId: user.id });
      }
      
      pushToUndo(batch);
      syncToReact();
      desiredCursorRef.current = targetPos;
      // setTimeout(() => {
      //   setCursorAt(targetPos);
      //   broadcastCursor();
      // }, 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      insertChar('\n');
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      insertChar(e.key);
    }
    setTimeout(broadcastCursor, 0);
  };

  const insertChar = (val: string) => {
    const selection = window.getSelection();
    if (!selection) return;
    const range = selection.getRangeAt(0);
    let start = getLogicalIndex(range.startContainer, range.startOffset);
    let end = getLogicalIndex(range.endContainer, range.endOffset);
    
    const batch: UndoBatch = [];
    const deleteOps: any[] = [];

    if (start !== end) {
      const batchResults = lseqRef.current.localBatchDelete(start, end);
        batchResults.forEach(({ char, op }) => {
            deleteOps.push({ 
                position: op.position, 
                siteId: op.siteId, // Keep char's siteId
                type: 'delete',
                deleterId: user.id
            });
            batch.push({ type: 'delete', char });
        });
      if (deleteOps.length > 0) broadcast({ type: 'batch-delete', ops: deleteOps, siteId: user.id });
    }
    const char = lseqRef.current.localInsert(start, val, currentAttributes);
    broadcast({ type: 'insert', char, siteId: user.id });
    batch.push({ type: 'insert', char });
    
    pushToUndo(batch);
    syncToReact();
    desiredCursorRef.current = start + 1;
  };

  const getLogicalIndex = (container: Node, offset: number): number => {
    if (!editorRef.current) return 0;
    if (container === editorRef.current) {
        let count = 0;
        for (let i = 0; i < offset && i < container.childNodes.length; i++) {
            count += container.childNodes[i].textContent?.length || 0;
        }
        return count;
    }
    const walker = document.createTreeWalker(editorRef.current, NodeFilter.SHOW_TEXT);
    let count = 0;
    while (walker.nextNode()) {
      if (walker.currentNode === container) return count + offset;
      count += walker.currentNode.textContent?.length || 0;
    }
    if (container.nodeType === Node.ELEMENT_NODE && container.hasChildNodes()) {
       if (offset < container.childNodes.length) return getLogicalIndex(container.childNodes[offset], 0);
    }
    return count;
  };

  const setCursorAt = (logicalIndex: number) => {
    if (!editorRef.current) return;
    const selection = window.getSelection();
    const range = document.createRange();
    const walker = document.createTreeWalker(editorRef.current, NodeFilter.SHOW_TEXT);
    let count = 0;
    let found = false;
    while (walker.nextNode()) {
      const len = walker.currentNode.textContent?.length || 0;
      if (count + len >= logicalIndex) {
        range.setStart(walker.currentNode, logicalIndex - count);
        range.collapse(true);
        found = true;
        break;
      }
      count += len;
    }
    if (!found) {
      range.selectNodeContents(editorRef.current);
      range.collapse(false);
    }
    selection?.removeAllRanges();
    selection?.addRange(range);
  };

  const toggleAttribute = (key: keyof CRDTAttributes) => {
    const newVal = !currentAttributes[key];
    const patch = { [key]: newVal };
    setCurrentAttributes(prev => ({ ...prev, ...patch }));
    applyToSelection(patch);
  };

  const updateAttribute = (key: keyof CRDTAttributes, val: string) => {
    const patch = { [key]: val };
    setCurrentAttributes(prev => ({ ...prev, ...patch }));
    applyToSelection(patch);
  };

  const applyToSelection = (patch: Partial<CRDTAttributes>) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const start = getLogicalIndex(range.startContainer, range.startOffset);
    const end = getLogicalIndex(range.endContainer, range.endOffset);
    
    const batch: UndoBatch = [];
    const formatOps: any[] = [];
    
    for (let i = start; i < end && i < lseqRef.current.rawChars.length; i++) {
      const char = lseqRef.current.rawChars[i];
      const oldAttrs = { ...(char.attributes || {}) };
      const result = lseqRef.current.localFormat(i, patch);
      if (result) {
        formatOps.push({
          type: 'format',
          position: result.position,
          charSiteId: result.charSiteId,
          attributes: patch,
          siteId: user.id
        });
        batch.push({ type: 'format', char, prevAttributes: oldAttrs });
      }
    }

    if (formatOps.length > 0) {
      broadcast({ type: 'batch-format', ops: formatOps, siteId: user.id });
    }
    
    pushToUndo(batch);
    syncToReact();
  };

  const handleDownload = (format: 'txt' | 'doc') => {
    const textContent = lseqRef.current.text;
    const currentChars = lseqRef.current.rawChars;

    if (!textContent || textContent.length === 0) {
      alert("Document is empty, nothing to download.");
      return;
    }

    let blob: Blob;
    let fileName = `document-${new Date().toISOString().split('T')[0]}`;
    
    if (format === 'txt') {
      blob = new Blob([textContent], { type: 'text/plain' });
      fileName += '.txt';
    } else {
      const htmlBody = currentChars.map(char => {
        let style = '';
        if (char.attributes?.bold) style += 'font-weight:bold;';
        if (char.attributes?.italic) style += 'font-style:italic;';
        if (char.attributes?.underline) style += 'text-decoration:underline;';
        if (char.attributes?.fontSize) style += `font-size:${char.attributes.fontSize};`;
        if (char.attributes?.fontFamily) style += `font-family:${char.attributes.fontFamily};`;
        const val = char.value === '\n' ? '<br/>' : escapeHTML(char.value);
        return style ? `<span style="${style}">${val}</span>` : val;
      }).join('');

      const html = `<html><head><meta charset='utf-8'></head><body style="font-family: sans-serif; white-space: pre-wrap;">${htmlBody}</body></html>`;
      blob = new Blob(['\ufeff', html], { type: 'text/html' });
      fileName += '.doc';
    }

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    setIsDownloadOpen(false);
  };

  const renderContent = () => {
    const blocks: React.ReactNode[] = [];
    if (chars.length === 0) return null;

    const cursorsByPos: Record<number, RemoteCursor[]> = {};
    (Object.values(remoteCursors) as RemoteCursor[]).forEach(rc => {
      if (!cursorsByPos[rc.cursor]) cursorsByPos[rc.cursor] = [];
      cursorsByPos[rc.cursor].push(rc);
    });

    let currentBlock = { text: '', attributes: JSON.stringify(chars[0]?.attributes || {}), firstIndex: 0 };
    
    for (let i = 0; i <= chars.length; i++) {
      if (cursorsByPos[i]) {
        if (currentBlock.text) {
          const attr = JSON.parse(currentBlock.attributes);
          blocks.push(
            <span key={`block-${currentBlock.firstIndex}`} style={{
              fontWeight: attr.bold ? 'bold' : 'normal',
              fontStyle: attr.italic ? 'italic' : 'normal',
              textDecoration: attr.underline ? 'underline' : 'none',
              fontSize: attr.fontSize,
              fontFamily: attr.fontFamily
            }}>{currentBlock.text}</span>
          );
          currentBlock = { text: '', attributes: i < chars.length ? JSON.stringify(chars[i].attributes || {}) : '{}', firstIndex: i };
        }
        
        cursorsByPos[i].forEach(rc => {
          blocks.push(
            <span key={`cursor-${rc.name}-${i}`} className="remote-cursor">
              <span className="cursor-bar" style={{ backgroundColor: rc.color }} />
              <span className="cursor-label" style={{ backgroundColor: rc.color }}>{rc.name}</span>
            </span>
          );
        });
      }

      if (i < chars.length) {
        const charAttr = JSON.stringify(chars[i].attributes || {});
        if (charAttr === currentBlock.attributes) {
          currentBlock.text += chars[i].value;
        } else {
          if (currentBlock.text) {
            const attr = JSON.parse(currentBlock.attributes);
            blocks.push(
              <span key={`block-${currentBlock.firstIndex}`} style={{
                fontWeight: attr.bold ? 'bold' : 'normal',
                fontStyle: attr.italic ? 'italic' : 'normal',
                textDecoration: attr.underline ? 'underline' : 'none',
                fontSize: attr.fontSize,
                fontFamily: attr.fontFamily
              }}>{currentBlock.text}</span>
            );
          }
          currentBlock = { text: chars[i].value, attributes: charAttr, firstIndex: i };
        }
      } else if (currentBlock.text) {
        const attr = JSON.parse(currentBlock.attributes);
        blocks.push(
          <span key={`block-${currentBlock.firstIndex}`} style={{
            fontWeight: attr.bold ? 'bold' : 'normal',
            fontStyle: attr.italic ? 'italic' : 'normal',
            textDecoration: attr.underline ? 'underline' : 'none',
            fontSize: attr.fontSize,
            fontFamily: attr.fontFamily
          }}>{currentBlock.text}</span>
        );
      }
    }

    return blocks;
  };

  return (
    <div className={`flex flex-col h-full bg-white dark:bg-slate-900 rounded-3xl shadow-2xl transition-all duration-300 border-2 ${isFocused ? 'border-indigo-400 dark:border-indigo-500 ring-4 ring-indigo-50 dark:ring-indigo-900/20' : 'border-slate-100 dark:border-slate-800'} overflow-hidden relative`}>
      <style>{`
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
        .remote-cursor { position: relative; display: inline-block; width: 0; height: 1.2em; vertical-align: middle; pointer-events: none; z-index: 10; }
        .cursor-bar { position: absolute; left: -1px; top: -0.1em; width: 2px; height: 1.4em; animation: blink 1s step-end infinite; }
        .cursor-label { position: absolute; bottom: 100%; left: 0; padding: 2px 4px; border-radius: 4px; color: white; font-size: 10px; font-weight: bold; white-space: nowrap; pointer-events: none; transform: translateY(-2px); opacity: 0; transition: opacity 0.2s; }
        .remote-cursor:hover .cursor-label { opacity: 1; }
      `}</style>
      
      <div className="bg-slate-50 dark:bg-slate-800 border-b border-slate-100 dark:border-slate-700 px-6 py-3 flex flex-wrap items-center gap-2">
        <div className="flex bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700 p-1">
          <button 
            onClick={handleUndo} 
            disabled={!canUndo}
            className={`p-2 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors ${!canUndo ? 'text-slate-300 dark:text-slate-600' : 'text-slate-600 dark:text-slate-400'}`}
            title="Undo (Ctrl+Z)"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M3 10h10a8 8 0 018 8v2M3 10l5-5m-5 5l5 5" /></svg>
          </button>
          <button 
            onClick={handleRedo} 
            disabled={!canRedo}
            className={`p-2 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors ${!canRedo ? 'text-slate-300 dark:text-slate-600' : 'text-slate-600 dark:text-slate-400'}`}
            title="Redo (Ctrl+Y)"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M21 10H11a8 8 0 00-8 8v2M21 10l-5-5m5 5l-5 5" /></svg>
          </button>
        </div>

        <div className="flex bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700 p-1">
          <button onClick={() => toggleAttribute('bold')} className={`p-2 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors ${currentAttributes.bold ? 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400' : 'text-slate-600 dark:text-slate-400'}`}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 4h8a4 4 0 014 4 4 4 0 01-4 4H6z M6 12h9a4 4 0 014 4 4 4 0 01-4 4H6z" /></svg>
          </button>
          <button onClick={() => toggleAttribute('italic')} className={`p-2 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors ${currentAttributes.italic ? 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400' : 'text-slate-600 dark:text-slate-400'}`}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M10 20l4-16m-9 16h6m2-16h6" /></svg>
          </button>
          <button onClick={() => toggleAttribute('underline')} className={`p-2 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors ${currentAttributes.underline ? 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400' : 'text-slate-600 dark:text-slate-400'}`}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 3v7a6 6 0 006 6 6 6 0 006-6V3M4 21h16" /></svg>
          </button>
        </div>

        <select value={currentAttributes.fontSize} onChange={(e) => updateAttribute('fontSize', e.target.value)} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1.5 text-xs font-bold text-slate-600 dark:text-slate-400 outline-none">
          {FONT_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>

        <select value={currentAttributes.fontFamily} onChange={(e) => updateAttribute('fontFamily', e.target.value)} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1.5 text-xs font-bold text-slate-600 dark:text-slate-400 outline-none">
          {FONT_FAMILIES.map(f => <option key={f.value} value={f.value}>{f.name}</option>)}
        </select>

        <div className="relative">
          <button onClick={() => setIsDownloadOpen(!isDownloadOpen)} className="flex items-center gap-2 bg-indigo-600 dark:bg-indigo-500 text-white px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-indigo-700 dark:hover:bg-indigo-600 transition-colors shadow-sm">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
            Download
          </button>
          {isDownloadOpen && (
            <div className="absolute top-full mt-2 left-0 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl z-50 overflow-hidden w-40">
              <button onClick={() => handleDownload('txt')} className="w-full text-left px-4 py-3 text-xs font-bold text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors">Plain Text (.txt)</button>
              <button onClick={() => handleDownload('doc')} className="w-full text-left px-4 py-3 text-xs font-bold text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700 border-t border-slate-100 dark:border-slate-700 transition-colors">Word Doc (.doc)</button>
            </div>
          )}
        </div>

        <div className="flex-1"></div>
        <div className="flex items-center -space-x-2">
           {(Object.values(remoteCursors) as RemoteCursor[]).map((rc, i) => (
             <div key={i} className="w-8 h-8 rounded-full border-2 border-white dark:border-slate-900 flex items-center justify-center text-[10px] text-white font-bold" style={{ backgroundColor: rc.color }} title={`Remote: ${rc.name}`}>
               {rc.name[0]}
             </div>
           ))}
        </div>
      </div>
      
      <div 
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onKeyUp={broadcastCursor}
        onMouseUp={broadcastCursor}
        onFocus={() => { setIsFocused(true); broadcastCursor(); }}
        onBlur={() => setIsFocused(false)}
        className="flex-1 p-10 outline-none overflow-y-auto custom-scrollbar whitespace-pre-wrap break-words relative text-slate-900 dark:text-slate-200"
        spellCheck={false}
        style={{ fontFamily: currentAttributes.fontFamily, fontSize: currentAttributes.fontSize }}
      >
        {renderContent()}
      </div>
    </div>
  );
};

export default Editor;
