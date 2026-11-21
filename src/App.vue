<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, defineAsyncComponent } from 'vue';
import { canPickFolder, pickFolder, loadKvStore, type KVStore } from './lib/host';
import { useConfigStore } from './stores/config';
import { useSessionStore } from './stores/session';
import { useI18n } from './lib/i18n';
import { initTelemetry } from './lib/telemetry';
import AgentSelector from './components/AgentSelector.vue';
import SessionList from './components/SessionList.vue';
import ChatView from './components/ChatView.vue';
import PermissionDialog from './components/PermissionDialog.vue';
import Icon from './components/Icon.vue';
const SettingsView = defineAsyncComponent(() => import('./components/SettingsView.vue'));
const ExtensionsPage = defineAsyncComponent(() => import('./components/ExtensionsPage.vue'));
const RecipesPage = defineAsyncComponent(() => import('./components/RecipesPage.vue'));
const SchedulesPage = defineAsyncComponent(() => import('./components/SchedulesPage.vue'));
const SkillsPage = defineAsyncComponent(() => import('./components/SkillsPage.vue'));
import type { RecipeInfo } from './lib/gateway';
import AuthMethodDialog from './components/AuthMethodDialog.vue';
import TrafficMonitor from './components/TrafficMonitor.vue';
import StartupProgress from './components/StartupProgress.vue';
import type { SavedSession } from './lib/types';

const configStore = useConfigStore();
const sessionStore = useSessionStore();
const { t, locale, setLocale } = useI18n();

// Build timestamp injected by vite.config (define). Rendered under
// the sidebar nav so a phone still showing a cached pre-fix page
// can be identified immediately.
const buildStamp = (() => {
  const raw = (import.meta.env.VITE_BUILD_TIME as string | undefined) ?? '';
  const d = raw ? new Date(raw) : null;
  // Shown in the user's timezone (Asia/Shanghai) so it can be compared
  // against the phone clock at a glance.
  return d && !isNaN(d.getTime())
    ? d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16)
    : 'dev';
})();

const selectedAgent = ref('');
const selectedCwd = ref('');
// Optional per-session MCP server URL, passed to session/new
// (the agent accepts http MCP servers).
const sessionMcpUrl = ref('');
// On mobile / web there is no native folder picker (and the cwd refers to
// a path on the *agent's* machine, not the local device), so we expose a
// free-text field instead of the picker button.
const folderPickerAvailable = canPickFolder();
const showSidebar = ref(true);
const showSettings = ref(false);
const showTrafficMonitor = ref(false);

// Main-area view selected in the sidebar navigation (Hermes-style).
// 'chat' is the conversation; the other three are management pages
// served by the gateway (extensions / recipes / schedules).
const currentView = ref<'chat' | 'extensions' | 'recipes' | 'schedules' | 'skills'>('chat');

function selectView(view: typeof currentView.value) {
  currentView.value = view;
  if (isNarrowLayout.value) showSidebar.value = false;
}
const showStartupDetails = ref(false);

// Reactive flag tracking whether the viewport is narrow enough to show the
// sidebar as a slide-in drawer (mobile / very narrow desktop windows). Used
// by the template to decide when the backdrop is interactive and by
// onMounted to default the drawer closed.
const isNarrowLayout = ref(false);
let narrowMql: MediaQueryList | null = null;
function syncNarrowLayout() {
  if (narrowMql) isNarrowLayout.value = narrowMql.matches;
}

// Foreground-reconnect plumbing. Mobile OSes freeze the WebView when the
// app is backgrounded and routers may drop the idle TCP connection while
// we're away. When the user returns we ask the session store to silently
// reattach to the last session if we have one.
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleReconnect() {
  // Coalesce rapid visibility/online flips into a single attempt.
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    // Skip if the browser still thinks we're offline; we'll be re-triggered
    // by the `online` event when connectivity returns.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    void sessionStore.tryReconnect();
  }, 250);
}
function handleVisibilityChange() {
  if (typeof document !== 'undefined' && !document.hidden) scheduleReconnect();
}
function handleOnline() {
  scheduleReconnect();
}

