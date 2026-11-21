<script setup lang="ts">
import { computed, ref } from 'vue';
import { useSessionStore } from '../stores/session';
import { useI18n } from '../lib/i18n';
import AppDialog from './AppDialog.vue';
import Icon from './Icon.vue';
import { useDialog } from '../lib/useDialog';
import type { SavedSession } from '../lib/types';

const emit = defineEmits<{
  resume: [session: SavedSession];
  delete: [sessionId: string];
  rename: [session: SavedSession, title: string];
}>();

const props = defineProps<{
  // When set, only sessions created in this working directory are shown.
  cwdFilter?: string;
}>();

const sessionStore = useSessionStore();
const { t } = useI18n();
const { dialog, askConfirm, askPrompt, onDialogConfirm, onDialogCancel } = useDialog();

// Only show sessions that can be resumed (agent supports loadSession),
// narrowed to the current working directory when one is selected.
const sessions = computed(() => {
  const all = [...sessionStore.resumableSessions].sort((a, b) => b.lastUpdated - a.lastUpdated);
  const f = (props.cwdFilter ?? '').trim().replace(/\/+$/, '');
  if (!f) return all;
  return all.filter(x => (x.cwd ?? '').trim().replace(/\/+$/, '') === f);
});

const hasAnySessions = computed(() => sessionStore.resumableSessions.length > 0);

const query = ref('');

// Sessions grouped by working directory - one group per "project"
// (Hermes-style). Groups and their sessions are newest-activity first.
interface SessionGroup { cwd: string; label: string; sessions: SavedSession[] }
const groups = computed<SessionGroup[]>(() => {
  const q = query.value.trim().toLowerCase();
  const filtered = sessions.value.filter(s =>
    !q ||
    displayTitle(s).toLowerCase().includes(q) ||
    (s.cwd || '').toLowerCase().includes(q));
  const byCwd = new Map<string, SavedSession[]>();
  for (const s of filtered) {
    const key = s.cwd || '';
    if (!byCwd.has(key)) byCwd.set(key, []);
    byCwd.get(key)!.push(s);
  }
  return [...byCwd.entries()]
    .map(([cwd, items]) => ({
      cwd,
      label: cwd ? (cwd.split(/[\\/]/).filter(Boolean).pop() || cwd) : 'Other',
      sessions: items,
    }))
    .sort((a, b) => (b.sessions[0]?.lastUpdated ?? 0) - (a.sessions[0]?.lastUpdated ?? 0));
});

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function handleResume(session: SavedSession) {
  emit('resume', session);
}

async function handleDelete(sessionId: string, event: Event) {
  event.stopPropagation();
  if (await askConfirm(t('list.confirmDelete'), { danger: true, confirmLabel: t('common.delete') })) {
    emit('delete', sessionId);
  }
}

// A user-chosen rename (title override in the store) wins over the
// server-provided title everywhere the title is shown or searched.
function displayTitle(session: SavedSession): string {
  return sessionStore.titleOverrides[session.sessionId] ?? session.title;
}

async function handleRename(session: SavedSession, event: Event) {
  event.stopPropagation();
  const next = await askPrompt(t('list.rename'), displayTitle(session));
  if (next && next.trim() && next.trim() !== displayTitle(session)) {
    emit('rename', session, next.trim());
  }
}
</script>

<template>
  <div class="session-list">
    <div class="list-head">
      <h3>{{ t('list.savedSessions') }}</h3>
      <span v-if="sessions.length" class="count">{{ sessions.length }}</span>
    </div>
    <input
      v-if="sessions.length > 5"
      v-model="query"
      class="session-search"
      type="search"
      :placeholder="t('list.search')"
      autocapitalize="none"
      autocorrect="off"
      spellcheck="false"
    />
    
    <div v-if="sessions.length === 0" class="empty-state">
      <p v-if="props.cwdFilter && hasAnySessions">{{ t('list.noSessionsForDir') }}</p>
      <template v-else>
        <p>{{ t('list.emptyTitle') }}</p>
        <p class="hint">{{ t('list.emptyHint') }}</p>
      </template>
    </div>
    
    <div v-else-if="groups.length === 0" class="empty-state">
      <p>{{ t('list.noMatch') }}</p>
    </div>
    
    <div v-else>
      <div v-for="group in groups" :key="group.cwd" class="session-group">
        <div class="group-header">
          <span class="group-name">{{ group.label }}</span>
          <span class="group-path" :title="group.cwd">{{ group.cwd }}</span>
        </div>
        <ul>
          <li 
            v-for="session in group.sessions" 
            :key="session.id"
            class="session-item"
            @click="handleResume(session)"
          >
            <div class="session-info">
              <span class="session-title">{{ displayTitle(session) }}</span>
              <span class="session-agent">{{ session.agentName }}</span>
              <span class="session-date">{{ formatDate(session.lastUpdated) }}</span>
            </div>
            <button 
              class="rename-btn"
              @click="(e) => handleRename(session, e)"
              :title="t('list.rename')"
            >
              <Icon name="pencil" />
            </button>
            <button 
              class="delete-btn"
              @click="(e) => handleDelete(session.id, e)"
              :title="t('list.delete')"
            >
              ×
            </button>
          </li>
        </ul>
      </div>
    </div>
  </div>
  <AppDialog v-bind="dialog" @confirm="onDialogConfirm" @cancel="onDialogCancel" />
</template>

<style scoped>
.session-list {
  padding: 1rem;
}

h3 {
  margin: 0;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-secondary, #666);
}

.list-head {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.count {
  font-size: 0.78rem;
  color: var(--text-muted);
}

.session-search {
  width: 100%;
  box-sizing: border-box;
  padding: 0.55rem 0.75rem;
  margin-bottom: 0.75rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-main);
  color: var(--text-primary);
  font-size: 0.9rem;
}

.session-group {
  margin-bottom: 0.75rem;
}

.group-header {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.25rem 0.1rem 0.45rem;
}

.group-name {
  font-weight: 600;
  font-size: 0.88rem;
  white-space: nowrap;
}

.group-path {
  flex: 1;
  font-size: 0.72rem;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: right;
}

.empty-state {
  text-align: center;
  padding: 2rem;
  color: var(--text-muted);
}

.empty-state .hint {
  font-size: 0.875rem;
  margin-top: 0.5rem;
}

ul {
  list-style: none;
  padding: 0;
  margin: 0;
}

.session-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem;
  background: var(--bg-main);
  border: 1px solid var(--border-color, #e0e0e0);
  border-radius: 10px;
  margin-bottom: 0.5rem;
  cursor: pointer;
  transition: background 0.15s;
}

.session-item:hover {
  background: var(--bg-hover);
}

.session-info {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  overflow: hidden;
}

.session-title {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-agent {
  font-size: 0.75rem;
  color: var(--text-accent, #0066cc);
}

.session-date {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.rename-btn {
  min-width: 36px;
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.25rem 0.5rem;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 1rem;
  cursor: pointer;
  border-radius: 4px;
}

.rename-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.delete-btn {
  min-width: 36px;
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.25rem 0.5rem;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 1.25rem;
  cursor: pointer;
  border-radius: 4px;
}

.delete-btn:hover {
  background: var(--bg-danger, #fee);
  color: var(--text-danger);
}

/* Mobile: bigger tap targets for session rows and the delete button */
@media (max-width: 800px) {
  .session-item {
    padding: 1rem 0.75rem;
    min-height: 56px;
  }

  .delete-btn {
    padding: 0.5rem 0.75rem;
    font-size: 1.5rem;
  }
}
</style>
