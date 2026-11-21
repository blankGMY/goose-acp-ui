<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onUnmounted, defineAsyncComponent } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { useSessionStore } from '../stores/session';
import { isMobile } from '../lib/platform';
import ModePicker from './ModePicker.vue';
import ModelPicker from './ModelPicker.vue';
import ConfigOptionPicker from './ConfigOptionPicker.vue';
import CommandPalette from './CommandPalette.vue';
import AppDialog from './AppDialog.vue';
import ExtensionsPanel from './ExtensionsPanel.vue';
import Icon from './Icon.vue';
const McpAppView = defineAsyncComponent(() => import('./McpAppView.vue'));
import type { SlashCommand, ChatMessage } from '../lib/types';
import { useI18n } from '../lib/i18n';
import { useDialog } from '../lib/useDialog';
import { codexUsage, type CodexUsage } from '../lib/gateway';

const sessionStore = useSessionStore();
const { t } = useI18n();
const { dialog, askPrompt, onDialogConfirm, onDialogCancel } = useDialog();
const showExtPanel = ref(false);
const inputText = ref('');
const textareaRef = ref<HTMLTextAreaElement | null>(null);
// The composer starts one line tall and grows with the draft (up to
// ~5 lines), so the Send button sits beside the input instead of
// under a tall fixed box.
watch(inputText, async () => {
  await nextTick();
  const el = textareaRef.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 132) + 'px';
});
const messagesContainer = ref<HTMLElement | null>(null);
const commandPaletteRef = ref<InstanceType<typeof CommandPalette> | null>(null);

// On mobile (iOS/Android) the soft-keyboard's Return key should insert a
// newline like every other native chat app; submitting is the dedicated
// Send button. On desktop, Enter still submits and Shift+Enter newlines.
const submitOnEnter = !isMobile();

// Track expanded thought sections by message id
const expandedThoughts = ref<Set<string>>(new Set());

const messages = computed(() => sessionStore.messageList);
// Long histories render only the newest slice at first: replaying a big
// session used to mean rendering hundreds of markdown messages before
// anything appeared. Earlier messages are one tap away.
const HISTORY_WINDOW = 80;
const showAllHistory = ref(false);
const visibleMessages = computed(() => {
  const all = messages.value;
  return showAllHistory.value || all.length <= HISTORY_WINDOW ? all : all.slice(-HISTORY_WINDOW);
});
const hiddenCount = computed(() => messages.value.length - visibleMessages.value.length);
const isLoading = computed(() => sessionStore.isLoading);
const isLoadingHistory = computed(() => sessionStore.isLoadingHistory);
const showingCachedHistory = computed(() => sessionStore.showingCachedHistory);
const isReconnecting = computed(() => sessionStore.isReconnecting);
const currentSession = computed(() => sessionStore.currentSession);
const availableModes = computed(() => sessionStore.availableModes);
const currentModeId = computed(() => sessionStore.currentModeId);
const availableModels = computed(() => sessionStore.availableModels);
const currentModelId = computed(() => sessionStore.currentModelId);
const configOptions = computed(() => sessionStore.configOptions);

// --- Status bar data (Hermes-style bottom bar) ---
const usage = computed(() => sessionStore.usage);
// (The current model is shown by the picker in the status bar.)
function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}
const usageText = computed(() => {
  const u = usage.value;
  if (!u || !u.size) return '';
  return `${formatTokens(u.used)} / ${formatTokens(u.size)} · ${((u.used / u.size) * 100).toFixed(1)}%`;
});
const costText = computed(() => {
  const u = usage.value;
  if (!u || u.costAmount == null) return '';
  return '$' + u.costAmount.toFixed(4);
});

// --- GPT subscription quota (ChatGPT plan windows, not session cost) ---
// The gateway queries chatgpt.com/backend-api/wham/usage with the Pi's
// own Codex login token and caches it for two minutes; the browser never
// sees the token. Shown whenever the endpoint answers, even on a
// non-GPT session, because it is account-level, not session-level.
const gptQuota = ref<CodexUsage | null>(null);
let gptQuotaTimer: ReturnType<typeof setInterval> | undefined;
async function refreshGptQuota() {
  try {
    gptQuota.value = await codexUsage();
  } catch {
    gptQuota.value = null; // hide quietly; a dead token already shows up as a failed prompt
  }
}
function formatReset(ts: number | null): string {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return d.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
const gptQuotaText = computed(() => {
  const q = gptQuota.value;
  if (!q || !q.ok || q.primary.used_percent == null || q.secondary.used_percent == null) return '';
  return t('chat.gptQuota').replace('{p}', String(q.primary.used_percent)).replace('{s}', String(q.secondary.used_percent));
});
const gptQuotaTitle = computed(() => {
  const q = gptQuota.value;
  if (!q || !q.ok) return '';
  return t('chat.gptQuotaTitle')
    .replace('{plan}', q.plan_type ? q.plan_type.toUpperCase() : 'GPT')
    .replace('{p}', formatReset(q.primary.reset_at))
    .replace('{s}', formatReset(q.secondary.reset_at));
});

// --- Header title: a user rename wins over the server title ---
const displayTitle = computed(() => {
  const s = currentSession.value;
  if (!s) return 'Chat';
  return sessionStore.titleOverrides[s.sessionId] ?? s.title ?? 'Chat';
});

// --- Attachments: images go as ACP image blocks; text files and links
// go as embedded context (the agent advertises promptCapabilities
// { image: true, embeddedContext: true }). ---
interface Attachment {
  kind: 'image' | 'file' | 'link';
  data?: string;     // image: base64 payload
  mimeType?: string;
  url?: string;      // image: data URL used for the preview
  name?: string;     // file / link: display name
  text?: string;     // file: full text content
  uri?: string;      // link: the URL itself
}
const attachments = ref<Attachment[]>([]);
const fileInput = ref<HTMLInputElement | null>(null);
const isDragging = ref(false);

const TEXT_FILE_RE = /\.(txt|md|markdown|json|ya?ml|toml|csv|log|py|js|ts|vue|html?|css|xml|sh|sql|ini|conf)$/i;

function readOneFile(file: File): Promise<Attachment | null> {
  return new Promise((resolve) => {
    if (file.type.startsWith('image/')) {
      if (file.size > 10 * 1024 * 1024) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result || '');
        const comma = url.indexOf(',');
        if (comma === -1) return resolve(null);
        resolve({ kind: 'image', data: url.slice(comma + 1), mimeType: file.type, url });
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
      return;
    }
    // Text-like files are embedded as context; the size cap keeps a
    // stray large file from blowing up the prompt.
    if ((file.type.startsWith('text/') || TEXT_FILE_RE.test(file.name)) && file.size <= 256 * 1024) {
      const reader = new FileReader();
      reader.onload = () => resolve({
        kind: 'file',
        name: file.name,
        text: String(reader.result || ''),
        mimeType: file.type || 'text/plain',
      });
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
      return;
    }
    resolve(null);
  });
}