// Preferences store for persisting user selections
let prefsStore: KVStore | null = null;

const isConnected = computed(() => sessionStore.isConnected);
const isLoading = computed(() => sessionStore.isLoading);
const isConnecting = computed(() => sessionStore.isConnecting);
const isReconnecting = computed(() => sessionStore.isReconnecting);
const error = computed(() => sessionStore.error || configStore.error);
const hasAgents = computed(() => configStore.hasAgents);

// Name of the agent the reconnect banner refers to. Falls back to the
// generic "agent" if the saved session has no name (shouldn't happen).
const reconnectingAgentName = computed(
  () => sessionStore.currentSession?.agentName ?? 'agent'
);

// True when there is a saved session we *could* reconnect to but the
// transport is currently down. Surfaces a manual "Reconnect" affordance on
// the error banner so users don't have to background+foreground the app to
// trigger the auto path.
const canManuallyReconnect = computed(
  () =>
    !isConnected.value &&
    !isReconnecting.value &&
    !isConnecting.value &&
    !!sessionStore.currentSession?.supportsLoadSession
);

async function handleManualReconnect() {
  await sessionStore.tryReconnect();
}

// Watch for permission requests from session store
const pendingPermission = computed(() => sessionStore.pendingPermission);

// Watch for auth method selection requests
const pendingAuthMethods = computed(() => sessionStore.pendingAuthMethods);
const pendingAuthAgentName = computed(() => sessionStore.pendingAuthAgentName);

onMounted(async () => {
  // Track viewport width so the sidebar can default-collapse into a drawer
  // on phones / narrow windows. We watch a MediaQueryList rather than
  // resize for correctness across orientation changes on iOS.
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    narrowMql = window.matchMedia('(max-width: 800px)');
    syncNarrowLayout();
    narrowMql.addEventListener('change', syncNarrowLayout);
    if (isNarrowLayout.value) showSidebar.value = false;
  }

  // Load persisted preferences first
  prefsStore = await loadKvStore('preferences.json');
  
  // Initialize telemetry (check user preference)
  const telemetryEnabled = await prefsStore.get<boolean>('telemetryEnabled') ?? true;
  await initTelemetry(telemetryEnabled);
  
  // Initialize stores
  await configStore.loadConfig();
  await configStore.setupHotReload();
  await sessionStore.initStore();
  
  const savedCwd = await prefsStore.get<string>('lastCwd');
  if (savedCwd) {
    selectedCwd.value = savedCwd;
  }

  // Hook foreground-reconnect listeners. `pageshow` fires both on initial
  // navigation and when iOS restores a frozen WebView from the back/forward
  // cache, so it complements `visibilitychange` on Safari/iOS.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pageshow', scheduleReconnect);
    window.addEventListener('online', handleOnline);
  }
});

async function handleAgentSelect(agentName: string) {
  selectedAgent.value = agentName;
}

async function handleSelectFolder() {
  const folder = await pickFolder('Select Working Directory');
  if (folder) {
    selectedCwd.value = folder;
    // Persist the selection
    if (prefsStore) {
      await prefsStore.set('lastCwd', folder);
      await prefsStore.save();
    }
  }
}

/** Persist a typed cwd as the user edits it (mobile / web field). */
async function handleCwdInput(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  selectedCwd.value = value;
  if (prefsStore) {
    await prefsStore.set('lastCwd', value);
    await prefsStore.save();
  }
}

async function handleNewSession() {
  if (!selectedAgent.value) return;

  // ACP requires an absolute working directory; passing '.' is rejected by
  // most agents. On desktop the folder picker always returns an absolute
  // path, but on mobile the user types it, so validate up-front and surface
  // a helpful error rather than letting the agent reject `session/new`.
  const cwd = selectedCwd.value.trim();
  if (!cwd) {
    sessionStore.error = 'Please enter a working directory (absolute path on the agent\u2019s machine).';
    return;
  }
  const isAbsolute = cwd.startsWith('/') || /^[A-Za-z]:[\\/]/.test(cwd);
  if (!isAbsolute) {
    sessionStore.error = `Working directory must be an absolute path (got: ${cwd}).`;
    return;
  }

  try {
    const mcpServers = sessionMcpUrl.value.trim()
      ? [{ name: 'session-mcp', type: 'http', url: sessionMcpUrl.value.trim(), headers: [] }]
      : [];
    await sessionStore.createSession(selectedAgent.value, cwd, mcpServers);
  } catch (e) {
    console.error('Failed to create session:', e);
  }
}

