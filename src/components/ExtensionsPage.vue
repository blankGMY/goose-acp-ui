<script setup lang="ts">
/**
 * Extensions page: list / enable / disable / add / remove the agent's
 * MCP extensions, backed by the gateway API (which edits Goose's
 * config.yaml on the Pi). Changes apply to newly created sessions -
 * a running session keeps the extensions it started with.
 */
import { onMounted, reactive, ref } from 'vue';
import { gatewayApi, type ExtensionInfo } from '../lib/gateway';
import { useI18n } from '../lib/i18n';
import AppDialog from './AppDialog.vue';
import PoolPanel from './PoolPanel.vue';
import { useDialog } from '../lib/useDialog';

const { t } = useI18n();
const { dialog, askConfirm, onDialogConfirm, onDialogCancel } = useDialog();

const extensions = ref<ExtensionInfo[]>([]);
const loading = ref(true);
const error = ref('');
const notice = ref('');
const busyKey = ref('');

const form = reactive({
  name: '',
  type: 'streamable_http',
  description: '',
  uri: '',
  auth: '',
  cmd: '',
  args: '',
});

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const data = await gatewayApi<{ extensions: ExtensionInfo[] }>('/api/extensions');
    extensions.value = data.extensions;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function toggle(ext: ExtensionInfo, event: Event) {
  const enabled = (event.target as HTMLInputElement).checked;
  busyKey.value = ext.key;
  error.value = '';
  try {
    await gatewayApi('/api/extensions/toggle', { name: ext.key, enabled });
    ext.enabled = enabled;
    notice.value = `${ext.name} ${enabled ? 'enabled' : 'disabled'} - applies to new sessions.`;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    (event.target as HTMLInputElement).checked = ext.enabled;
  } finally {
    busyKey.value = '';
  }
}

async function remove(ext: ExtensionInfo) {
  if (!(await askConfirm(t('ext.confirmRemove').replace('{name}', ext.name), { danger: true, confirmLabel: t('common.delete') }))) return;
  busyKey.value = ext.key;
  error.value = '';
  try {
    await gatewayApi('/api/extensions/remove', { name: ext.key });
    notice.value = t('ext.removed').replace('{name}', ext.name);
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busyKey.value = '';
  }
}