async function addFiles(files: FileList | File[]) {
  for (const file of Array.from(files)) {
    if (attachments.value.length >= 6) break;
    const att = await readOneFile(file);
    if (att) attachments.value.push(att);
  }
}

async function addLink() {
  const url = await askPrompt(t('chat.linkPrompt'));
  if (url && /^https?:\/\//i.test(url.trim())) {
    attachments.value.push({ kind: 'link', name: url.trim(), uri: url.trim() });
  }
}

function handleFileSelect(event: Event) {
  const input = event.target as HTMLInputElement;
  if (input.files) void addFiles(input.files);
  input.value = '';
}

function handlePaste(event: ClipboardEvent) {
  const files = [...(event.clipboardData?.items || [])]
    .filter(i => i.kind === 'file' && (i.type.startsWith('image/') || i.type.startsWith('text/')))
    .map(i => i.getAsFile())
    .filter((f): f is File => !!f);
  if (files.length) {
    event.preventDefault();
    void addFiles(files);
  }
}

function handleDrop(event: DragEvent) {
  isDragging.value = false;
  if (event.dataTransfer?.files?.length) void addFiles(event.dataTransfer.files);
}

function removeAttachment(index: number) {
  attachments.value.splice(index, 1);
}

// --- Copy one message to the clipboard ---
const copiedId = ref<string | null>(null);
async function copyMessage(message: { id: string; content: string }) {
  try {
    await navigator.clipboard.writeText(message.content);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = message.content;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  copiedId.value = message.id;
  setTimeout(() => { if (copiedId.value === message.id) copiedId.value = null; }, 1200);
}

// --- Edit one of my earlier messages: recall it into the composer ---
// Goose sessions are append-only (no server-side rewrite or fork), so
// the edited text goes out as a new turn; the original stays in the
// history. Text and images are restored; file/link context chips only
// ever stored their names, so those cannot be restored.
function editMessage(message: ChatMessage) {
  inputText.value = message.content || '';
  attachments.value = (message.images ?? []).map((src) => {
    const comma = src.indexOf(',');
    const mimeType = src.slice(5, src.indexOf(';')) || 'image/png';
    return { kind: 'image' as const, data: src.slice(comma + 1), mimeType, url: src };
  });
  nextTick(() => textareaRef.value?.focus());
}

// --- Export the current session transcript as a Markdown file ---
function exportSession() {
  const s = currentSession.value;
  if (!s) return;
  const lines: string[] = [
    `# ${displayTitle.value}`,
    '',
    `Exported ${new Date().toLocaleString()} · ${s.agentName}`,
    '',
  ];
  for (const m of messages.value) {
    lines.push(m.role === 'user' ? '## You' : '## Assistant', '');
    if (m.content) lines.push(m.content, '');
    if (m.images?.length) {
      lines.push(`(${m.images.length} image attachment${m.images.length > 1 ? 's' : ''})`, '');
    }
    for (const tc of m.toolCalls || []) {
      lines.push(`- Tool: ${tc.title} (${tc.status})`);
    }
    if (m.toolCalls?.length) lines.push('');
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safe = displayTitle.value.replace(/[\\/:*?"<>|]/g, '').slice(0, 60) || 'session';
  a.href = url;
  a.download = `${safe}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
// Goose also lists 'mode' as a config option, but ModePicker already
// covers it via session/set_mode - showing both would duplicate it.
const visibleConfigOptions = computed(() => configOptions.value.filter(o => o.id !== 'mode'));
const availableCommands = computed(() => sessionStore.availableCommands);

// Slash command state
const showCommandPalette = computed(() => {
  if (availableCommands.value.length === 0) return false;
  const text = inputText.value;
  // Show palette when input starts with "/" and cursor is after it
  if (!text.startsWith('/')) return false;
  // Don't show if there's a space (command already entered)
  const spaceIndex = text.indexOf(' ');
  return spaceIndex === -1;
});

const commandFilter = computed(() => {
  if (!inputText.value.startsWith('/')) return '';
  return inputText.value.slice(1); // Remove the leading "/"
});

// Auto-scroll only while the user is pinned to the bottom; scrolling up
// to read history must not be fought by streaming output. The floating
// button (rendered when unpinned) jumps back and re-pins.
const pinnedToBottom = ref(true);

function onMessagesScroll() {
  const el = messagesContainer.value;
  if (!el) return;
  pinnedToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

function scrollToBottom() {
  const el = messagesContainer.value;
  if (el) el.scrollTop = el.scrollHeight;
  pinnedToBottom.value = true;
}

watch(messages, async () => {
  await nextTick();
  if (pinnedToBottom.value) scrollToBottom();
}, { deep: true });

// Entering a session always starts at the bottom: reset the pin when the
// open session changes (history then streams in and the watcher above
// keeps us glued), and settle once more after images/code render.
// Remounting the chat view (back from a management page) does the same.
async function settleToBottom() {
  pinnedToBottom.value = true;
  await nextTick();
  scrollToBottom();
  setTimeout(() => {
    if (pinnedToBottom.value) scrollToBottom();
  }, 150);
}

watch(() => currentSession.value?.sessionId, (id) => {
  showAllHistory.value = false;
  if (id) void settleToBottom();
});

onMounted(() => {
  if (currentSession.value) void settleToBottom();
  void refreshGptQuota();
  gptQuotaTimer = setInterval(() => void refreshGptQuota(), 5 * 60 * 1000);
});
// Usage only moves after a turn finishes; refresh the quota then too.
watch(isLoading, (loading, was) => {
  if (was && !loading) void refreshGptQuota();
});
onUnmounted(() => {
  if (gptQuotaTimer) clearInterval(gptQuotaTimer);
});

async function handleSend() {
  const text = inputText.value.trim();
  const images = attachments.value
    .filter(a => a.kind === 'image')
    .map(a => ({ data: a.data!, mimeType: a.mimeType! }));
  const resources = attachments.value
    .filter(a => a.kind !== 'image')
    .map(a => a.kind === 'file'
      ? { kind: 'file' as const, name: a.name!, uri: 'file:///' + encodeURIComponent(a.name!), text: a.text!, mimeType: a.mimeType || 'text/plain' }
      : { kind: 'link' as const, name: a.name!, uri: a.uri! });
  if ((!text && images.length === 0 && resources.length === 0) || isLoading.value) return;
  
  inputText.value = '';
  attachments.value = [];
  try {
    await sessionStore.sendPrompt(text, images, resources);
  } catch (e) {
    console.error('Failed to send prompt:', e);
  }
}

function handleKeyDown(event: KeyboardEvent) {
  // Let CommandPalette handle navigation keys when visible
  if (showCommandPalette.value && commandPaletteRef.value) {
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
      commandPaletteRef.value.handleKeyDown(event);
      return;
    }
  }

  // Enter-to-send is desktop only. On mobile we let the textarea insert a
  // newline like every other native chat app and require an explicit tap
  // on the Send button.
  if (submitOnEnter && event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    handleSend();
  }
}

function handleCommandSelect(command: SlashCommand) {
  // Replace current input with the command
  if (command.hint) {
    inputText.value = `/${command.name} `;
  } else {
    inputText.value = `/${command.name} `;
  }
}

function handleCommandClose() {
  // Just dismiss, keep the text
}

function handleCancel() {
  sessionStore.cancelOperation();
}

async function handleModeChange(modeId: string) {
  try {
    await sessionStore.setMode(modeId);
  } catch (e) {
    console.error('Failed to change mode:', e);
  }
}

async function handleModelChange(modelId: string) {
  try {
    await sessionStore.setModel(modelId);
  } catch (e) {
    console.error('Failed to change model:', e);
  }
}

async function handleConfigOptionChange(configId: string, value: string) {
  try {
    await sessionStore.setConfigOption(configId, value);
  } catch (e) {
    console.error('Failed to change config option:', e);
  }
}

function isThoughtExpanded(messageId: string): boolean {
  return expandedThoughts.value.has(messageId);
}

function toggleThought(messageId: string): void {
  if (expandedThoughts.value.has(messageId)) {
    expandedThoughts.value.delete(messageId);
  } else {
    expandedThoughts.value.add(messageId);
  }
}

const expandedToolCalls = ref<Set<string>>(new Set());

function isToolCallExpanded(toolCallId: string): boolean {
  return expandedToolCalls.value.has(toolCallId);
}

function toggleToolCall(toolCallId: string): void {
  if (expandedToolCalls.value.has(toolCallId)) {
    expandedToolCalls.value.delete(toolCallId);
  } else {
    expandedToolCalls.value.add(toolCallId);
  }
}

// The agent's plan entries, rendered as a card above the messages
const planEntries = computed(() => sessionStore.planEntries);

// Render a tool-call diff: line-based LCS so unchanged lines show
// once, removed lines with -, added with +. Falls back to a plain
// before/after listing when the inputs are too large for the table.
interface DiffLine { kind: 'same' | 'del' | 'add'; prefix: string; text: string }
function diffLines(item: { oldText?: string | null; newText?: string }): DiffLine[] {
  const oldLines = (item.oldText ?? '').split('\n');
  const newLines = (item.newText ?? '').split('\n');
  if (oldLines.length * newLines.length > 250000) {
    return [
      ...oldLines.map(text => ({ kind: 'del' as const, prefix: '- ', text })),
      ...newLines.map(text => ({ kind: 'add' as const, prefix: '+ ', text })),
    ];
  }
  const dp: number[][] = Array.from({ length: oldLines.length + 1 }, () => new Array(newLines.length + 1).fill(0));
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      out.push({ kind: 'same', prefix: '  ', text: oldLines[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'del', prefix: '- ', text: oldLines[i] });
      i++;
    } else {
      out.push({ kind: 'add', prefix: '+ ', text: newLines[j] });
      j++;
    }
  }
  while (i < oldLines.length) out.push({ kind: 'del', prefix: '- ', text: oldLines[i++] });
  while (j < newLines.length) out.push({ kind: 'add', prefix: '+ ', text: newLines[j++] });
  return out;
}

const markdownCache = new Map<string, string>();
function renderMarkdown(content: string): string {
  // Agent output is untrusted markup: sanitize before it hits v-html.
  // Memoized: a streaming update re-renders the whole list, and parsing
  // every unchanged message again was a real cost on long histories.
  const hit = markdownCache.get(content);
  if (hit !== undefined) return hit;
  const html = DOMPurify.sanitize(marked.parse(content, { async: false }) as string);
  if (markdownCache.size > 400) markdownCache.clear();
  markdownCache.set(content, html);
  return html;
}

function getToolIcon(kind: string): string {
  switch (kind) {
    case 'read': return 'book';
    case 'edit': return 'pencil';
    case 'delete': return 'trash';
    case 'move': return 'package';
    case 'search': return 'search';
    case 'execute': return 'terminal';
    case 'think': return 'chat';
    case 'fetch': return 'globe';
    default: return 'wrench';
  }
}

function getStatusIcon(status: string): string {
  switch (status) {
    case 'pending': return '…';
    case 'in_progress': return '◉';
    case 'completed': return '✓';
    case 'failed': return '✗';
    default: return '';
  }
}
</script>

<template>
  <div
    class="chat-view"
    :class="{ 'drag-over': isDragging }"
    @dragover.prevent="isDragging = true"
    @dragleave="isDragging = false"
    @drop.prevent="handleDrop"
  >
    <div class="chat-header">
      <h2>{{ displayTitle }}</h2>
      <div class="header-right">
        <button class="export-btn" @click="exportSession" :title="t('chat.exportTitle')"><Icon name="download" /> {{ t('chat.export') }}</button>
        <span class="agent-name">{{ currentSession?.agentName }}</span>
      </div>
    </div>
    
    <div ref="messagesContainer" class="messages-container" @scroll="onMessagesScroll">
      <div v-if="isLoadingHistory" class="history-loading"><span class="spinner"></span> {{ showingCachedHistory ? t('chat.cacheSyncing') : t('chat.loadingHistory') }}</div>
      <div v-else-if="showingCachedHistory" class="history-loading">{{ t('chat.cacheStale') }}</div>
      <button v-if="hiddenCount > 0" type="button" class="show-earlier-btn" @click="showAllHistory = true">{{ t('chat.showEarlier').replace('{n}', String(hiddenCount)) }}</button>
      <!-- The agent's plan for this session (ACP `plan` updates) -->
      <div v-if="planEntries.length" class="plan-card">
        <div class="plan-title">{{ t('chat.plan') }}</div>
        <ul class="plan-list">
          <li v-for="(entry, i) in planEntries" :key="i" :class="['plan-item', `plan-${entry.status}`]">
            <span class="plan-icon">{{ entry.status === 'completed' ? '✓' : entry.status === 'in_progress' ? '◉' : '○' }}</span>
            <span class="plan-text">{{ entry.content }}</span>
          </li>
        </ul>
      </div>
      <div 
        v-for="message in visibleMessages" 
        :key="message.id"
        :class="['message', `message-${message.role}`]"
      >
        <div class="message-header">
          <span class="role">{{ message.role === 'user' ? t('chat.you') : t('chat.assistant') }}</span>
          <button
            class="copy-btn"
            @click="copyMessage(message)"
            :title="copiedId === message.id ? t('chat.copied') : t('chat.copyMessage')"
          ><Icon :name="copiedId === message.id ? 'check' : 'copy'" /></button>
          <button
            v-if="message.role === 'user'"
            class="copy-btn"
            @click="editMessage(message)"
            :title="t('chat.editMessage')"
          ><Icon name="pencil" /></button>
        </div>
        
        <div class="message-body">
        <!-- Images attached to a user message -->
        <div v-if="message.images?.length" class="message-images">
          <img v-for="(src, i) in message.images" :key="i" :src="src" class="message-image" alt="attachment" />
        </div>
        
        <!-- Context attachments on a user message -->
        <div v-if="message.resources?.length" class="message-resources">
          <span v-for="(name, i) in message.resources" :key="i" class="resource-chip">📄 {{ name }}</span>
        </div>
        
        <!-- Agent thinking section (collapsible) - shown first to explain reasoning -->
        <div v-if="message.thought && message.role === 'assistant'" class="thought-section">
          <button class="thought-toggle" @click="toggleThought(message.id)">
            <span class="thought-icon">💭</span>
            <span class="thought-label">{{ isThoughtExpanded(message.id) ? t('chat.hideThinking') : t('chat.showThinking') }}</span>
            <span class="thought-chevron">{{ isThoughtExpanded(message.id) ? '▲' : '▼' }}</span>
          </button>
          <div v-if="isThoughtExpanded(message.id)" class="thought-content">
            <div v-html="renderMarkdown(message.thought)" />
          </div>
        </div>
        
        <!-- Tool calls for this message (shown after thinking) -->
        <div v-if="message.toolCalls?.length" class="tool-calls-section">
          <template v-for="tc in message.toolCalls" :key="tc.toolCallId">
          <div
            :class="['tool-call-inline', `tool-${tc.status}`, { clickable: !!tc.content?.length }]"
            @click="tc.content?.length && toggleToolCall(tc.toolCallId)"
          >
            <span class="tool-icon"><Icon :name="getToolIcon(tc.kind)" /></span>
            <span class="tool-name">{{ tc.title }}</span>
            <span v-if="tc.locations?.length" class="tool-location">
              {{ tc.locations[0].path }}
            </span>
            <span :class="['tool-status', `status-${tc.status}`]">
              {{ getStatusIcon(tc.status) }}
            </span>
            <span v-if="tc.content?.length" class="tool-chevron">{{ isToolCallExpanded(tc.toolCallId) ? '▲' : '▼' }}</span>
          </div>
          <div v-if="isToolCallExpanded(tc.toolCallId) && tc.content?.length" class="tool-content">
            <template v-for="(item, ci) in tc.content" :key="ci">
              <pre v-if="item.kind === 'text'" class="tool-text">{{ item.text }}</pre>
              <div v-else-if="item.kind === 'diff'" class="tool-diff">
                <div class="diff-path">{{ item.path }}</div>
                <div v-for="(line, li) in diffLines(item)" :key="li" :class="['diff-line', line.kind]">{{ line.prefix }}{{ line.text }}</div>
              </div>
              <div v-else-if="item.kind === 'terminal'" class="tool-terminal">Terminal {{ item.terminalId }}</div>
            </template>
          </div>
          <McpAppView
            v-if="tc.mcpApp && tc.status === 'completed'"
            :session-id="sessionStore.currentSession?.sessionId || ''"
            :extension-name="tc.mcpApp.extensionName"
            :tool-name="tc.mcpApp.toolName"
            :resource-uri="tc.mcpApp.resourceUri"
            :html="tc.mcpApp.html"
            :tool-input="tc.rawInput"
            :raw-content="tc.rawContent"
            :raw-output="tc.rawOutput"
          />
          </template>
        </div>
        
        <div 
          v-if="message.content"
          class="message-content"
          v-html="renderMarkdown(message.content)"
        />
        </div>
      </div>
      
      <!-- Loading indicator -->
      <div v-if="isLoading && !isLoadingHistory" class="loading-indicator">
        <span class="spinner"></span>
        <span>{{ t('chat.thinking') }}</span>
        <button class="cancel-btn" @click="handleCancel">{{ t('chat.cancel') }}</button>
      </div>
    </div>

    <button
      v-if="!pinnedToBottom"
      class="scroll-bottom-btn"
      type="button"
      @click="scrollToBottom"
    ><Icon name="chevronDown" /> {{ t('chat.toBottom') }}</button>

    <div class="input-container">
      <CommandPalette
        ref="commandPaletteRef"
        :commands="availableCommands"
        :filter="commandFilter"
        :visible="showCommandPalette"
        @select="handleCommandSelect"
        @close="handleCommandClose"
      />
      <div v-if="attachments.length" class="attachments-strip">
        <template v-for="(att, i) in attachments" :key="i">
          <div v-if="att.kind === 'image'" class="attachment-thumb">
            <img :src="att.url" alt="attachment" />
            <button class="attachment-remove" @click="removeAttachment(i)" :title="t('chat.removeAttachment')">×</button>
          </div>
          <div v-else class="attachment-chip">
            <span class="chip-name"><Icon :name="att.kind === 'link' ? 'link' : 'file'" /> {{ att.name }}</span>
            <button class="attachment-remove chip-remove" @click="removeAttachment(i)" :title="t('chat.removeAttachment')">×</button>
          </div>
        </template>
      </div>
      <input ref="fileInput" type="file" accept="image/*,text/*,.md,.markdown,.json,.yaml,.yml,.toml,.csv,.log" multiple hidden @change="handleFileSelect" />
      <textarea
        ref="textareaRef"
        v-model="inputText"
        @paste="handlePaste"
        :placeholder="
          isReconnecting
            ? t('chat.reconnecting')
            : (availableCommands.length > 0
                ? t('chat.placeholderCmd')
                : t('chat.placeholder'))
        "
        :disabled="isLoading || isReconnecting"
        @keydown="handleKeyDown"
        rows="1"
      />
      <button 
        class="send-btn"
        :disabled="(!inputText.trim() && attachments.length === 0) || isLoading || isReconnecting"
        @click="handleSend"
      >
        {{ t('chat.send') }}
      </button>
    </div>

    <!-- Bottom status bar (Hermes-style): session state, the session
         pickers (model / provider / thinking / mode) as quick controls,
         then context usage and cost. Pickers open upward (drop-up). -->
    <div v-if="currentSession" class="status-bar">
      <span class="status-item status-state">
        <span class="status-dot" :class="{ working: isLoading }"></span>
        {{ isLoading ? t('chat.working') : t('chat.ready') }}
      </span>
      <span v-if="gptQuotaText" class="status-item" :title="gptQuotaTitle">{{ gptQuotaText }}</span>
      <span class="status-tools">
        <button class="attach-btn" @click="fileInput?.click()" :title="t('chat.attachFile')"><Icon name="paperclip" /></button>
        <button class="attach-btn" @click="addLink" :title="t('chat.attachLink')"><Icon name="link" /></button>
        <button class="attach-btn" @click="showExtPanel = !showExtPanel" :title="t('ext.title')"><Icon name="grid" /></button>
      </span>
      <div class="status-pickers">
        <ModelPicker
          v-if="availableModels.length > 0"
          :models="availableModels"
          :current-model-id="currentModelId"
          :disabled="isLoading"
          drop-up
          @change="handleModelChange"
        />
        <ConfigOptionPicker
          v-for="opt in visibleConfigOptions"
          :key="opt.id"
          :option="opt"
          :disabled="isLoading"
          drop-up
          @change="handleConfigOptionChange(opt.id, $event)"
        />
        <ModePicker
          v-if="availableModes.length > 0"
          :modes="availableModes"
          :current-mode-id="currentModeId"
          :disabled="isLoading"
          drop-up
          @change="handleModeChange"
        />
      </div>
      <span class="status-spacer"></span>
      <span v-if="usageText" class="status-item">{{ t('chat.context') }} {{ usageText }}</span>
      <span v-if="costText" class="status-item">{{ costText }}</span>
    </div>
  </div>
  <ExtensionsPanel v-if="showExtPanel" @close="showExtPanel = false" />
  <AppDialog v-bind="dialog" @confirm="onDialogConfirm" @cancel="onDialogCancel" />
</template>

<style scoped>
.chat-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  position: relative;
}

.scroll-bottom-btn {
  position: absolute;
  right: 1rem;
  bottom: 9.5rem;
  z-index: 5;
  padding: 0.5rem 0.9rem;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  background: var(--bg-dialog);
  color: var(--text-primary);
  font-size: 0.85rem;
  box-shadow: 0 4px 16px rgba(10, 30, 28, 0.18);
  cursor: pointer;
}

.scroll-bottom-btn:hover {
  background: var(--bg-hover);
}

.chat-header {
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border-color);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.chat-header h2 {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.agent-name {
  font-size: 0.875rem;
  color: var(--text-accent);
}

.messages-container {
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
  /* One centered column: on wide screens the messages live in an 880px
     column, so right-aligned user bubbles line up with that column. */
  padding-inline: max(1rem, calc((100% - 880px) / 2));
  display: flex;
  flex-direction: column;
}

.history-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.5rem;
  color: var(--text-muted);
  font-size: 0.85rem;
}

.show-earlier-btn {
  align-self: center;
  margin-bottom: 1rem;
  padding: 0.45rem 1rem;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  background: var(--bg-dialog);
  color: var(--text-secondary);
  font-size: 0.85rem;
  cursor: pointer;
}

.message {
  margin-bottom: 1.25rem;
  width: 100%;
  max-width: 880px;
  padding: 0.75rem;
  border-radius: 8px;
  /* Off-screen messages skip layout/paint until scrolled near. */
  content-visibility: auto;
  contain-intrinsic-size: auto 140px;
}

.message-user {
  /* WeChat-style: my messages hug the right side of the column. The
     bubble itself is .message-body; the header lives outside it. */
  align-self: flex-end;
  width: auto;
  max-width: 85%;
  min-width: 0;
  background: transparent;
  padding: 0;
}

.message-user .message-body {
  background: var(--bg-user);
  border-radius: 14px;
  padding: 0.75rem;
}

.message-user .message-header {
  margin-bottom: 0.35rem;
  padding: 0 0.25rem;
}

.message-assistant {
  /* Document style: agent output sits directly on the page, no card */
  background: var(--bg-assistant, transparent);
  padding: 0.25rem 0;
  align-self: flex-start;
}

.message-header {
  margin-bottom: 0.5rem;
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.role {
  font-weight: 600;
  font-size: 0.875rem;
  color: var(--text-secondary);
}

/* Tool calls inline styles */
.tool-calls-section {
  margin-bottom: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.tool-call-inline {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.625rem;
  border-radius: 4px;
  font-size: 0.8rem;
  background: rgba(0, 0, 0, 0.04);
  border-left: 2px solid var(--border-color);
}

.tool-pending {
  border-left-color: var(--status-pending);
}

.tool-in_progress {
  border-left-color: var(--text-accent);
  background: rgba(14, 107, 110, 0.08);
}

.tool-completed {
  border-left-color: var(--status-success);
  background: rgba(53, 146, 104, 0.10);
}

.tool-failed {
  border-left-color: var(--status-failed);
  background: rgba(192, 69, 62, 0.08);
}

.tool-icon {
  font-size: 0.875rem;
}

.tool-name {
  font-weight: 500;
  color: var(--text-primary);
}

.tool-location {
  flex: 1;
  color: var(--text-muted);
  font-size: 0.75rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tool-status {
  font-size: 0.75rem;
  font-weight: 600;
}

.status-pending { color: var(--status-pending); }
.status-in_progress { color: var(--text-accent); }
.status-completed { color: var(--status-success); }
.status-failed { color: var(--status-failed); }

.message-content {
  line-height: 1.65;
  overflow-wrap: break-word;
  word-wrap: break-word;
}

.message-content :deep(p) {
  margin: 0.5rem 0;
}

.message-content :deep(ol),
.message-content :deep(ul) {
  margin: 0.5rem 0;
  padding-left: 1.5rem;
}

.message-content :deep(li) {
  margin: 0.25rem 0;
}

.message-content :deep(pre) {
  background: var(--bg-code);
  color: var(--text-code);
  padding: 0.75rem;
  border-radius: 4px;
  overflow-x: auto;
}

.message-content :deep(code) {
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 0.9rem;
}

.loading-indicator {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem;
  color: var(--text-muted);
}

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border-color);
  border-top-color: var(--text-accent);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.cancel-btn {
  margin-left: auto;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: transparent;
  font-size: 0.8rem;
  cursor: pointer;
}

.input-container {
  position: relative;
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
  margin: 0 1rem 0.75rem;
  padding: 0.5rem;
  background: var(--bg-main);
  border: 1px solid var(--border-color);
  border-radius: 14px;
  flex-wrap: wrap;
  box-shadow: 0 10px 28px rgba(13, 25, 23, 0.10);
}

.input-container:focus-within {
  border-color: var(--text-accent);
  box-shadow: 0 10px 28px rgba(13, 25, 23, 0.10), 0 0 0 3px rgba(14, 107, 110, 0.18);
}


/* Mobile layout: wrap the header pickers instead of squeezing them,
   tighten message gutters, keep the composer thumb-friendly and clear
   of the home indicator. */
@media (max-width: 800px) {
  .chat-header {
    flex-wrap: wrap;
    padding: 0.75rem;
    gap: 0.5rem;
  }

  .header-right {
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .agent-name {
    display: none;
  }

  .messages-container {
    padding: 0.75rem;
  }

  .message-user {
    max-width: 88%;
  }

  .input-container {
    margin: 0 0.75rem 0.5rem;
    padding: 0.5rem;
  }

  textarea {
    font-size: 16px; /* >=16px prevents iOS focus auto-zoom */
  }

  .send-btn {
    padding: 0.75rem 1rem;
    min-height: 48px;
  }

  .status-bar {
    padding: 0 1rem calc(0.5rem + env(safe-area-inset-bottom, 0px));
    font-size: 0.75rem;
    gap: 0.75rem;
  }

  /* All pickers side by side on one row at natural width; the leading
     icons are hidden on small screens so the labels themselves fit. */
  .status-pickers {
    flex: 1 1 100%;
    flex-wrap: nowrap;
    gap: 0.3rem;
  }

  .status-pickers > * {
    flex: 0 1 auto;
    min-width: 0;
  }

  .status-pickers :deep(.config-button),
  .status-pickers :deep(.model-button),
  .status-pickers :deep(.mode-button) {
    max-width: none;
    padding: 0.35rem 0.45rem;
    font-size: 0.72rem;
    gap: 0.25rem;
  }

  .status-pickers :deep(.config-icon),
  .status-pickers :deep(.model-icon),
  .status-pickers :deep(.mode-icon) {
    display: none;
  }

  .status-pickers :deep(.config-name),
  .status-pickers :deep(.model-name),
  .status-pickers :deep(.mode-name) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

textarea {
  flex: 1;
  max-height: 132px;
  padding: 0.625rem 0.75rem;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 1rem;
  font-family: inherit;
  resize: none;
}

textarea:focus {
  outline: none;
}

.send-btn {
  padding: 0.75rem 1.5rem;
  background: var(--bg-primary);
  color: white;
  border: none;
  border-radius: 10px;
  font-size: 1rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s;
}

.send-btn:hover:not(:disabled) {
  background: var(--bg-primary-hover);
}

.send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Bottom status bar (Hermes-style): quiet, one line, live session state */
.status-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  row-gap: 0.4rem;
  gap: 1rem;
  padding: 0 1.25rem 0.75rem;
  font-size: 0.78rem;
  color: var(--text-muted);
}

.status-tools {
  display: inline-flex;
  gap: 0.1rem;
}

.status-bar .attach-btn {
  width: 34px;
  height: 34px;
  align-self: center;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.status-pickers {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.status-item {
  white-space: nowrap;
}

.status-state {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--status-success);
}

.status-dot.working {
  background: var(--status-pending);
}

.status-spacer {
  flex: 1;
}

/* Attachments, message actions, export (chat feature parity pass) */
.chat-view.drag-over {
  outline: 2px dashed var(--text-accent);
  outline-offset: -6px;
}

.attach-btn {
  align-self: flex-end;
  width: 42px;
  height: 42px;
  border: none;
  border-radius: 10px;
  background: transparent;
  font-size: 1.15rem;
  cursor: pointer;
}

.attach-btn:hover {
  background: var(--bg-hover);
}

.attachments-strip {
  flex: 0 0 100%;
  display: flex;
  gap: 0.5rem;
  padding: 0.25rem 0.25rem 0;
}

.attachment-thumb {
  position: relative;
  width: 56px;
  height: 56px;
}

.attachment-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid var(--border-color);
}

.attachment-remove {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 50%;
  background: var(--bg-danger);
  color: #fff;
  font-size: 0.8rem;
  line-height: 1;
  cursor: pointer;
}

.message-images {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 0.25rem 0 0.5rem;
}

.message-image {
  max-width: min(100%, 420px);
  max-height: 260px;
  border-radius: 10px;
  border: 1px solid var(--border-color);
}

.copy-btn {
  margin-left: auto;
  padding: 0.15rem 0.4rem;
  border: none;
  background: transparent;
  font-size: 0.8rem;
  cursor: pointer;
  opacity: 0.55;
  border-radius: 6px;
}

.copy-btn:hover {
  opacity: 1;
  background: var(--bg-hover);
}

.export-btn {
  padding: 0.45rem 0.8rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-main);
  color: var(--text-primary);
  font-size: 0.85rem;
  cursor: pointer;
  white-space: nowrap;
}

.export-btn:hover {
  background: var(--bg-hover);
}

/* Plan card (ACP plan updates) */
.plan-card {
  max-width: 880px;
  margin: 0 auto 1rem;
  padding: 0.8rem 1rem;
  background: var(--bg-main);
  border: 1px solid var(--border-color);
  border-radius: 10px;
}

.plan-title {
  font-weight: 600;
  font-size: 0.85rem;
  margin-bottom: 0.5rem;
  color: var(--text-secondary);
}

.plan-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.plan-item {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  font-size: 0.92rem;
}

.plan-item.plan-completed .plan-text {
  color: var(--text-muted);
  text-decoration: line-through;
}

.plan-item.plan-in_progress .plan-text {
  font-weight: 600;
}

.plan-icon {
  flex: none;
  width: 1rem;
  text-align: center;
}

/* Expandable tool-call content: text output, diffs, terminal refs */
.tool-call-inline.clickable {
  cursor: pointer;
}

.tool-chevron {
  margin-left: 0.25rem;
  color: var(--text-muted);
  font-size: 0.7rem;
}

.tool-content {
  margin: 0.25rem 0 0.6rem;
}

.tool-text {
  margin: 0 0 0.5rem;
  padding: 0.6rem 0.75rem;
  background: var(--bg-code);
  color: var(--text-code);
  border-radius: 8px;
  font-size: 0.8rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow-y: auto;
}

.tool-diff {
  margin-bottom: 0.5rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  overflow: hidden;
  font-family: ui-monospace, 'SF Mono', Consolas, monospace;
  font-size: 0.78rem;
  line-height: 1.55;
}

.diff-path {
  padding: 0.35rem 0.6rem;
  background: var(--bg-hover);
  font-weight: 600;
}

.diff-line {
  padding: 0 0.6rem;
  white-space: pre-wrap;
  word-break: break-word;
}

.diff-line.add {
  background: rgba(53, 146, 104, 0.13);
}

.diff-line.del {
  background: rgba(192, 69, 62, 0.13);
}

.tool-terminal {
  font-size: 0.8rem;
  color: var(--text-muted);
  margin-bottom: 0.5rem;
}

/* Context attachment chips (composer strip + sent messages) */
.attachment-chip {
  position: relative;
  display: inline-flex;
  align-items: center;
  max-width: 220px;
  height: 56px;
  padding: 0 0.7rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-hover);
}

.chip-name {
  font-size: 0.82rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chip-remove {
  top: -6px;
  right: -6px;
}

.message-resources {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin: 0.25rem 0 0.5rem;
}

.resource-chip {
  font-size: 0.8rem;
  padding: 0.25rem 0.6rem;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  background: var(--bg-hover);
}

/* ---------- Mobile / narrow-viewport tweaks ---------- */

@media (max-width: 800px) {
  /* Reserve space for the floating mobile hamburger (44px wide, fixed in
     App.vue) so the mode/model pickers don't sit underneath it. Also push
     the header below the camera notch / status bar so picker buttons aren't
     clipped on phones with a hole-punch or notch. */
  .chat-header {
    padding-top: calc(1rem + env(safe-area-inset-top, 0px));
    padding-left: calc(44px + 1rem);
  }

  /* Agent identity is already shown in the sidebar drawer; on a phone the
     chat header should belong to mode/model/actions. Hiding the long name
     also avoids awkward 4-line wraps for names like "Copilot CLI dev tunnel". */
  .agent-name {
    display: none;
  }

  /* Session title is also redundant on mobile (visible in the sidebar
     SessionList) and otherwise gets crushed to a single character by the
     mode/model pickers. Reclaim the horizontal space. */
  .chat-header h2 {
    display: none;
  }

  .input-container {
    /* iOS home-indicator: keep Send button reachable above the gesture area. */
    padding-bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
    gap: 0.5rem;
  }

  textarea {
    /* Avoid iOS auto-zoom on focus when font-size < 16px. */
    font-size: 16px;
    min-height: 44px;
  }

  .send-btn {
    min-width: 64px;
    min-height: 44px;
    padding: 0.5rem 1rem;
  }
}

/* Agent Thinking Section */
.thought-section {
  margin-bottom: 0.75rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  overflow: hidden;
}

.thought-toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.5rem 0.75rem;
  background: var(--bg-hover);
  border: none;
  cursor: pointer;
  font-size: 0.85rem;
  color: var(--text-muted);
  text-align: left;
  transition: background 0.15s ease;
}

.thought-toggle:hover {
  background: var(--bg-user);
}

.thought-icon {
  font-size: 1rem;
  flex-shrink: 0;
}

.thought-label {
  flex: 1;
  font-weight: 500;
}

.thought-chevron {
  font-size: 0.7rem;
  color: var(--text-muted);
}

.thought-content {
  padding: 0.75rem 1rem 0.75rem 1.25rem;
  background: var(--bg-main);
  border-top: 1px solid var(--border-color);
  font-size: 0.9rem;
  color: var(--text-muted);
  font-style: italic;
  line-height: 1.5;
}

.thought-content :deep(p) {
  margin: 0 0 0.5rem 0;
}

.thought-content :deep(p:last-child) {
  margin-bottom: 0;
}

.thought-content :deep(code) {
  background: var(--bg-hover);
  padding: 0.125rem 0.25rem;
  border-radius: 3px;
  font-size: 0.85em;
}
</style>