async function handleResumeSession(session: SavedSession) {
  selectedAgent.value = session.agentName;
  currentView.value = 'chat';
  if (isNarrowLayout.value) showSidebar.value = false;
  try {
    await sessionStore.resumeSession(session);
  } catch (e) {
    console.error('Failed to resume session:', e);
  }
}

async function handleDeleteSession(sessionId: string) {
  await sessionStore.deleteSession(sessionId);
}

async function handleRenameSession(session: SavedSession, title: string) {
  await sessionStore.renameSession(session.sessionId, title);
}

// Run a recipe: jump to the chat view, make sure a session exists
// (creating one with the sidebar's agent + cwd when needed), then
// send the recipe's instructions + prompt as the first message.
async function handleRunRecipe(recipe: RecipeInfo, values: Record<string, string> = {}) {
  selectView('chat');
  // Substitute recipe parameters into {{ key }} placeholders (Goose-style).
  const fill = (s: string) => {
    let out = s;
    for (const [k, v] of Object.entries(values)) {
      out = out.split(`{{${k}}}`).join(v).split(`{{ ${k} }}`).join(v);
    }
    return out;
  };
  const text = [recipe.instructions, recipe.prompt].filter(Boolean).map(fill).join('\n\n') || recipe.title;
  try {
    if (!isConnected.value) {
      if (!selectedAgent.value) {
        sessionStore.error = t('app.selectAgentFirst');
        return;
      }
      await handleNewSession();
      if (!isConnected.value) return; // handleNewSession surfaced the error
    }
    await sessionStore.sendPrompt(text);
  } catch (e) {
    console.error('Failed to run recipe:', e);
  }
}

async function handleDisconnect() {
  await sessionStore.disconnect();
}

async function handleCancelConnection() {
  await sessionStore.cancelConnection();
}

function handlePermissionSelect(optionId: string) {
  sessionStore.resolvePermission(optionId);
}

function handlePermissionCancel() {
  sessionStore.cancelPermission();
}

function handleAuthMethodSelect(methodId: string) {
  sessionStore.selectAuthMethod(methodId);
}

function handleAuthMethodCancel() {
  sessionStore.cancelAuthSelection();
}

function toggleSidebar() {
  showSidebar.value = !showSidebar.value;
}

/** Close the drawer when the user taps the backdrop on a narrow viewport. */
function handleBackdropClick() {
  if (isNarrowLayout.value) showSidebar.value = false;
}

onBeforeUnmount(() => {
  if (narrowMql) {
    narrowMql.removeEventListener('change', syncNarrowLayout);
    narrowMql = null;
  }
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  }
  if (typeof window !== 'undefined') {
    window.removeEventListener('pageshow', scheduleReconnect);
    window.removeEventListener('online', handleOnline);
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
});

function clearError() {
  sessionStore.clearError();
  configStore.clearError();
}
</script>

