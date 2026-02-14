
import React, { useMemo, useRef, useState, useEffect } from 'react';
import Editor, { EditorHandle } from './components/Editor';
import { Collaborator } from './types';
import { COLORS, ROOM_NAME } from './constants';
import * as mammoth from 'mammoth';

const generateUserId = () => `UID-${Math.floor(1000 + Math.random() * 9000)}`;
const randomColor = () => COLORS[Math.floor(Math.random() * COLORS.length)];
const normalizeImportedText = (input: string) =>
  input
    .replace(/\r\n?/g, '\n') // normalize Windows/Mac line endings
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ''); // strip control chars that break rendering

const extractDocxText = async (arrayBuffer: ArrayBuffer) => {
  // Try high-fidelity raw text first
  try {
    const rawResult = await mammoth.extractRawText({ arrayBuffer });
    if (rawResult.value && rawResult.value.trim().length > 0) {
      return rawResult.value;
    }
  } catch (err) {
    console.warn('Failed to extract raw text via Mammoth:', err);
  }

  // Fallback to HTML conversion (captures tables, headers, etc.)
  try {
    const htmlResult = await mammoth.convertToHtml({ arrayBuffer });
    const temp = document.createElement('div');
    temp.innerHTML = htmlResult.value || '';
    return temp.textContent || '';
  } catch (err) {
    console.error('Failed to convert DOCX to HTML for fallback', err);
    throw err;
  }
};

