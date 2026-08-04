import type { Message } from 'ai';
import { createScopedLogger } from '~/utils/logger';
import type { ChatHistoryItem } from './useChatHistory';
import type { Snapshot } from './types'; // Import Snapshot type

export interface IChatMetadata {
  gitUrl: string;
  gitBranch?: string;
  netlifySiteId?: string;
}

const logger = createScopedLogger('ChatHistory');

/*
 * FIX (2026-08-04): persistence moved from browser IndexedDB to server-side Postgres
 * (via these /api/chats* and /api/snapshots* routes -> bolt-diy-persistence ->
 * bolt-diy-db). Large projects were freezing the tab because every sampled message
 * chunk re-serialized and wrote the full history + file snapshot to IndexedDB on the
 * main thread. `Db` below is a lightweight truthy sentinel, not a real IDBDatabase --
 * kept only so callers' `if (!db)` checks keep working unchanged.
 */
type Db = Record<string, never>;

/*
 * FIX (2026-08-04): none of the fetch calls below had a timeout -- if the
 * persistence service hung or the network stalled, the promise could stay
 * pending indefinitely, leaving the UI spinner stuck with no error ever
 * surfaced. AbortController enforces an upper bound on every request.
 */
async function fetchWithTimeout(url: string, options?: RequestInit, ms = 8000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// this is used at the top level and never rejects
export async function openDatabase(): Promise<Db | undefined> {
  if (typeof window === 'undefined') {
    // SSR: matches the original `typeof indexedDB === 'undefined'` guard -- this
    // module's top-level `await openDatabase()` still runs during server render,
    // and a relative fetch('/api/chats') has no origin to resolve against there.
    return undefined;
  }

  try {
    const response = await fetchWithTimeout('/api/chats');

    if (!response.ok) {
      throw new Error(`status ${response.status}`);
    }

    return {};
  } catch (error) {
    logger.error('Chat persistence API is not reachable', error);
    return undefined;
  }
}

export async function getAll(_db: Db): Promise<ChatHistoryItem[]> {
  const response = await fetchWithTimeout('/api/chats');

  if (!response.ok) {
    throw new Error(`Failed to list chats: ${response.status}`);
  }

  return response.json();
}

/*
 * FIX (2026-08-04): this is called on every sampled message chunk while the AI
 * streams a response -- a transient network hiccup or a persistence-service
 * restart used to fail the save on the first try with no recovery. Retrying a
 * couple of times with backoff absorbs short-lived failures instead of
 * surfacing them to the user immediately.
 */
export async function setMessages(
  _db: Db,
  id: string,
  messages: Message[],
  urlId?: string,
  description?: string,
  timestamp?: string,
  metadata?: IChatMetadata,
): Promise<void> {
  if (timestamp && isNaN(Date.parse(timestamp))) {
    throw new Error('Invalid timestamp');
  }

  const body = JSON.stringify({ messages, urlId, description, timestamp, metadata });
  const maxAttempts = 3;
  const backoffsMs = [500, 1500];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetchWithTimeout(`/api/chats/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      if (response.ok) {
        return;
      }

      if (response.status < 500 || attempt === maxAttempts) {
        throw new Error(`Failed to save chat: ${response.status}`);
      }
    } catch (error) {
      if (attempt === maxAttempts) {
        throw error instanceof Error ? error : new Error('Failed to save chat: network error');
      }
    }

    await sleep(backoffsMs[attempt - 1]);
  }
}

async function fetchChat(id: string, mode: 'id' | 'urlId' | 'either'): Promise<ChatHistoryItem | undefined> {
  const response = await fetchWithTimeout(`/api/chats/${encodeURIComponent(id)}?mode=${mode}`);

  if (response.status === 404) {
    return undefined;
  }

  if (!response.ok) {
    throw new Error(`Failed to load chat: ${response.status}`);
  }

  return response.json();
}

// FIX (2026-08-04): returns `undefined` explicitly instead of an unsafe cast, so
// TypeScript forces every caller to handle the "chat not found" case.
export async function getMessages(_db: Db, id: string): Promise<ChatHistoryItem | undefined> {
  return fetchChat(id, 'either');
}

export async function getMessagesByUrlId(_db: Db, id: string): Promise<ChatHistoryItem | undefined> {
  return fetchChat(id, 'urlId');
}

export async function getMessagesById(_db: Db, id: string): Promise<ChatHistoryItem | undefined> {
  return fetchChat(id, 'id');
}

export async function deleteById(_db: Db, id: string): Promise<void> {
  const response = await fetchWithTimeout(`/api/chats/${encodeURIComponent(id)}`, { method: 'DELETE' });

  if (!response.ok) {
    throw new Error(`Failed to delete chat: ${response.status}`);
  }
}

export async function getNextId(_db: Db): Promise<string> {
  const response = await fetchWithTimeout('/api/chats/meta/next-id');

  if (!response.ok) {
    throw new Error(`Failed to get next id: ${response.status}`);
  }

  const { nextId } = (await response.json()) as { nextId: string };

  return nextId;
}

export async function getUrlId(_db: Db, id: string): Promise<string> {
  const response = await fetchWithTimeout(`/api/chats/meta/next-url-id?base=${encodeURIComponent(id)}`);

  if (!response.ok) {
    throw new Error(`Failed to get url id: ${response.status}`);
  }

  const { urlId } = (await response.json()) as { urlId: string };

  return urlId;
}

export async function forkChat(db: Db, chatId: string, messageId: string): Promise<string> {
  const chat = await getMessages(db, chatId);

  if (!chat) {
    throw new Error('Chat not found');
  }

  // Find the index of the message to fork at
  const messageIndex = chat.messages.findIndex((msg) => msg.id === messageId);

  if (messageIndex === -1) {
    throw new Error('Message not found');
  }

  // Get messages up to and including the selected message
  const messages = chat.messages.slice(0, messageIndex + 1);

  return createChatFromMessages(db, chat.description ? `${chat.description} (fork)` : 'Forked chat', messages);
}

export async function duplicateChat(db: Db, id: string): Promise<string> {
  const chat = await getMessages(db, id);

  if (!chat) {
    throw new Error('Chat not found');
  }

  return createChatFromMessages(db, `${chat.description || 'Chat'} (copy)`, chat.messages);
}

export async function createChatFromMessages(
  db: Db,
  description: string,
  messages: Message[],
  metadata?: IChatMetadata,
): Promise<string> {
  const newId = await getNextId(db);
  const newUrlId = await getUrlId(db, newId); // Get a new urlId for the duplicated chat

  await setMessages(
    db,
    newId,
    messages,
    newUrlId, // Use the new urlId
    description,
    undefined, // Use the current timestamp
    metadata,
  );

  return newUrlId; // Return the urlId instead of id for navigation
}

export async function updateChatDescription(db: Db, id: string, description: string): Promise<void> {
  const chat = await getMessages(db, id);

  if (!chat) {
    throw new Error('Chat not found');
  }

  if (!description.trim()) {
    throw new Error('Description cannot be empty');
  }

  await setMessages(db, id, chat.messages, chat.urlId, description, chat.timestamp, chat.metadata);
}

export async function updateChatMetadata(db: Db, id: string, metadata: IChatMetadata | undefined): Promise<void> {
  const chat = await getMessages(db, id);

  if (!chat) {
    throw new Error('Chat not found');
  }

  await setMessages(db, id, chat.messages, chat.urlId, chat.description, chat.timestamp, metadata);
}

export async function getSnapshot(_db: Db, chatId: string): Promise<Snapshot | undefined> {
  const response = await fetchWithTimeout(`/api/snapshots/${encodeURIComponent(chatId)}`);

  if (!response.ok) {
    throw new Error(`Failed to get snapshot: ${response.status}`);
  }

  const data = await response.json();

  return (data ?? undefined) as Snapshot | undefined;
}

export async function setSnapshot(_db: Db, chatId: string, snapshot: Snapshot): Promise<void> {
  const response = await fetchWithTimeout(`/api/snapshots/${encodeURIComponent(chatId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(snapshot),
  });

  if (!response.ok) {
    throw new Error(`Failed to save snapshot: ${response.status}`);
  }
}

export async function deleteSnapshot(_db: Db, chatId: string): Promise<void> {
  const response = await fetchWithTimeout(`/api/snapshots/${encodeURIComponent(chatId)}`, { method: 'DELETE' });

  if (!response.ok && response.status !== 404) {
    throw new Error(`Failed to delete snapshot: ${response.status}`);
  }
}