<template>
  <div class="app-container" :class="{ 'narrow-layout': isNarrowLayout }">
    <!-- Sidebar (slides in as a drawer on narrow viewports) -->
    <aside
      v-show="showSidebar"
      class="sidebar"
      :class="{ 'is-drawer': isNarrowLayout }"
    >
      <div class="sidebar-header">
        <h1>Goose</h1>
        <div class="header-actions">
          <button 
            class="settings-btn" 
            :class="{ active: showTrafficMonitor }"
            @click="showTrafficMonitor = !showTrafficMonitor" 
            title="ACP Traffic Monitor"
          >📡</button>
          <button class="settings-btn" @click="setLocale(locale === 'zh' ? 'en' : 'zh')" title="Language / 语言">{{ locale === 'zh' ? 'EN' : '中' }}</button>
          <button class="settings-btn" @click="showSettings = true" :title="t('nav.settings')"><Icon name="sliders" /></button>
          <button class="toggle-btn" @click="toggleSidebar">◀</button>
        </div>
      </div>
      
      <!-- Sidebar navigation (Hermes-style): chat + management pages -->
      <nav class="side-nav">
        <button class="nav-item" :class="{ active: currentView === 'chat' }" @click="selectView('chat')">
          <Icon name="chat" class="nav-icon" /><span>{{ t('nav.sessions') }}</span>
        </button>
        <button class="nav-item" :class="{ active: currentView === 'extensions' }" @click="selectView('extensions')">
          <Icon name="grid" class="nav-icon" /><span>{{ t('nav.extensions') }}</span>
        </button>
        <button class="nav-item" :class="{ active: currentView === 'recipes' }" @click="selectView('recipes')">
          <Icon name="doc" class="nav-icon" /><span>{{ t('nav.recipes') }}</span>
        </button>
        <button class="nav-item" :class="{ active: currentView === 'skills' }" @click="selectView('skills')">
          <Icon name="book" class="nav-icon" /><span>{{ t('nav.skills') }}</span>
        </button>
        <button class="nav-item" :class="{ active: currentView === 'schedules' }" @click="selectView('schedules')">
          <Icon name="clock" class="nav-icon" /><span>{{ t('nav.schedules') }}</span>
        </button>
        <button class="nav-item" @click="showSettings = true">
          <Icon name="sliders" class="nav-icon" /><span>{{ t('nav.settings') }}</span>
        </button>
      </nav>
      
      <div class="build-stamp">build {{ buildStamp }}</div>

      <div class="sidebar-content">
        <!-- Connection controls live in Settings now (agent picker,
             working directory, per-session MCP, disconnect). This quick
             action stays: disconnected it opens Settings to connect,
             connected it starts a fresh session right away. -->
        <div class="section">
          <button
            class="new-session-btn"
            :disabled="isConnecting"
            @click="isConnected ? handleNewSession() : (showSettings = true)"
          >
            {{ isConnecting ? t('app.connecting') : t('app.newSession') }}
          </button>
        </div>

        <!-- Session List -->
        <div class="section">
          <SessionList 
            :cwd-filter="selectedCwd"
            @resume="handleResumeSession"
            @delete="handleDeleteSession"
            @rename="handleRenameSession"
          />
        </div>
      </div>
    </aside>
    
    <!-- Backdrop behind the drawer on narrow viewports. Only intercepts
         taps when the layout is narrow; on desktop it's display:none. -->
    <div
      v-show="isNarrowLayout && showSidebar"
      class="drawer-backdrop"
      @click="handleBackdropClick"
    />

    <!-- Mobile hamburger to open the drawer when collapsed. The desktop
         chevron toggle (`.sidebar-toggle-collapsed`) is hidden on narrow
         viewports via CSS so we don't show two affordances. -->
    <button
      v-show="isNarrowLayout && !showSidebar"
      class="mobile-hamburger"
      @click="showSidebar = true"
      aria-label="Open menu"
    >☰</button>

    <!-- Collapsed sidebar toggle -->
    <button 
      v-if="!showSidebar" 
      class="sidebar-toggle-collapsed"
      @click="toggleSidebar"
    >
      ▶
    </button>
    
    <!-- Main Content Area -->
    <div class="main-area">
      <main class="main-content">
        <!-- Reconnect banner takes priority over the error banner: while a
             reconnect is in progress we don't want a contradictory red
             "Connection lost" pill. -->
        <div v-if="isReconnecting" class="reconnect-banner">
          <span class="reconnect-spinner" aria-hidden="true"></span>
          <span class="reconnect-text">
            Reconnecting to <strong>{{ reconnectingAgentName }}</strong>…
          </span>
        </div>

        <!-- Error display (suppressed while reconnecting). -->
        <div v-else-if="error" class="error-banner">
          <span class="error-icon">⚠</span>
          <span class="error-text">{{ error }}</span>
          <button
            v-if="canManuallyReconnect"
            class="error-action"
            @click="handleManualReconnect"
            title="Reconnect"
          >{{ t('app.reconnect') }}</button>
          <button class="error-close" @click="clearError" title="Dismiss">×</button>
        </div>
        
        <!-- Chat View when connected -->
        <ChatView v-if="currentView === 'chat' && isConnected" />
        
        <!-- Welcome screen when not connected -->
        <div v-else-if="currentView === 'chat'" class="welcome-screen">
          <h2>{{ t('app.welcomeTitle') }}</h2>
          <p>{{ t('app.welcomeText') }}</p>
          <p v-if="!hasAgents" class="hint">{{ t('app.configureAgents') }}</p>
        </div>
        <!-- Management pages. Extensions / Recipes / Schedules are backed
             by the gateway on the Pi; each panel becomes live as its API lands. -->
        <ExtensionsPage v-else-if="currentView === 'extensions'" class="page-panel" />
        <RecipesPage v-else-if="currentView === 'recipes'" class="page-panel" @run="handleRunRecipe" />
        <SchedulesPage v-else-if="currentView === 'schedules'" class="page-panel" />
        <SkillsPage v-else-if="currentView === 'skills'" class="page-panel" />
      </main>
      
      <!-- Traffic Monitor Panel -->
      <div v-if="showTrafficMonitor" class="traffic-panel">
        <TrafficMonitor @close="showTrafficMonitor = false" />
      </div>
    </div>
    
    <!-- Permission Dialog -->
    <PermissionDialog 
      v-if="pendingPermission"
      :request="pendingPermission"
      @select="handlePermissionSelect"
      @cancel="handlePermissionCancel"
    />

    <!-- Auth Method Dialog -->
    <AuthMethodDialog 
      v-if="pendingAuthMethods.length > 0"
      :auth-methods="pendingAuthMethods"
      :agent-name="pendingAuthAgentName"
      @select="handleAuthMethodSelect"
      @cancel="handleAuthMethodCancel"
    />

    <!-- Settings -->
    <SettingsView 
      v-if="showSettings"
      @close="showSettings = false"
    >
        <!-- Agent Selection -->
        <div class="section">
          <AgentSelector 
            v-model:selected="selectedAgent"
            @select="handleAgentSelect"
          />
          
          <!-- Working Directory Picker -->
          <div class="cwd-picker">
            <label>{{ t('app.workingDir') }}</label>
            <!-- Desktop: read-only display + folder picker. -->
            <div v-if="folderPickerAvailable" class="cwd-row">
              <span class="cwd-path" :title="selectedCwd || 'Current directory'">
                {{ selectedCwd ? selectedCwd.split(/[\\/]/).pop() : '.' }}
              </span>
              <button 
                class="cwd-btn" 
                @click="handleSelectFolder"
                title="Select folder"
                :disabled="isConnecting || isConnected"
              >
                📁
              </button>
            </div>
            <!-- Mobile / web: free-text input. The cwd is interpreted by
                 the remote agent, so the path must exist on the agent's
                 machine. -->
            <input
              v-else
              class="cwd-input"
              type="text"
              :value="selectedCwd"
              @input="handleCwdInput"
              :disabled="isConnecting || isConnected"
              placeholder="/absolute/path/on/agent"
              autocapitalize="none"
              autocorrect="off"
              spellcheck="false"
            />
          </div>
          
          <!-- Optional per-session MCP server (ACP session/new takes
               mcpServers; the agent accepts http ones). Applies to the
               next new session only. -->
          <div v-if="!isConnected && !isConnecting" class="cwd-picker">
            <label>{{ t('app.sessionMcp') }}</label>
            <input
              class="cwd-input"
              type="url"
              v-model="sessionMcpUrl"
              placeholder="https://…/mcp"
              autocapitalize="none"
              autocorrect="off"
              spellcheck="false"
            />
          </div>
          
          <button 
            v-if="hasAgents && !isConnected && !isConnecting"
            class="new-session-btn"
            :disabled="!selectedAgent || isLoading"
            @click="handleNewSession"
          >
            {{ isLoading ? t('app.connecting') : t('app.newSession') }}
          </button>
          
          <!-- Startup Progress -->
          <StartupProgress 
            v-if="isConnecting"
            :agent-name="selectedAgent"
            :phase="sessionStore.startupPhase"
            :logs="sessionStore.startupLogs"
            :elapsed-seconds="sessionStore.startupElapsed"
            :show-details="showStartupDetails"
            @cancel="handleCancelConnection"
            @toggle-details="showStartupDetails = !showStartupDetails"
          />
          
          <button 
            v-if="isConnected"
            class="disconnect-btn"
            @click="handleDisconnect"
          >
            {{ t('app.disconnect') }}
          </button>
        </div>
    </SettingsView>
  </div>
