// Session store for managing ACP sessions and persistence
import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { loadKvStore, type KVStore } from '../lib/host/storage';
import { getAppVersion } from '../lib/host';
import { trackEvent, trackError } from '../lib/telemetry';
import type { SavedSession, ChatMessage, ToolCallInfo, ToolCallContentItem, McpAppInfo, PermissionRequest, SessionMode, SlashCommand, ModelInfo, AgentConfig } from '../lib/types';
import { getTransportKind } from '../lib/types';
import { AcpClientBridge, createAcpClient } from '../lib/acp-bridge';
import { getCachedHistory, putCachedHistory, deleteCachedHistory } from '../lib/history-cache';
import { onAgentStderr, spawnAgent, killAgent } from '../lib/host';
import { isDesktop } from '../lib/platform';
import { useConfigStore } from './config';
import type { SessionNotification, AuthMethod, SessionConfigOption, LoadSessionResponse } from '@agentclientprotocol/sdk';

const STORE_PATH = 'sessions.json';
const PROTOCOL_VERSION = 1;

// App version (loaded once at startup)
let appVersion = '0.1.0';

// Startup phase detection patterns
function detectPhase(line: string): string | null {
  const lower = line.toLowerCase();
  if (lower.includes('download') || lower.includes('fetch') || lower.includes('get ')) {
    return 'downloading';
  }
  if (lower.includes('install') || lower.includes('added') || lower.includes('packages')) {
    return 'installing';
  }
  if (lower.includes('build') || lower.includes('compil')) {
    return 'building';
  }
  if (lower.includes('start') || lower.includes('spawn')) {
    return 'starting';
  }
  return null;
}

