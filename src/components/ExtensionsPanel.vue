<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { gatewayApi, type ExtensionInfo } from '../lib/gateway';
import { useI18n } from '../lib/i18n';

// In-chat extension toggles, mirroring Goose Desktop's chat-side
// extension panel. The switches write Goose's config via the gateway
// (same surface as the Extensions page), so they take effect for new
// sessions; the hint at the bottom says so.
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();

const extensions = ref<ExtensionInfo[]>([]);
const loading = ref(true);
const error = ref('');
const busyKey = ref('');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const data = await gatewayApi<{ extensions: ExtensionInfo[] }>('/api/extensions');
    // Enabled first, then by name: this panel is for quick toggling.
    extensions.value = [...data.extensions].sort((a, b) =>
      Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function toggle(ext: ExtensionInfo, event: Event) {
  const input = event.target as HTMLInputElement;
  const enabled = input.checked;
  busyKey.value = ext.key;
  try {
    await gatewayApi('/api/extensions/toggle', { name: ext.key, enabled });
    ext.enabled = enabled;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    input.checked = ext.enabled;
  } finally {
    busyKey.value = '';
  }
}

onMounted(load);
</script>

<template>
  <div class="ext-panel">
    <div class="ext-panel-head">
      <span class="ext-panel-title">{{ t('ext.title') }}</span>
      <button type="button" class="ext-close" @click="emit('close')">×</button>
    </div>
    <div v-if="loading" class="ext-hint">{{ t('common.loading') }}</div>
    <template v-else>
      <div v-if="error" class="ext-error">{{ error }}</div>
      <ul class="ext-list">
        <li v-for="ext in extensions" :key="ext.key" class="ext-row">
          <div class="ext-info">
            <span class="ext-name">{{ ext.name }}</span>
            <span v-if="ext.description" class="ext-desc">{{ ext.description }}</span>
          </div>
          <label class="switch" :title="ext.enabled ? t('ext.enabled') : t('ext.disabled')">
            <input
              type="checkbox"
              :checked="ext.enabled"
              :disabled="busyKey === ext.key"
              @change="toggle(ext, $event)"
            />
            <span class="track"></span>
          </label>
        </li>
      </ul>
      <div class="ext-hint">{{ t('ext.note') }}</div>
    </template>
  </div>
</template>

<style scoped>
.ext-panel {
  position: absolute;
  right: 1rem;
  bottom: 8.5rem;
  z-index: 20;
  width: min(92vw, 380px);
  max-height: 56vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-dialog);
  border: 1px solid var(--border-color);
  border-radius: 14px;
  box-shadow: 0 16px 40px rgba(10, 30, 28, 0.25);
  overflow: hidden;
}

.ext-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.7rem 0.9rem;
  border-bottom: 1px solid var(--border-color);
}

.ext-panel-title {
  font-weight: 600;
  color: var(--text-primary);
}

.ext-close {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 1.15rem;
  line-height: 1;
  padding: 0.25rem 0.45rem;
  cursor: pointer;
}

.ext-list {
  list-style: none;
  margin: 0;
  padding: 0.35rem 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.ext-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0.9rem;
}

.ext-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.ext-name {
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ext-desc {
  font-size: 0.78rem;
  color: var(--text-muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.ext-hint {
  padding: 0.6rem 0.9rem;
  font-size: 0.78rem;
  color: var(--text-muted);
}

.ext-error {
  padding: 0.6rem 0.9rem;
  font-size: 0.82rem;
  color: var(--text-danger);
}

/* Toggle switch (same pattern as the Extensions page) */
.switch {
  position: relative;
  display: inline-block;
  flex: none;
  width: 38px;
  height: 22px;
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
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.15s;
}

.switch input:checked + .track {
  background: var(--text-accent);
}

.switch input:checked + .track::after {
  transform: translateX(16px);
}

.switch input:disabled + .track {
  opacity: 0.5;
}
</style>