</template>

<style>
:root {
  /* Petrol & porcelain - the console theme. One accent (petrol), spent
     only on interaction; surfaces are cool porcelain layers, ink is a
     green-black. See the fork's design notes. */
  --bg-primary: #0e6b6e;
  --bg-primary-hover: #0a5457;
  --bg-sidebar: #edf1ef;
  --bg-main: #fbfcfb;
  --bg-hover: #e7edea;
  --bg-user: #dcebe8;
  --bg-assistant: transparent;
  --bg-code: #101816;
  --bg-success: #2e7d52;
  --bg-danger: #c0453e;
  --bg-warning: #f7ebce;
  --text-primary: #17201e;
  --text-secondary: #4c5a56;
  --text-muted: #84938e;
  --text-accent: #0e6b6e;
  --text-code: #c9d8d2;
  --border-color: #d9e0dc;
  --bg-dialog: #ffffff;
  --bg-header: #f4f6f5;
  --bg-footer: #f4f6f5;
  --bg-button: #ffffff;
  --bg-input: #ffffff;
  --bg-tool: #f4f6f5;
  --bg-danger-hover: #a83a35;
  --bg-success-hover: #276b46;
  --text-danger: #c0453e;
  --status-pending: #b07d2b;
  --status-success: #2e7d52;
  --status-failed: #c0453e;
  
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Source Han Sans SC', 'Noto Sans CJK SC', sans-serif;
  font-size: 16px;
  line-height: 1.5;
  color: var(--text-primary);
  background-color: #f4f6f5;
}