// Goose 1.60's built-in model list for the ChatGPT Codex provider stops at
// the GPT-5.6 family, but the provider accepts any model id the account is
// entitled to (verified via session/set_config_option). Append the models
// the account's Codex catalog actually offers (backend catalog, 2026-11-19)
// so the latest models can be picked in the UI. Dedupe makes this a no-op
// once Goose ships them itself.
const CODEX_EXTRA_MODELS: Array<{ value: string; name: string }> = [
  { value: 'gpt-6.2-sol', name: 'GPT-6.2 Sol' },
  { value: 'gpt-6.2-astra', name: 'GPT-6.2 Astra' },
  { value: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
  { value: 'gpt-6.1-terra', name: 'GPT-6.1 Terra' },
  { value: 'gpt-6-sol', name: 'GPT-6 Sol' },
  { value: 'gpt-6-astra', name: 'GPT-6 Astra' },
  { value: 'gpt-6-luna', name: 'GPT-6 Luna' },
  { value: 'gpt-reserve', name: 'GPT-Reserve' },
];

/** Numeric version key of a model id: 'gpt-6.2-sol' -> [6, 2]. */
function modelVersionKey(id: string): number[] {
  const key: number[] = [];
  for (const part of id.match(/\d+(?:\.\d+)?/g) ?? []) {
    for (const n of part.split('.')) key.push(parseInt(n, 10));
  }
  return key;
}

/** Newest version first; equal versions keep their original order. */
function compareModelDesc(a: string, b: string): number {
  const ka = modelVersionKey(a);
  const kb = modelVersionKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (kb[i] ?? 0) - (ka[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

function sortModelOptions(opts: any[]): any[] {
  if (opts.every(o => o && typeof o.value === 'string')) {
    return [...opts].sort((a, b) => compareModelDesc(a.value, b.value));
  }
  const groups = opts.map(o => (o && Array.isArray(o.options)
    ? { ...o, options: sortModelOptions(o.options) }
    : o));
  return groups.sort((a, b) => compareModelDesc(
    a?.options?.[0]?.value ?? a?.value ?? '',
    b?.options?.[0]?.value ?? b?.value ?? '',
  ));
}

function augmentConfigOptions(options: SessionConfigOption[]): SessionConfigOption[] {
  const provider = options.find(o => o.id === 'provider');
  if (!provider || provider.currentValue !== 'chatgpt_codex') return options;
  const model = options.find(o => o.id === 'model');
  if (!model || !Array.isArray((model as any).options)) return options;
  const existing = new Set<string>();
  const collect = (opts: any[]) => {
    for (const o of opts) {
      if (o && typeof o.value === 'string') existing.add(o.value);
      if (o && Array.isArray(o.options)) collect(o.options);
    }
  };
  collect((model as any).options);
  const missing = CODEX_EXTRA_MODELS.filter(m => !existing.has(m.value));
  const merged = [...(model as any).options, ...missing];
  // Newest GPT first, so the picker reads 6.2 -> 6.1 -> 6 -> 5.6 -> ...
  const sorted = sortModelOptions(merged);
  return options.map(o => (o === model
    ? { ...o, options: sorted } as SessionConfigOption
    : o));
}

export const useSessionStore = defineStore('session', () => {
  // State
  const savedSessions = ref<SavedSession[]>([]);
  const currentSession = ref<SavedSession | null>(null);
  const messages = ref<ChatMessage[]>([]);
  const toolCalls = ref<Map<string, ToolCallInfo>>(new Map());
  const isConnected = ref(false);
  const isLoading = ref(false);
  const isLoadingHistory = ref(false);
  const isConnecting = ref(false);
  // True while a foreground reconnect attempt is in flight. Distinct from
  // `isConnecting` (which is the multi-phase initial spawn/connect path):
  // reconnects skip the spawn/stderr-progress UI and just need a small
  // "Reconnecting…" indicator.
  const isReconnecting = ref(false);
  const error = ref<string | null>(null);
  const pendingPermission = ref<PermissionRequest | null>(null);
  
  // Authentication state
  const pendingAuthMethods = ref<AuthMethod[]>([]);
  const pendingAuthAgentName = ref<string>('');
  let authMethodResolver: ((methodId: string | null) => void) | null = null;
  
  // Session modes
  const availableModes = ref<SessionMode[]>([]);
  const currentModeId = ref<string>('');
  
  // Slash commands
  const availableCommands = ref<SlashCommand[]>([]);
  
  // Session models
  const availableModels = ref<ModelInfo[]>([]);
  const currentModelId = ref<string>('');
  const configOptions = ref<SessionConfigOption[]>([]);
  
  // Context usage streamed by the agent via usage_update notifications:
  // tokens used vs. context window size, plus accumulated cost if given.
  const usage = ref<{ used: number; size: number; costAmount?: number; costCurrency?: string } | null>(null);
  
  // User-renamed session titles, keyed by the agent's sessionId. Kept as
  // an overlay on top of server titles so session syncs and agent
  // auto-titles never clobber a name the user chose themselves.
  const titleOverrides = ref<Record<string, string>>({});
  
  // Device-side history cache: while a session's server replay is in
  // flight, cached messages are shown and incoming replay updates are
  // queued; when the load finishes the queue is applied over a clean
  // slate and the cache is refreshed. The server copy always wins.
  const showingCachedHistory = ref(false);
  let reconcileSessionId: string | null = null;
  let replayQueue: SessionNotification[] = [];

  function persistHistory() {
    const sid = currentSession.value?.sessionId;
    if (!sid || messages.value.length === 0) return;
    void putCachedHistory(sid, messages.value);
  }

  // The agent's current plan for the session (from `plan` updates).
  const planEntries = ref<{ content: string; status: string; priority?: string }[]>([]);

  // Normalize raw ACP tool-call content into the shape the UI renders:
  // text output, file diffs, and terminal references.
  function mapToolContent(raw: unknown): ToolCallContentItem[] {
    if (!Array.isArray(raw)) return [];
    const out: ToolCallContentItem[] = [];
    for (const item of raw as Record<string, any>[]) {
      if (item?.type === 'content') {
        const block = item.content as Record<string, any> | undefined;
        if (block?.type === 'text' && typeof block.text === 'string') {
          out.push({ kind: 'text', text: block.text });
        }
      } else if (item?.type === 'diff') {
        out.push({ kind: 'diff', path: item.path, oldText: item.oldText ?? null, newText: item.newText ?? '' });
      } else if (item?.type === 'terminal') {
        out.push({ kind: 'terminal', terminalId: item.terminalId });
      }
    }
    return out;
  }
  
  // Extract MCP App metadata from a raw session update's _meta
  // (_meta.goose.mcpApp), including the app HTML when the server
  // embeds the resource result in the update itself.
  function extractMcpApp(update: unknown): McpAppInfo | undefined {
    const meta = (update as Record<string, any>)?._meta?.goose?.mcpApp as Record<string, any> | undefined;
    if (!meta || typeof meta.resourceUri !== 'string') return undefined;
    let html: string | undefined;
    const contents = meta.resourceResult?.contents as Record<string, any>[] | undefined;
    if (Array.isArray(contents)) {
      const first = contents.find(c => typeof c?.text === 'string');
      if (first) html = first.text as string;
    }
    return {
      resourceUri: meta.resourceUri,
      extensionName: typeof meta.extensionName === 'string' ? meta.extensionName : '',
      toolName: typeof meta.toolName === 'string' ? meta.toolName : '',
      html,
    };
  }

  // Connection cancellation
  let connectionAborted = false;
  
  // Startup progress tracking
  const startupPhase = ref<string>('starting');
  const startupLogs = ref<string[]>([]);
  const startupElapsed = ref<number>(0);
  let startupTimer: ReturnType<typeof setInterval> | null = null;
  let stderrUnlisten: (() => void) | null = null;
  
  // Current ACP client
  let acpClient: AcpClientBridge | null = null;
  let store: KVStore | null = null;

  // Computed
  const hasActiveSession = computed(() => currentSession.value !== null);
  const messageList = computed(() => messages.value);
  const toolCallList = computed(() => Array.from(toolCalls.value.values()));
  // Only sessions that support resuming (loadSession capability)
  const resumableSessions = computed(() => 
    savedSessions.value.filter(s => s.supportsLoadSession === true)
  );

  // Initialize store
  async function initStore() {
    store = await loadKvStore(STORE_PATH);
    const saved = await store.get<SavedSession[]>('sessions');
    if (saved) {
      savedSessions.value = saved;
    }
    const overrides = await store.get<Record<string, string>>('titleOverrides');
    if (overrides) {
      titleOverrides.value = overrides;
    }
    
    // Load app version (Tauri API on desktop/mobile, build-time inject on web)
    try {
      appVersion = await getAppVersion();
    } catch (e) {
      console.warn('Failed to get app version:', e);
    }
  }

  async function saveSessionsToStore() {
    if (store) {
      await store.set('sessions', savedSessions.value);
      await store.save();
    }
  }

  async function saveTitleOverrides() {
    if (store) {
      await store.set('titleOverrides', titleOverrides.value);
      await store.save();
    }
  }

  // Rename a session (display only): records a title override keyed by
  // the agent sessionId. An empty title clears the override.
  async function renameSession(sessionId: string, title: string): Promise<void> {
    const next = { ...titleOverrides.value };
    if (title.trim()) next[sessionId] = title.trim();
    else delete next[sessionId];
    titleOverrides.value = next;
    await saveTitleOverrides();
  }

  // Merge in sessions the agent itself knows about (via session/list) that
  // this client has never seen - e.g. sessions created from Goose Desktop
  // against the same goose-serve. The server is the shared source of truth
  // for sessions; without this, the list only ever shows sessions created
  // from this very client. Failures are non-fatal (list stays local-only).
  async function syncServerSessions(
    agentName: string,
    supportsLoadSession: boolean,
    canListSessions: boolean
  ): Promise<void> {
    if (!acpClient || !supportsLoadSession || !canListSessions) return;
    try {
      const known = new Set(savedSessions.value.map(s => s.sessionId));
      let cursor: string | undefined;
      let changed = false;
      do {
        const resp = await acpClient.listSessions(cursor ? { cursor } : {});
        for (const info of resp.sessions ?? []) {
          if (!info.sessionId || known.has(info.sessionId)) continue;
          known.add(info.sessionId);
          savedSessions.value.push({
            id: crypto.randomUUID(),
            agentName,
            sessionId: info.sessionId,
            title: info.title || `Session ${info.sessionId}`,
            lastUpdated: info.updatedAt ? (Date.parse(info.updatedAt) || Date.now()) : Date.now(),
            cwd: info.cwd || '',
            supportsLoadSession: true,
          });
          changed = true;
        }
        cursor = resp.nextCursor ?? undefined;
      } while (cursor);
      if (changed) {
        await saveSessionsToStore();
      }
    } catch (e) {
      console.warn('Failed to sync server sessions:', e);
    }
  }

  // Handle an unexpected transport close (e.g. WebSocket dropped while idle,
  // local agent process exited). The bridge has already rejected any
  // in-flight requests; we just need to tear down UI state so the user gets
  // a clear "disconnected" signal instead of a stale "connected" view.
  function handleUnexpectedClose(reason?: string): void {
    // If `acpClient` is already null, this fired during a voluntary
    // disconnect that's tearing down anyway — nothing to do.
    if (!acpClient) return;
    acpClient = null;
    isConnected.value = false;
    isLoading.value = false;
    pendingPermission.value = null;
    error.value = `Connection lost: ${reason ?? 'transport closed'}`;
  }

  // Session update handler
  function handleSessionUpdate(notification: SessionNotification) {
    // During a cache-backed resume, queue replay updates instead of
    // applying them on top of the cached preview.
    if (reconcileSessionId && notification.sessionId === reconcileSessionId) {
      replayQueue.push(notification);
      return;
    }
    const update = notification.update;
    
    // usage_update is streamed by Goose but is not part of the SDK's
    // SessionUpdate union type, so it is handled before the typed switch.
    if ((update as { sessionUpdate?: string }).sessionUpdate === 'usage_update') {
      const u = update as unknown as { used?: number; size?: number; cost?: { amount?: number; currency?: string } };
      if (typeof u.used === 'number' && typeof u.size === 'number') {
        usage.value = {
          used: u.used,
          size: u.size,
          costAmount: u.cost?.amount,
          costCurrency: u.cost?.currency,
        };
      }
    }

    switch (update.sessionUpdate) {
      case 'user_message_chunk':
        // Append to last user message or create new (for replay)
        const lastUserMsg = messages.value[messages.value.length - 1];
        if (lastUserMsg && lastUserMsg.role === 'user') {
          if (update.content.type === 'text') {
            lastUserMsg.content += update.content.text;
          }
        } else {
          messages.value.push({
            id: crypto.randomUUID(),
            role: 'user',
            content: update.content.type === 'text' ? update.content.text : '',
            timestamp: Date.now(),
          });
        }
        break;

      case 'agent_message_chunk':
        // Append to last assistant message or create new
        const lastMsg = messages.value[messages.value.length - 1];
        if (lastMsg && lastMsg.role === 'assistant') {
          if (update.content.type === 'text') {
            lastMsg.content += update.content.text;
          }
        } else {
          messages.value.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: update.content.type === 'text' ? update.content.text : '',
            timestamp: Date.now(),
            toolCalls: [],
          });
        }
        break;

      case 'agent_thought_chunk':
        // Append to last assistant message's thought field or create new
        const lastAssistantMsg = messages.value[messages.value.length - 1];
        if (lastAssistantMsg && lastAssistantMsg.role === 'assistant') {
          if (update.content.type === 'text') {
            lastAssistantMsg.thought = (lastAssistantMsg.thought || '') + update.content.text;
          }
        } else {
          messages.value.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: '',
            thought: update.content.type === 'text' ? update.content.text : '',
            timestamp: Date.now(),
            toolCalls: [],
          });
        }
        break;

      case 'tool_call':
        // Add tool call to the current assistant message
        let currentAssistantMsg = messages.value[messages.value.length - 1];
        if (!currentAssistantMsg || currentAssistantMsg.role !== 'assistant') {
          // Tool-first turn: no assistant message exists yet (the agent
          // called a tool before any text/thought chunk). Create one so
          // the tool call - and any MCP App attached to it - renders.
          currentAssistantMsg = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
            toolCalls: [],
          };
          messages.value.push(currentAssistantMsg);
        }
        if (currentAssistantMsg && currentAssistantMsg.role === 'assistant') {
          if (!currentAssistantMsg.toolCalls) {
            currentAssistantMsg.toolCalls = [];
          }
          currentAssistantMsg.toolCalls.push({
            toolCallId: update.toolCallId,
            title: update.title,
            kind: update.kind || 'other',
            status: update.status || 'pending',
            locations: update.locations,
            content: mapToolContent(update.content),
            rawInput: (update as any).rawInput as Record<string, unknown> | undefined,
            mcpApp: extractMcpApp(update),
          });
        }
        // Also keep in global map for updates
        toolCalls.value.set(update.toolCallId, {
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind || 'other',
          status: update.status || 'pending',
          locations: update.locations,
          content: mapToolContent(update.content),
          rawInput: (update as any).rawInput as Record<string, unknown> | undefined,
          mcpApp: extractMcpApp(update),
        });
        break;

      case 'tool_call_update':
        const existing = toolCalls.value.get(update.toolCallId);
        if (existing) {
          if (update.status) existing.status = update.status;
          if (update.title) existing.title = update.title;
          if (update.content?.length) existing.content = mapToolContent(update.content);
          if (Array.isArray((update as any).content)) existing.rawContent = (update as any).content as unknown[];
          if ((update as any).rawOutput !== undefined) existing.rawOutput = (update as any).rawOutput;
          const appMeta = extractMcpApp(update);
          if (appMeta) existing.mcpApp = appMeta;
          // Also update in the message's toolCalls array
          for (const msg of messages.value) {
            if (msg.toolCalls) {
              const tc = msg.toolCalls.find(t => t.toolCallId === update.toolCallId);
              if (tc) {
                if (update.status) tc.status = update.status;
                if (update.title) tc.title = update.title;
                if (update.content?.length) tc.content = mapToolContent(update.content);
                if (Array.isArray((update as any).content)) tc.rawContent = (update as any).content as unknown[];
                if ((update as any).rawOutput !== undefined) tc.rawOutput = (update as any).rawOutput;
                if (appMeta) tc.mcpApp = appMeta;
              }
            }
          }
        }
        break;

      case 'plan':
        // The agent published or revised its plan for this session
        planEntries.value = (update.entries || []).map(e => ({
          content: e.content,
          status: e.status,
          priority: e.priority,
        }));
        break;

      case 'current_mode_update':
        // Agent changed the mode
        if ('modeId' in update && update.modeId) {
          currentModeId.value = update.modeId as string;
        }
        break;

      case 'config_option_update':
        // Agent replaced the session config options (provider/model/etc.)
        if ('configOptions' in update && Array.isArray(update.configOptions)) {
          configOptions.value = augmentConfigOptions(update.configOptions as SessionConfigOption[]);
        }
        break;

      case 'available_commands_update':
        // Agent advertised slash commands
        if ('availableCommands' in update && Array.isArray(update.availableCommands)) {
          availableCommands.value = update.availableCommands.map((cmd) => ({
            name: cmd.name,
            description: cmd.description,
            hint: cmd.input?.hint ?? undefined,
          }));
        }
        break;


      case 'session_info_update': {
        // Agent-generated session title (arrives after the first exchange)
        const info = update as { title?: string | null };
        if (info.title && currentSession.value) {
          currentSession.value.title = info.title;
          const saved = savedSessions.value.find(s => s.sessionId === currentSession.value?.sessionId);
          if (saved) saved.title = info.title;
        }
        break;
      }

      default:
        console.log('Unhandled session update:', update);
    }
  }

  // Prompt user to select auth method
  async function promptForAuthMethod(authMethods: AuthMethod[], agentName: string): Promise<string | null> {
    return new Promise((resolve) => {
      pendingAuthMethods.value = authMethods;
      pendingAuthAgentName.value = agentName;
      authMethodResolver = resolve;
    });
  }

  // User selected an auth method
  function selectAuthMethod(methodId: string): void {
    if (authMethodResolver) {
      authMethodResolver(methodId);
      authMethodResolver = null;
      pendingAuthMethods.value = [];
      pendingAuthAgentName.value = '';
    }
  }

  // User cancelled auth selection
  function cancelAuthSelection(): void {
    if (authMethodResolver) {
      authMethodResolver(null);
      authMethodResolver = null;
      pendingAuthMethods.value = [];
      pendingAuthAgentName.value = '';
    }
  }

  // Create new session
  async function createSession(agentName: string, cwd: string, extraMcpServers: unknown[] = []): Promise<void> {
    isLoading.value = true;
    isConnecting.value = true;
    connectionAborted = false;
    error.value = null;

    // Look up the agent's transport kind so we know whether to do the
    // stdio-only startup choreography (spawn → stderr progress) or the
    // streamlined remote path (just open a network transport).
    const configStore = useConfigStore();
    const agentConfig: AgentConfig | undefined = configStore.getAgent(agentName);
    const transportKind = agentConfig
      ? getTransportKind(agentConfig)
      : 'stdio';
    const isRemote = transportKind !== 'stdio';

    // Reset and start progress tracking
    startupPhase.value = 'starting';
    startupLogs.value = [];
    startupElapsed.value = 0;
    startupTimer = setInterval(() => {
      startupElapsed.value++;
    }, 1000);

    // Track the spawned stdio instance separately so we can `killAgent` it
    // if cancellation/abort happens before we've wrapped it in a bridge.
    // Once `acpClient` is set, ownership transfers to the bridge and
    // `acpClient.disconnect()` becomes the only correct cleanup path.
    let spawnedInstance: { id: string } | null = null;

    try {
      if (!agentConfig) {
        throw new Error(`Agent '${agentName}' not found in config`);
      }

      if (!isRemote) {
        // For stdio agents we need the spawned process's id up front so the
        // stderr listener can filter on it (multiple agents may be running
        // concurrently). We spawn here, hand the resulting AgentInstance to
        // a StdioTransport, then build the bridge from that transport.
        startupPhase.value = 'starting';
        const agentInstance = await spawnAgent(agentName);
        spawnedInstance = agentInstance;

        stderrUnlisten = await onAgentStderr((stderr) => {
          if (stderr.agent_id !== agentInstance.id) return;
          startupLogs.value.push(stderr.line);
          // Detect phase from output
          const detectedPhase = detectPhase(stderr.line);
          if (detectedPhase) {
            startupPhase.value = detectedPhase;
          }
        }) as unknown as () => void;

        if (connectionAborted) {
          // Process was spawned but no bridge exists yet — kill the orphan
          // before throwing so the local agent doesn't keep running.
          await killAgent(agentInstance.id).catch((err) =>
            console.warn('killAgent during abort failed:', err)
          );
          spawnedInstance = null;
          throw new Error('Connection cancelled');
        }

        startupPhase.value = 'initializing';

        // Wrap the just-spawned instance in a StdioTransport. Using the
        // legacy single-arg form keeps backward compatibility and avoids a
        // double-spawn (StdioTransport.spawn would call spawnAgent again).
        acpClient = await createAcpClient(agentInstance);
        // Ownership of the child process now belongs to the bridge — clear
        // our local reference so the catch block doesn't double-kill it.
        spawnedInstance = null;
      } else {
        // Remote agents have no stderr stream; show a minimal "connecting"
        // state instead of the multi-phase progress UI.
        startupPhase.value = 'connecting';

        if (connectionAborted) {
          throw new Error('Connection cancelled');
        }

        // The factory opens a WebSocket / HTTP connection based on
        // agentConfig.transport.
        acpClient = await createAcpClient({ name: agentName, config: agentConfig });
      }

      acpClient.onSessionUpdate = handleSessionUpdate;
      // Surface unexpected transport closes (e.g. WebSocket drop while idle)
      // to the UI so users don't sit on a stale "connected" state forever.
      acpClient.onTransportClose = (reason) => {
        handleUnexpectedClose(reason);
      };
      
      // Sync bridge's pendingPermissionRequest to store's pendingPermission
      watch(
        () => acpClient?.pendingPermissionRequest.value,
        (newValue) => {
          pendingPermission.value = newValue ?? null;
        },
        { immediate: true }
      );

      if (connectionAborted) {
        await acpClient.disconnect();
        throw new Error('Connection cancelled');
      }

      startupPhase.value = 'connecting';

      // Initialize connection
      // Only Tauri desktop has real filesystem access; mobile and web
      // cannot fulfil readTextFile / writeTextFile RPCs.
      const canAccessFs = isDesktop();

      const initResponse = await acpClient.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: {
            readTextFile: canAccessFs,
            writeTextFile: canAccessFs,
          },
          // Declare MCP Apps support so goose-serve hydrates app tools
          // (attaches _meta.goose.mcpApp + the ui:// resource) for this
          // client - same declaration the Goose desktop app sends.
          _meta: {
            goose: {
              mcpHostCapabilities: {
                extensions: {
                  'io.modelcontextprotocol/ui': {
                    mimeTypes: ['text/html;profile=mcp-app'],
                  },
                },
              },
            },
          },
        },
        clientInfo: {
          name: 'acp-ui',
          title: 'ACP UI',
          version: appVersion,
        },
      });

      console.log('Agent initialized:', initResponse);

      // Check if agent supports session loading
      const supportsLoadSession = initResponse.agentCapabilities?.loadSession ?? false;

      // Show sessions that already exist on the agent (e.g. created from
      // Goose Desktop against the same server) in the list, so they can
      // be resumed from here too - not just sessions created locally.
      await syncServerSessions(
        agentName,
        supportsLoadSession,
        initResponse.agentCapabilities?.sessionCapabilities?.list != null
      );

      if (connectionAborted) {
        await acpClient.disconnect();
        throw new Error('Connection cancelled');
      }

      // Store available auth methods for potential retry
      const availableAuthMethods = initResponse.authMethods || [];

      if (connectionAborted) {
        await acpClient.disconnect();
        throw new Error('Connection cancelled');
      }

      // Try to create session - may fail with auth_required
      let sessionResponse;
      try {
        sessionResponse = await acpClient.newSession({
          cwd,
          mcpServers: extraMcpServers as any,
        });
      } catch (sessionError: unknown) {
        // Check if auth is required (error code -32000)
        const errorMessage = sessionError instanceof Error ? sessionError.message : String(sessionError);
        const isAuthRequired = errorMessage.toLowerCase().includes('authentication required') ||
                               errorMessage.includes('-32000');
        
        if (isAuthRequired && availableAuthMethods.length > 0) {
          console.log('Authentication required, available methods:', availableAuthMethods);
          
          // Prompt user to select auth method
          const selectedMethodId = await promptForAuthMethod(availableAuthMethods, agentName);
          
          if (!selectedMethodId || connectionAborted) {
            await acpClient.disconnect();
            throw new Error('Authentication cancelled by user');
          }
          
          console.log('Authenticating with method:', selectedMethodId);
          const authResponse = await acpClient.authenticate({
            methodId: selectedMethodId,
          });
          console.log('Authentication successful:', authResponse);

          if (connectionAborted) {
            await acpClient.disconnect();
            throw new Error('Connection cancelled');
          }

          // Retry session creation after auth
          sessionResponse = await acpClient.newSession({
            cwd,
            mcpServers: [],
          });
        } else {
          throw sessionError;
        }
      }

      // Save session
      const session: SavedSession = {
        id: crypto.randomUUID(),
        agentName,
        sessionId: sessionResponse.sessionId,
        title: `Session ${new Date().toLocaleString()}`,
        lastUpdated: Date.now(),
        cwd,
        supportsLoadSession,
      };

      currentSession.value = session;
      savedSessions.value.push(session);
      await saveSessionsToStore();
      
      isConnected.value = true;
      messages.value = [];
      toolCalls.value.clear();
      usage.value = null;
      planEntries.value = [];
      
      // Track successful session creation
      trackEvent('SessionCreated', { agentName, success: 'true' });
      
      // Set up session modes if available
      if (sessionResponse.modes) {
        availableModes.value = (sessionResponse.modes.availableModes || []).map(m => ({
          id: m.id,
          name: m.name,
          description: m.description ?? undefined,
        }));
        currentModeId.value = sessionResponse.modes.currentModeId || '';
      } else {
        availableModes.value = [];
        currentModeId.value = '';
      }

      // Set up session models if available
      if (sessionResponse.models) {
        availableModels.value = (sessionResponse.models.availableModels || []).map(m => ({
          modelId: m.modelId,
          name: m.name,
          description: m.description ?? undefined,
        }));
        currentModelId.value = sessionResponse.models.currentModelId || '';
      } else {
        availableModels.value = [];
        currentModelId.value = '';
      }

      // Set up session config options if available (agents like Goose
      // expose provider / model / thinking effort as config options
      // instead of the `models` state above)
      configOptions.value = augmentConfigOptions(sessionResponse.configOptions ?? []);

    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      // We may have optimistically entered the session above; back out.
      currentSession.value = null;
      isConnected.value = false;
      // Tear down whichever side of the connection is live. The bridge owns
      // the spawned process once it exists, so prefer disconnecting it.
      // Otherwise (e.g. abort right after spawn but before bridge creation)
      // kill the orphaned local agent directly.
      if (acpClient) {
        try {
          await acpClient.disconnect();
        } catch (cleanupErr) {
          console.warn('disconnect during createSession cleanup failed:', cleanupErr);
        }
      } else if (spawnedInstance) {
        try {
          await killAgent(spawnedInstance.id);
        } catch (cleanupErr) {
          console.warn('killAgent during createSession cleanup failed:', cleanupErr);
        }
      }
      acpClient = null;
      // Track session creation failure
      trackEvent('SessionCreated', { agentName, success: 'false' });
      trackError(e instanceof Error ? e : new Error(String(e)));
      throw e;
    } finally {
      isLoading.value = false;
      isConnecting.value = false;
      // Clean up startup progress tracking
      if (startupTimer) {
        clearInterval(startupTimer);
        startupTimer = null;
      }
      if (stderrUnlisten) {
        stderrUnlisten();
        stderrUnlisten = null;
      }
    }
  }

  // Resume existing session
  async function resumeSession(savedSession: SavedSession): Promise<void> {
    isLoading.value = true;
    error.value = null;

    try {
      const configStore = useConfigStore();
      const agentConfig: AgentConfig | undefined = configStore.getAgent(savedSession.agentName);
      if (!agentConfig) {
        throw new Error(`Agent '${savedSession.agentName}' not found in config`);
      }

      // Create ACP client bridge (transport selected based on agent config).
      acpClient = await createAcpClient({
        name: savedSession.agentName,
        config: agentConfig,
      });
      acpClient.onSessionUpdate = handleSessionUpdate;
      // Surface unexpected transport closes (e.g. WebSocket dropped while idle,
      // local agent process crashed) so the UI doesn't sit on a stale
      // "connected" view forever.
      acpClient.onTransportClose = (reason) => {
        handleUnexpectedClose(reason);
      };

      // Sync bridge's pendingPermissionRequest to store's pendingPermission
      watch(
        () => acpClient?.pendingPermissionRequest.value,
        (newValue) => {
          pendingPermission.value = newValue ?? null;
        },
        { immediate: true }
      );

      // Only Tauri desktop has real filesystem access; mobile and web
      // cannot fulfil readTextFile / writeTextFile RPCs.
      const canAccessFs = isDesktop();

      // Initialize connection
      const initResponse = await acpClient.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: {
            readTextFile: canAccessFs,
            writeTextFile: canAccessFs,
          },
          // Declare MCP Apps support so goose-serve hydrates app tools
          // (attaches _meta.goose.mcpApp + the ui:// resource) for this
          // client - same declaration the Goose desktop app sends.
          _meta: {
            goose: {
              mcpHostCapabilities: {
                extensions: {
                  'io.modelcontextprotocol/ui': {
                    mimeTypes: ['text/html;profile=mcp-app'],
                  },
                },
              },
            },
          },
        },
        clientInfo: {
          name: 'acp-ui',
          title: 'ACP UI',
          version: appVersion,
        },
      });

      // Store available auth methods for potential retry
      const availableAuthMethods = initResponse.authMethods || [];

      // Device cache first: show the locally cached history instantly,
      // then let the server replay reconcile in the background (its
      // updates are queued while the load is in flight).
      const cachedHistory = await getCachedHistory(savedSession.sessionId).catch(() => null);
      messages.value = cachedHistory ?? [];
      toolCalls.value.clear();
      usage.value = null;
      planEntries.value = [];
      if (cachedHistory && cachedHistory.length > 0) {
        showingCachedHistory.value = true;
        reconcileSessionId = savedSession.sessionId;
        replayQueue = [];
      }

      // Enter the session immediately: the chat view opens now and the
      // replayed history streams into it, instead of the user waiting
      // on the welcome screen until the whole history has arrived.
      currentSession.value = savedSession;
      isConnected.value = true;
      isLoadingHistory.value = true;

      let loadResponse: LoadSessionResponse | undefined;

      // Try to load existing session - may fail with auth_required
      try {
        loadResponse = await acpClient.loadSession({
          sessionId: savedSession.sessionId,
          cwd: savedSession.cwd,
          mcpServers: [],
        });
      } catch (sessionError: unknown) {
        // Check if auth is required (error code -32000)
        const errorMessage = sessionError instanceof Error ? sessionError.message : String(sessionError);
        const isAuthRequired = errorMessage.toLowerCase().includes('authentication required') ||
                               errorMessage.includes('-32000');
        
        if (isAuthRequired && availableAuthMethods.length > 0) {
          console.log('Authentication required, available methods:', availableAuthMethods);
          
          // Prompt user to select auth method
          const selectedMethodId = await promptForAuthMethod(availableAuthMethods, savedSession.agentName);
          
          if (!selectedMethodId) {
            await acpClient.disconnect();
            throw new Error('Authentication cancelled by user');
          }
          
          console.log('Authenticating with method:', selectedMethodId);
          const authResponse = await acpClient.authenticate({
            methodId: selectedMethodId,
          });
          console.log('Authentication successful:', authResponse);

          // Retry loading session after auth
          loadResponse = await acpClient.loadSession({
            sessionId: savedSession.sessionId,
            cwd: savedSession.cwd,
            mcpServers: [],
          });
        } else {
          throw sessionError;
        }
      }

      // Populate modes / models / config options from the load response,
      // so the pickers keep working on resumed sessions too
      if (loadResponse) {
        if (loadResponse.modes) {
          availableModes.value = (loadResponse.modes.availableModes || []).map(m => ({
            id: m.id,
            name: m.name,
            description: m.description ?? undefined,
          }));
          currentModeId.value = loadResponse.modes.currentModeId || '';
        }
        if (loadResponse.models) {
          availableModels.value = (loadResponse.models.availableModels || []).map(m => ({
            modelId: m.modelId,
            name: m.name,
            description: m.description ?? undefined,
          }));
          currentModelId.value = loadResponse.models.currentModelId || '';
        }
        configOptions.value = augmentConfigOptions(loadResponse.configOptions ?? []);
      }

      // Replay finished: rebuild from the queued server updates (the
      // authoritative copy) and refresh the device cache.
      if (reconcileSessionId === savedSession.sessionId) {
        const queued = replayQueue;
        reconcileSessionId = null;
        replayQueue = [];
        messages.value = [];
        toolCalls.value.clear();
        for (const n of queued) handleSessionUpdate(n);
        showingCachedHistory.value = false;
        persistHistory();
      }
      isLoadingHistory.value = false;

      // Refresh the merged session list from the agent as well (best
      // effort, unawaited: it must not delay entering the session).
      void syncServerSessions(
        savedSession.agentName,
        initResponse.agentCapabilities?.loadSession ?? false,
        initResponse.agentCapabilities?.sessionCapabilities?.list != null
      );

      // Track successful session resume
      trackEvent('SessionResumed', { agentName: savedSession.agentName, success: 'true' });

      // Update last accessed time
      savedSession.lastUpdated = Date.now();
      await saveSessionsToStore();

    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      // Disconnect the bridge if it was created — otherwise we leak the
      // spawned stdio process or open WebSocket on initialize/loadSession
      // failure.
      if (acpClient) {
        try {
          await acpClient.disconnect();
        } catch (cleanupErr) {
          console.warn('disconnect during resumeSession cleanup failed:', cleanupErr);
        }
        acpClient = null;
      }
      // Track session resume failure
      trackEvent('SessionResumed', { agentName: savedSession.agentName, success: 'false' });
      trackError(e instanceof Error ? e : new Error(String(e)));
      throw e;
    } finally {
      isLoading.value = false;
      isLoadingHistory.value = false;
      // If the load failed, the cached preview (if any) stays on screen
      // and showingCachedHistory remains set so the UI can say so.
      reconcileSessionId = null;
      replayQueue = [];
    }
  }

  // Send prompt
  // ---- MCP Apps (ext-apps) host support -------------------------------
  // App HTML and app-initiated tool calls ride the same ACP connection
  // via Goose's `_goose/unstable/*` extension methods; no extra channel.
  const toolDefCache = new Map<string, { name: string; description?: string; inputSchema?: unknown }>();

  async function mcpAppReadResource(sessionId: string, extensionName: string, uri: string): Promise<{ uri: string; mimeType: string | null; text: string }> {
    if (!acpClient) throw new Error('Not connected');
    const resp = await acpClient.extRequest<{ result?: { contents?: Record<string, any>[] } }>(
      '_goose/unstable/resources/read', { sessionId, extensionName, uri });
    const contents = resp?.result?.contents || [];
    const first = contents.find(c => typeof c?.text === 'string') || contents[0];
    if (!first) throw new Error(`Resource '${uri}' returned no contents`);
    let text = typeof first.text === 'string' ? first.text : '';
    if (!text && typeof first.blob === 'string') {
      const bin = atob(first.blob);
      const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0));
      text = new TextDecoder().decode(bytes);
    }
    return { uri: typeof first.uri === 'string' ? first.uri : uri, mimeType: (first.mimeType as string) ?? null, text };
  }

  async function mcpAppCallTool(sessionId: string, extensionName: string, name: string, args: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
    if (!acpClient) throw new Error('Not connected');
    const resp = await acpClient.extRequest<Record<string, any>>(
      '_goose/unstable/tools/call',
      { sessionId, extensionName, name: `${extensionName}__${name}`, arguments: args || {} });
    return {
      content: Array.isArray(resp?.content) ? resp.content : [],
      isError: !!resp?.isError,
      ...(resp?.structuredContent !== undefined ? { structuredContent: resp.structuredContent } : {}),
      ...(resp?._meta !== undefined ? { _meta: resp._meta } : {}),
    };
  }

  async function mcpAppToolDef(sessionId: string, extensionName: string, toolName: string): Promise<{ name: string; description?: string; inputSchema?: unknown } | undefined> {
    const key = `${sessionId}:${extensionName}__${toolName}`;
    const cached = toolDefCache.get(key);
    if (cached) return cached;
    if (!acpClient) return undefined;
    const resp = await acpClient.extRequest<{ tools?: Record<string, any>[] }>(
      '_goose/unstable/tools/list', { sessionId });
    const full = `${extensionName}__${toolName}`;
    const found = (resp?.tools || []).find(t => t?.name === full);
    if (!found) return undefined;
    const def = { name: toolName, description: found.description as string | undefined, inputSchema: found.inputSchema };
    toolDefCache.set(key, def);
    return def;
  }

  async function sendPrompt(
    text: string,
    images: { data: string; mimeType: string }[] = [],
    resources: ({ kind: 'file'; name: string; uri: string; text: string; mimeType: string } | { kind: 'link'; name: string; uri: string })[] = [],
  ): Promise<void> {
    if (!acpClient || !currentSession.value) {
      throw new Error('No active session');
    }

    // Add user message (with image previews when images are attached)
    messages.value.push({
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
      images: images.length
        ? images.map(i => `data:${i.mimeType};base64,${i.data}`)
        : undefined,
      resources: resources.length ? resources.map(r => r.name) : undefined,
    });

    isLoading.value = true;
    try {
      // ACP content blocks: the text block (when present) plus one
      // image block per attachment.
      const blocks: unknown[] = [];
      if (text) blocks.push({ type: 'text', text });
      for (const img of images) {
        blocks.push({ type: 'image', data: img.data, mimeType: img.mimeType });
      }
      // Embedded context (promptCapabilities.embeddedContext): files are
      // sent as resource blocks with their full text; links as
      // resource_link blocks for the agent to fetch.
      for (const res of resources) {
        if (res.kind === 'file') {
          blocks.push({ type: 'resource', resource: { uri: res.uri, mimeType: res.mimeType, text: res.text } });
        } else {
          blocks.push({ type: 'resource_link', uri: res.uri, name: res.name });
        }
      }
      const response = await acpClient.prompt({
        sessionId: currentSession.value.sessionId,
        prompt: blocks as any,
      });

      console.log('Prompt completed:', response.stopReason);

      // Track prompt sent
      trackEvent('PromptSent', { 
        messageLength: String(text.length),
        stopReason: response.stopReason || 'unknown',
      });

      // Update session title if it's the first message
      if (messages.value.length === 2 && currentSession.value) {
        const label = text || 'Image message';
        currentSession.value.title = label.slice(0, 50) + (label.length > 50 ? '...' : '');
        currentSession.value.lastUpdated = Date.now();
        await saveSessionsToStore();
      }
    } finally {
      isLoading.value = false;
      persistHistory();
    }
  }

  // Cancel current operation
  async function cancelOperation(): Promise<void> {
    if (!acpClient || !currentSession.value) return;
    
    await acpClient.cancel({
      sessionId: currentSession.value.sessionId,
    });
  }

  // Cancel ongoing connection attempt
  async function cancelConnection(): Promise<void> {
    connectionAborted = true;
    
    // Cancel auth selection if pending
    if (authMethodResolver) {
      authMethodResolver(null);
      authMethodResolver = null;
      pendingAuthMethods.value = [];
      pendingAuthAgentName.value = '';
    }
    
    // Disconnect if client exists
    if (acpClient) {
      try {
        await acpClient.disconnect();
      } catch (e) {
        console.error('Error disconnecting:', e);
      }
      acpClient = null;
    }
    
    isLoading.value = false;
    isConnecting.value = false;
    error.value = null;
  }

  // Handle permission response
  function resolvePermission(optionId: string): void {
    if (acpClient) {
      acpClient.resolvePermission(optionId);
    }
  }

  function cancelPermission(): void {
    if (acpClient) {
      acpClient.cancelPermission();
    }
  }

  // Disconnect current session
  async function disconnect(): Promise<void> {
    const agentName = currentSession.value?.agentName || 'unknown';
    const sessionStart = currentSession.value?.lastUpdated || Date.now();
    const sessionDuration = Math.round((Date.now() - sessionStart) / 1000);
    
    // Best effort: tell the agent to close the session before the
    // transport goes away, so it can free the session's resources.
    if (acpClient && currentSession.value) {
      try {
        await acpClient.closeSession({ sessionId: currentSession.value.sessionId });
      } catch { /* closing is best effort */ }
    }
    if (acpClient) {
      await acpClient.disconnect();
      acpClient = null;
    }
    
    // Track session disconnect
    trackEvent('SessionDisconnected', { 
      agentName,
      sessionDurationSeconds: String(sessionDuration),
      messageCount: String(messages.value.length),
    });
    
    currentSession.value = null;
    isConnected.value = false;
    messages.value = [];
    toolCalls.value.clear();
    availableModes.value = [];
    currentModeId.value = '';
    availableCommands.value = [];
    usage.value = null;
    planEntries.value = [];
    availableModels.value = [];
    currentModelId.value = '';
    configOptions.value = [];
  }

  // Delete saved session
  async function deleteSession(sessionId: string): Promise<void> {
    const entry = savedSessions.value.find(s => s.id === sessionId);
    if (entry) {
      // Delete it on the agent too (best effort): a local-only removal
      // would let the session reappear on the next session/list sync.
      if (acpClient) {
        try {
          await acpClient.deleteSession({ sessionId: entry.sessionId });
        } catch { /* the agent may not know it; local removal proceeds */ }
      }
      await renameSession(entry.sessionId, ''); // drop any title override
      void deleteCachedHistory(entry.sessionId);
      if (currentSession.value?.sessionId === entry.sessionId) {
        await disconnect();
      }
    }
    savedSessions.value = savedSessions.value.filter(s => s.id !== sessionId);
    await saveSessionsToStore();
  }

  // Set session mode
  async function setMode(modeId: string): Promise<void> {
    if (!acpClient || !currentSession.value) {
      throw new Error('No active session');
    }
    
    await acpClient.setMode({
      sessionId: currentSession.value.sessionId,
      modeId,
    });
    
    // Optimistically update the current mode
    currentModeId.value = modeId;
  }

  // Set session model
  async function setModel(modelId: string): Promise<void> {
    if (!acpClient || !currentSession.value) {
      throw new Error('No active session');
    }
    
    await acpClient.unstable_setSessionModel({
      sessionId: currentSession.value.sessionId,
      modelId,
    });
    
    // Optimistically update the current model
    currentModelId.value = modelId;
  }

  // Set a session config option (agents like Goose expose provider,
  // model and thinking effort as config options, not via set_model)
  async function setConfigOption(configId: string, value: string): Promise<void> {
    if (!acpClient || !currentSession.value) {
      throw new Error('No active session');
    }

    const resp = await acpClient.setConfigOption({
      sessionId: currentSession.value.sessionId,
      configId,
      value,
    });

    // The response carries the full, updated set of options
    if (resp?.configOptions) {
      configOptions.value = augmentConfigOptions(resp.configOptions);
    }
  }

  function clearError() {
    error.value = null;
  }

  /**
   * Foreground reconnect: when the user returns to the app and we're
   * disconnected (because the OS froze the WebView, the NAT killed the TCP
   * connection, or the network changed), silently re-attach to the saved
   * session if possible.
   *
   * Returns `true` if a reconnect was attempted, `false` if there was
   * nothing to do (no saved session, already connected/connecting, agent
   * doesn't advertise session-load support, etc.).
   *
   * Errors are surfaced via `error.value` exactly like a manual resume
   * would; the caller doesn't need to handle them.
   */
  async function tryReconnect(): Promise<boolean> {
    // Already connected or already trying — leave it alone.
    if (isConnected.value || isConnecting.value || isLoading.value) {
      return false;
    }
    // No prior session to reconnect to.
    const session = currentSession.value;
    if (!session) {
      return false;
    }
    // Bridge already exists (race with another reconnect in flight).
    if (acpClient) {
      return false;
    }
    // Agent must support `session/load` for resume to be meaningful;
    // otherwise we'd just create a fresh session, which is a strictly
    // user-initiated action.
    if (!session.supportsLoadSession) {
      return false;
    }

    // Clear the stale "Connection lost" banner up-front so the UI shows
    // an honest "Reconnecting…" state instead of a contradictory red
    // banner during the attempt. If the reconnect ultimately fails, the
    // catch below restores a real error message.
    error.value = null;
    isReconnecting.value = true;
    try {
      await resumeSession(session);
      return true;
    } catch (e) {
      // `resumeSession`'s own catch already wrote `error.value`; nothing
      // more to do here. Returning true so the caller knows we tried.
      console.warn('Foreground reconnect failed:', e);
      return true;
    } finally {
      isReconnecting.value = false;
    }
  }

  return {
    // State
    savedSessions,
    currentSession,
    messages,
    isConnected,
    isLoading,
    isLoadingHistory,
    showingCachedHistory,
    isConnecting,
    isReconnecting,
    error,
    pendingPermission,
    pendingAuthMethods,
    pendingAuthAgentName,
    availableModes,
    currentModeId,
    availableCommands,
    availableModels,
    currentModelId,
    configOptions,
    usage,
    startupPhase,
    startupLogs,
    startupElapsed,
    
    // Computed
    hasActiveSession,
    messageList,
    toolCallList,
    resumableSessions,
    
    // Actions
    initStore,
    createSession,
    resumeSession,
    sendPrompt,
    mcpAppReadResource,
    mcpAppCallTool,
    mcpAppToolDef,
    renameSession,
    titleOverrides,
    planEntries,
    cancelOperation,
    cancelConnection,
    resolvePermission,
    cancelPermission,
    selectAuthMethod,
    cancelAuthSelection,
    disconnect,
    deleteSession,
    setMode,
    setModel,
    setConfigOption,
    clearError,
    tryReconnect,
    
    // Expose client for permission handling
    get acpClient() { return acpClient; },
  };
});