async function add() {
  error.value = '';
  notice.value = '';
  const payload: Record<string, unknown> = {
    name: form.name.trim(),
    type: form.type,
    description: form.description.trim(),
  };
  if (form.type === 'streamable_http') {
    payload.uri = form.uri.trim();
    if (form.auth.trim()) payload.auth = form.auth.trim();
  } else {
    payload.cmd = form.cmd.trim();
    payload.args = form.args.trim() ? form.args.trim().split(/\s+/) : [];
  }
  try {
    await gatewayApi('/api/extensions/add', payload);
    notice.value = `${form.name} added and enabled - applies to new sessions.`;
    form.name = '';
    form.description = '';
    form.uri = '';
    form.auth = '';
    form.cmd = '';
    form.args = '';
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

onMounted(load);
</script>

<template>
  <div>
    <h2>{{ t('ext.title') }}</h2>
    <p class="intro">
      The agent's tools come from MCP extensions. Toggling or adding one here
      edits Goose's configuration on the Pi and applies to
      <strong>new sessions</strong>.
    </p>

    <p v-if="error" class="banner error-banner-inline">{{ error }}</p>
    <p v-if="notice" class="banner notice-banner">{{ notice }}</p>
    <p v-if="loading" class="muted">{{ t('common.loading') }}</p>

    <ul v-else class="ext-list">
      <li v-for="ext in extensions" :key="ext.key" class="ext-row">
        <div class="ext-main">
          <div class="ext-title">
            <span class="ext-name">{{ ext.name }}</span>
            <span class="chip">{{ ext.type }}</span>
            <span v-if="ext.bundled" class="chip chip-muted">{{ t('ext.builtIn') }}</span>
            <span v-if="ext.hasAuth" class="chip chip-muted">{{ t('ext.hasAuth') }}</span>
          </div>
          <p v-if="ext.description" class="ext-desc">{{ ext.description }}</p>
          <p v-if="ext.summary" class="ext-summary">{{ ext.summary }}</p>
        </div>
        <div class="ext-actions">
          <label class="switch" :title="ext.enabled ? t('ext.enabled') : t('ext.disabled')">
            <input
              type="checkbox"
              :checked="ext.enabled"
              :disabled="busyKey === ext.key"
              @change="toggle(ext, $event)"
            />
            <span class="track"></span>
          </label>
          <button
            v-if="!ext.bundled"
            class="remove-btn"
            :disabled="busyKey === ext.key"
            @click="remove(ext)"
          >
            {{ t('ext.remove') }}
          </button>
        </div>
        <div v-if="ext.key === 'pool'" class="pool-slot">
          <PoolPanel />
        </div>
      </li>
    </ul>

    <h3 class="form-title">{{ t('ext.addTitle') }}</h3>
    <form class="add-form" @submit.prevent="add">
      <label>
        {{ t('ext.name') }}
        <input v-model="form.name" required placeholder="e.g. my-tools" autocomplete="off" />
      </label>
      <label>
        {{ t('ext.type') }}
        <select v-model="form.type">
          <option value="streamable_http">{{ t('ext.typeRemote') }}</option>
          <option value="stdio">{{ t('ext.typeStdio') }}</option>
        </select>
      </label>
      <label>
        {{ t('ext.description') }} <span class="optional">{{ t('common.optional') }}</span>
        <input v-model="form.description" placeholder="What it does" autocomplete="off" />
      </label>
      <template v-if="form.type === 'streamable_http'">
        <label>
          URL
          <input v-model="form.uri" required placeholder="https://example.com/mcp" autocomplete="off" />
        </label>
        <label>
          {{ t('ext.auth') }} <span class="optional">{{ t('common.optional') }}</span>
          <input v-model="form.auth" placeholder="Bearer …" autocomplete="off" />
        </label>
      </template>
      <template v-else>
        <label>
          {{ t('ext.command') }}
          <input v-model="form.cmd" required placeholder="e.g. npx" autocomplete="off" />
        </label>
        <label>
          {{ t('ext.args') }} <span class="optional">{{ t('ext.argsNote') }}</span>
          <input v-model="form.args" placeholder="-y some-mcp-package" autocomplete="off" />
        </label>
      </template>
      <button type="submit" class="primary-btn">{{ t('ext.add') }}</button>
    </form>
  </div>
  <AppDialog v-bind="dialog" @confirm="onDialogConfirm" @cancel="onDialogCancel" />
</template>

<style scoped>
.intro {
  color: var(--text-secondary);
  line-height: 1.65;
  margin-bottom: 1rem;
}

.muted {
  color: var(--text-muted);
}

.banner {
  padding: 0.6rem 0.8rem;
  border-radius: 8px;
  margin-bottom: 0.75rem;
  font-size: 0.9rem;
  line-height: 1.5;
}

.error-banner-inline {
  background: rgba(192, 69, 62, 0.12);
  color: var(--bg-danger);
}

.notice-banner {
  background: var(--bg-user);
  color: var(--text-primary);
}

.ext-list {
  list-style: none;
  padding: 0;
  margin: 0 0 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.ext-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 1rem;
  padding: 0.8rem 1rem;
  background: var(--bg-main);
  border: 1px solid var(--border-color);
  border-radius: 10px;
}

.pool-slot {
  flex: 1 1 100%;
  min-width: 0;
}

.ext-main {
  flex: 1;
  min-width: 0;
}

.ext-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.45rem;
}

.ext-name {
  font-weight: 600;
}

.chip {
  font-size: 0.7rem;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  background: var(--bg-user);
  color: var(--text-primary);
}

.chip-muted {
  background: var(--bg-hover);
  color: var(--text-muted);
}

.ext-desc {
  margin: 0.35rem 0 0;
  font-size: 0.88rem;
  color: var(--text-secondary);
  line-height: 1.5;
}

.ext-summary {
  margin: 0.3rem 0 0;
  font-size: 0.78rem;
  color: var(--text-muted);
  font-family: ui-monospace, 'SF Mono', Consolas, monospace;
  overflow-wrap: anywhere;
}

.ext-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex: none;
  padding-top: 0.15rem;
}

/* Toggle switch */
.switch {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 24px;
  flex: none;
}

.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.switch .track {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: var(--border-color);
  transition: background 0.15s;
  cursor: pointer;
}

.switch .track::after {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--bg-main);
  transition: transform 0.15s;
}

.switch input:checked + .track {
  background: var(--bg-primary);
}

.switch input:checked + .track::after {
  transform: translateX(20px);
}

.remove-btn {
  min-height: 40px;
  padding: 0.4rem 0.7rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: transparent;
  color: var(--bg-danger);
  font-size: 0.82rem;
  cursor: pointer;
}

.form-title {
  font-size: 1rem;
  margin: 0 0 0.75rem;
}

.add-form {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  max-width: 680px;
}

.add-form label {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  font-size: 0.88rem;
  color: var(--text-secondary);
}

.add-form .optional {
  color: var(--text-muted);
  font-size: 0.8rem;
}

.add-form input,
.add-form select {
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-main);
  color: var(--text-primary);
  font-size: 0.95rem;
  font-family: inherit;
}

.primary-btn {
  align-self: flex-start;
  padding: 0.65rem 1.2rem;
  border: none;
  border-radius: 10px;
  background: var(--bg-primary);
  color: #fff;
  font-size: 0.95rem;
  font-weight: 600;
  cursor: pointer;
}

.primary-btn:hover {
  background: var(--bg-primary-hover);
}
</style>