::selection {
  background: #bcd9d4;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg-primary: #45b0aa;
    --bg-primary-hover: #57bcb7;
    --bg-sidebar: #121a19;
    --bg-main: #182220;
    --bg-hover: #1f2c29;
    --bg-user: #173b3a;
    --bg-assistant: transparent;
    --text-primary: #e4ebe9;
    --text-secondary: #a7b8b4;
    --text-muted: #71837e;
    --text-accent: #45b0aa;
    --border-color: #26322f;
    --bg-dialog: #1d2926;
    --bg-header: #121a19;
    --bg-footer: #121a19;
    --bg-button: #1f2c29;
    --bg-input: #101816;
    --bg-tool: #121a19;
    --bg-danger-hover: #d0554e;
    --bg-success-hover: #379e66;
    --text-danger: #e07a72;
    --status-pending: #d9a441;
    --status-success: #3fae74;
    --status-failed: #e07a72;
    background-color: #0d1312;
  }
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

:focus-visible {
  outline: 2px solid var(--text-accent);
  outline-offset: 2px;
}

html, body, #app {
  height: 100%;
}
</style>

<style scoped>
.app-container {
  display: flex;
  height: 100vh;
  /* Mobile browsers: 100vh spans the area behind the URL bar and inner
     scroll containers do not trigger URL-bar auto-hide, which can
     leave the bottom of the app unreachable. dvh tracks the visible
     viewport; unsupported browsers keep the 100vh line above. */
  height: 100dvh;
  overflow: hidden;
}

