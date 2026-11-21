// Device-side cache of rendered session history (IndexedDB).
//
// Opening a long session otherwise means waiting for the agent to
// replay every message over the connection while the client renders
// them one by one. With this cache the UI shows the locally stored
// history instantly and reconciles against the server replay in the
// background; the server copy always wins, so a stale entry can only
// ever be a preview, never the final state.
//
// Entries store the UI's own ChatMessage objects (JSON-cloned), with
// the bulky inline MCP App HTML stripped - the app host refetches it
// on demand when the entry is rendered. All operations fail silently:
// the cache must never break the app.
import type { ChatMessage } from './types';

const DB_NAME = 'acp-ui-cache';
const STORE_NAME = 'history';
const CACHE_VERSION = 1;
const MAX_ENTRIES = 12;
const MAX_ENTRY_CHARS = 2_500_000;
const MAX_TOTAL_CHARS = 24_000_000;

interface HistoryEntry {
  sessionId: string;
  version: number;
  savedAt: number;
  size: number;
  messages: ChatMessage[];
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'sessionId' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const t = db.transaction(STORE_NAME, mode);
          const req = run(t.objectStore(STORE_NAME));
          req.onsuccess = () => resolve(req.result ?? null);
          req.onerror = () => resolve(null);
          t.oncomplete = () => db.close();
          t.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

// JSON-clone into plain objects (the store's messages are Vue proxies,
// which structured clone rejects) and strip inline MCP App HTML.
function serialize(messages: ChatMessage[]): { messages: ChatMessage[]; size: number } | null {
  try {
    const plain = JSON.parse(JSON.stringify(messages)) as ChatMessage[];
    for (const m of plain) {
      for (const tc of m.toolCalls ?? []) {
        if (tc.mcpApp) delete tc.mcpApp.html;
      }
    }
    const size = JSON.stringify(plain).length;
    if (size > MAX_ENTRY_CHARS) return null;
    return { messages: plain, size };
  } catch {
    return null;
  }
}

export async function getCachedHistory(sessionId: string): Promise<ChatMessage[] | null> {
  const entry = await tx<HistoryEntry>('readonly', (s) => s.get(sessionId) as IDBRequest<HistoryEntry>);
  if (!entry || entry.version !== CACHE_VERSION || !Array.isArray(entry.messages)) return null;
  return entry.messages;
}

export async function putCachedHistory(sessionId: string, messages: ChatMessage[]): Promise<void> {
  if (!sessionId || messages.length === 0) return;
  const ser = serialize(messages);
  if (!ser) return;
  const entry: HistoryEntry = {
    sessionId,
    version: CACHE_VERSION,
    savedAt: Date.now(),
    size: ser.size,
    messages: ser.messages,
  };
  await tx('readwrite', (s) => s.put(entry));
  await prune();
}

export async function deleteCachedHistory(sessionId: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(sessionId));
}

// Keep only the newest MAX_ENTRIES entries within a total size budget.
async function prune(): Promise<void> {
  const all = await tx<HistoryEntry[]>('readonly', (s) => s.getAll() as IDBRequest<HistoryEntry[]>);
  if (!all || all.length <= MAX_ENTRIES) return;
  const sorted = [...all].sort((a, b) => b.savedAt - a.savedAt);
  let total = 0;
  const keep = new Set<string>();
  for (const e of sorted) {
    total += e.size || 0;
    if (keep.size < MAX_ENTRIES && total <= MAX_TOTAL_CHARS) keep.add(e.sessionId);
  }
  for (const e of sorted) {
    if (!keep.has(e.sessionId)) await tx('readwrite', (s) => s.delete(e.sessionId));
  }
}