const App: React.FC = () => {
  const editorRef = useRef<EditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('theme') === 'dark');
  const [copied, setCopied] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [activeUsers, setActiveUsers] = useState<Collaborator[]>([]);


  // Each tab/session gets its own unique identity
  const currentUser = useMemo<Collaborator>(() => ({
    id: generateUserId(),
    name: '', // We use ID primarily
    color: randomColor(),
  }), []);

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  }, [darkMode]);

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const getShareableLink = () => {
    const url = new URL(window.location.href);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      url.hostname = '172.20.10.8';
    }
    return url.toString();
  };

  const handleCopyLink = () => {
    navigator.clipboard.writeText(getShareableLink());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    try {
      let text = '';
      if (file.name.toLowerCase().endsWith('.txt')) {
        text = await file.text();
      } else if (file.name.toLowerCase().endsWith('.docx')) {
        const arrayBuffer = await file.arrayBuffer();
        try {
          text = await extractDocxText(arrayBuffer);
        } catch (innerError: any) {
          if (innerError.message?.includes('central directory')) {
            throw new Error('This file appears to be an older .doc format or is corrupted. Mammoth only supports .docx files.');
          }
          throw innerError;
        }
      } else if (file.name.toLowerCase().endsWith('.doc')) {
        alert('Legacy Word binary (.doc) is not supported. Please save your file as .docx and try again.');
        setIsUploading(false);
        return;
      } else {
        alert('Unsupported file format. Please upload .txt or .docx');
        setIsUploading(false);
        return;
      }

      const sanitizedText = normalizeImportedText(text);

      if (editorRef.current) {
        editorRef.current.importText(sanitizedText);
      }
    } catch (error: any) {
      console.error('Failed to parse file:', error);
      alert(`Error reading file: ${error.message || 'Unknown error'}`);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className={`flex flex-col h-full transition-colors duration-300 ${darkMode ? 'dark bg-slate-950 text-slate-100' : 'bg-slate-50 text-slate-900'}`}>
      {/* Hidden File Input */}
      <input 
        type="file" 
        ref={fileInputRef} 
        className="hidden" 
        accept=".txt,.docx" 
        onChange={handleFileChange}
      />

      {/* Header */}
      <header className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 px-8 py-4 flex items-center justify-between shrink-0 z-30 shadow-sm transition-colors duration-300">
        <div className="flex items-center gap-4">
          {!sidebarVisible && (
            <button 
              onClick={() => setSidebarVisible(true)}
              className="p-2 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors mr-2"
              title="Open Sidebar"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          )}
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 flex items-center justify-center shadow-lg shadow-indigo-200 dark:shadow-indigo-900/30">
            <div className="w-7 h-7 rounded-2xl bg-white/15 border border-white/30 flex items-center justify-center backdrop-blur">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.25} d="M6 12l3.5 3.5L18 7" />
              </svg>
            </div>
          </div>
          <div>
            <h1 className="text-xl font-black text-slate-800 dark:text-slate-100 tracking-tight leading-none">CollabCore</h1>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <button 
            onClick={handleUploadClick}
            disabled={isUploading}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all transform active:scale-95 ${
              isUploading 
                ? 'bg-slate-100 dark:bg-slate-800 text-slate-400 cursor-not-allowed' 
                : 'bg-indigo-50 dark:bg-indigo-950/30 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 shadow-sm border border-indigo-100 dark:border-indigo-900/30'
            }`}
          >
            {isUploading ? (
              <svg className="animate-spin h-4 w-4 text-indigo-600" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
            )}
            {isUploading ? 'Uploading...' : 'Upload Doc'}
          </button>

          <div className="flex flex-col items-end border-l border-slate-200 dark:border-slate-800 pl-6">
             <span className="text-[9px] font-black text-slate-400 dark:text-slate-500 uppercase">Your Session</span>
             <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800" style={{ color: currentUser.color }}>
               {currentUser.id}
             </span>
          </div>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <aside className={`${sidebarVisible ? 'w-72 border-r translate-x-0' : 'w-0 -translate-x-full border-none opacity-0'} border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shrink-0 flex flex-col transition-all duration-300 overflow-y-auto custom-scrollbar`}>
          <div className="p-6 space-y-8">
            {/* Interface Dismiss Header */}
            <div className="flex items-center justify-between">
              <h3 className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Interface</h3>
              <button 
                onClick={() => setSidebarVisible(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all"
                title="Dismiss Sidebar"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
                </svg>
              </button>
            </div>

            {/* Theme Toggle Section */}
            <div className="space-y-4">
              <div className="flex bg-slate-100 dark:bg-slate-800 p-1 rounded-xl">
                <button 
                  onClick={() => setDarkMode(false)}
                  className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-bold transition-all ${!darkMode ? 'bg-white dark:bg-slate-700 shadow-sm text-indigo-600 dark:text-indigo-400' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707m12.728 0l-.707-.707M6.343 6.343l-.707-.707M12 5a7 7 0 100 14 7 7 0 000-14z" /></svg>
                  Light
                </button>
                <button 
                  onClick={() => setDarkMode(true)}
                  className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-bold transition-all ${darkMode ? 'bg-white dark:bg-slate-700 shadow-sm text-indigo-600 dark:text-indigo-400' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg>
                  Dark
                </button>
              </div>
            </div>

            {/* Active Users Section */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Active Users</h3>
                <span className="text-[10px] font-bold px-1.5 py-0.5 bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400 rounded-md">{activeUsers.length}</span>
              </div>
              <div className="space-y-2 max-h-40 overflow-y-auto custom-scrollbar pr-1">
                 {activeUsers.length === 0 && <p className="text-xs text-slate-400 dark:text-slate-500 italic">Connecting...</p>}
                 {activeUsers.map(u => (
                    <div key={u.id} className="flex items-center gap-3 p-2 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-800">
                        <div className="w-2 h-2 rounded-full shadow-sm" style={{ backgroundColor: u.color }}></div>
                        <span className="text-xs font-bold text-slate-700 dark:text-slate-300 truncate flex-1">{u.name || u.id}</span>
                        {u.id === currentUser.id && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-500">YOU</span>}
                    </div>
                 ))}
              </div>
            </div>

            {/* Share Section */}
            <div className="space-y-4">
              <h3 className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Collaboration</h3>
              <div className="space-y-3">
                <div className="bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 rounded-xl p-3">
                  <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 mb-1">Document Link</p>
                  <p className="text-xs font-mono text-slate-600 dark:text-slate-400 truncate bg-white dark:bg-slate-800 p-2 rounded-lg border border-slate-100 dark:border-slate-700">
                    {getShareableLink()}
                  </p>
                </div>
                <button 
                  onClick={handleCopyLink}
                  className={`w-full flex items-center justify-center gap-2 py-3 rounded-xl text-xs font-bold transition-all transform active:scale-95 shadow-sm ${copied ? 'bg-green-500 text-white' : 'bg-indigo-600 hover:bg-indigo-700 text-white'}`}
                >
                  {copied ? (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                      Copied!
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                      Share Document
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Info Section */}
            <div className="pt-8 border-t border-slate-100 dark:border-slate-800">
               <div className="flex items-center gap-3 p-3 rounded-xl bg-slate-50 dark:bg-slate-800/30">
                 <div className="w-8 h-8 rounded-lg bg-indigo-100 dark:bg-indigo-900/40 flex items-center justify-center text-indigo-600 dark:text-indigo-400">
                   <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                 </div>
                 <div>
                   <p className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase leading-none">Status</p>
                   <p className="text-[11px] font-bold text-green-500 mt-0.5">Connected</p>
                 </div>
               </div>
            </div>
          </div>
        </aside>

        {/* Workspace */}
        <main className="flex-1 flex overflow-hidden p-8 justify-center overflow-y-auto custom-scrollbar">
          <div className="flex-1 max-w-5xl w-full min-h-full flex flex-col">
            <Editor 
                ref={editorRef} 
                user={currentUser} 
                channelName={ROOM_NAME} 
                darkMode={darkMode}
                onActiveUsersChange={setActiveUsers}
            />
          </div>
        </main>
      </div>
    </div>
  );
};

export default App;