.sidebar {
  width: 320px;
  min-width: 320px;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem;
  border-bottom: 1px solid var(--border-color);
}

.sidebar-header h1 {
  font-size: 1.25rem;
  font-weight: 700;
  letter-spacing: -0.01em;
  margin: 0;
}

.header-actions {
  display: flex;
  gap: 0.25rem;
}

.settings-btn,
.toggle-btn {
  padding: 0.25rem 0.5rem;
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 0.875rem;
  color: var(--text-muted);
}

.settings-btn:hover,
.toggle-btn:hover {
  color: var(--text-primary);
}

.settings-btn.active {
  color: var(--text-accent);
  background: var(--bg-hover);
  border-radius: 4px;
}

/* Sidebar navigation (Hermes-style) */
.side-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0.5rem;
  border-bottom: 1px solid var(--border-color);
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.55rem 0.75rem;
  border: none;
  background: transparent;
  border-radius: 8px;
  font-size: 0.92rem;
  color: var(--text-secondary);
  cursor: pointer;
  text-align: left;
}

.nav-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.nav-item.active {
  background: var(--bg-user);
  color: var(--text-primary);
  font-weight: 600;
}

.nav-icon {
  width: 1.15rem;
  height: 1.15rem;
  text-align: center;
}

/* Management page panels */
.page-panel {
  /* Management pages live inside the flex-column .main-content (overflow
     hidden): without flex + min-height + own overflow, tall pages (e.g.
     Extensions with ~19 rows) are clipped and cannot scroll. */
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
  width: 100%;
  padding: 2rem 1.5rem;
  max-width: 880px;
  margin: 0 auto;
}

.page-panel h2 {
  font-size: 1.4rem;
  letter-spacing: -0.01em;
  margin-bottom: 0.75rem;
}

.page-panel p {
  color: var(--text-secondary);
  line-height: 1.65;
  margin-bottom: 0.75rem;
}

.page-panel .page-note {
  color: var(--text-muted);
  font-size: 0.9rem;
}

.build-stamp {
  padding: 0.15rem 1rem 0.35rem;
  font-size: 0.68rem;
  color: var(--text-secondary);
  opacity: 0.75;
}

.sidebar-content {
  flex: 1;
  overflow-y: auto;
}

.section {
  padding: 1rem;
  border-bottom: 1px solid var(--border-color);
}

.new-session-btn,
.disconnect-btn {
  width: 100%;
  margin-top: 0.75rem;
  padding: 0.625rem 1rem;
  border: none;
  border-radius: 6px;
  font-size: 0.9rem;
  font-weight: 500;
  cursor: pointer;
}

.new-session-btn {
  background: var(--bg-primary);
  color: white;
}

.new-session-btn:hover:not(:disabled) {
  background: var(--bg-primary-hover);
}

.new-session-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cwd-picker {
  margin-top: 0.75rem;
}

.cwd-picker label {
  display: block;
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin-bottom: 0.25rem;
}

.cwd-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.cwd-path {
  flex: 1;
  padding: 0.375rem 0.5rem;
  background: var(--bg-main);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  font-size: 0.8rem;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cwd-btn {
  padding: 0.375rem 0.5rem;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  font-size: 1rem;
}

.cwd-btn:hover:not(:disabled) {
  background: var(--bg-hover);
}

.cwd-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Mobile-only free-text cwd input. */
.cwd-input {
  width: 100%;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-main);
  color: var(--text-primary);
  font-size: 16px; /* 16px = no iOS auto-zoom */
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}

.cwd-input:disabled {
  opacity: 0.5;
}

.disconnect-btn {
  background: var(--bg-danger);
  color: white;
}

.disconnect-btn:hover {
  background: #c82333;
}

.sidebar-toggle-collapsed {
  position: fixed;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  padding: 0.5rem;
  border: 1px solid var(--border-color);
  border-left: none;
  border-radius: 0 4px 4px 0;
  background: var(--bg-sidebar);
  cursor: pointer;
}

.main-area {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.main-content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-main);
}

.traffic-panel {
  flex-shrink: 0;
  border-top: 2px solid var(--border-color);
}

.error-banner {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  background: #fee;
  color: #c00;
  border-bottom: 1px solid #fcc;
}

.error-icon {
  flex-shrink: 0;
}

.error-text {
  flex: 1;
}

.error-close {
  flex-shrink: 0;
  padding: 0.25rem 0.5rem;
  border: none;
  background: transparent;
  color: #c00;
  font-size: 1.25rem;
  line-height: 1;
  cursor: pointer;
  opacity: 0.6;
  border-radius: 4px;
}

.error-close:hover {
  opacity: 1;
  background: rgba(204, 0, 0, 0.1);
}

/* Inline "Reconnect" affordance shown next to a stale error when we have a
   saved session we could reattach to. */
.error-action {
  flex-shrink: 0;
  padding: 0.25rem 0.6rem;
  margin-right: 0.25rem;
  border: 1px solid #c00;
  border-radius: 4px;
  background: transparent;
  color: #c00;
  font-size: 0.8rem;
  font-weight: 500;
  cursor: pointer;
}

.error-action:hover {
  background: rgba(204, 0, 0, 0.1);
}

/* Foreground-reconnect banner. Distinct visual style from the red error
   banner so users immediately read it as transient progress, not failure. */
.reconnect-banner {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.75rem 1rem;
  background: #e0f2fe;
  color: #0369a1;
  border-bottom: 1px solid #bae6fd;
}

.reconnect-text {
  flex: 1;
  font-size: 0.9rem;
}

.reconnect-text strong {
  font-weight: 600;
}

.reconnect-spinner {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: reconnect-spin 0.9s linear infinite;
}

@keyframes reconnect-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-color-scheme: dark) {
  .reconnect-banner {
    background: #082f49;
    color: #7dd3fc;
    border-bottom-color: #0c4a6e;
  }
}

.welcome-screen {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 2rem;
  color: var(--text-secondary);
}

.welcome-screen h2 {
  margin-bottom: 0.5rem;
  color: var(--text-primary);
}

.welcome-screen .hint {
  margin-top: 1rem;
  font-size: 0.875rem;
  color: var(--text-muted);
}

/* ---------- Mobile / narrow-viewport layout ---------- */

.drawer-backdrop {
  display: none;
}

.mobile-hamburger {
  display: none;
}

@media (max-width: 800px) {
  .app-container {
    /* Prevent the off-screen drawer from causing horizontal scroll. */
    overflow-x: hidden;
  }

  /* Banners sit at the very top of the main area, where the OS status bar
     / camera notch overlap on phones. Extend the banner colour through the
     safe-area inset and push the text below it so the status bar reads as
     a tinted continuation of the banner instead of clipping its content. */
  .reconnect-banner,
  .error-banner {
    padding-top: calc(0.75rem + env(safe-area-inset-top, 0px));
  }

  .sidebar.is-drawer {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: 85vw;
    max-width: 360px;
    z-index: 100;
    box-shadow: 2px 0 16px rgba(0, 0, 0, 0.3);
    /* Honour iOS notch / Android status bar. */
    padding-top: env(safe-area-inset-top, 0px);
  }

  .drawer-backdrop {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 90;
  }

  /* Hide the desktop chevron when the mobile hamburger is in play. */
  .sidebar-toggle-collapsed {
    display: none;
  }

  .mobile-hamburger {
    display: flex;
    align-items: center;
    justify-content: center;
    position: fixed;
    top: calc(env(safe-area-inset-top, 0px) + 0.5rem);
    left: 0.5rem;
    z-index: 50;
    width: 44px;
    height: 44px;
    padding: 0;
    background: var(--bg-sidebar);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    font-size: 1.25rem;
    cursor: pointer;
    color: var(--text-primary);
  }

  /* Tap-target sizing for the icon buttons inside the sidebar header. */
  .settings-btn,
  .toggle-btn {
    min-width: 40px;
    min-height: 40px;
    font-size: 1rem;
  }

  /* Honour the iOS home indicator at the bottom of the main area. */
  .main-area {
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
}
</style>