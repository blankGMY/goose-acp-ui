<script setup lang="ts">
/**
 * The app's single modal dialog (see lib/useDialog.ts): a confirm mode
 * and a prompt mode with one text input. Styled from the theme variables
 * so it follows the petrol palette in light and dark mode.
 */
import { nextTick, ref, watch } from 'vue';
import { useI18n } from '../lib/i18n';

const { t } = useI18n();

const props = defineProps<{
  visible: boolean;
  title: string;
  message: string;
  mode: 'confirm' | 'prompt';
  initialValue: string;
  confirmLabel: string;
  danger: boolean;
}>();

const emit = defineEmits<{
  confirm: [value: string];
  cancel: [];
}>();

const inputValue = ref('');
const inputEl = ref<HTMLInputElement | null>(null);

watch(
  () => props.visible,
  async (v) => {
    if (v) {
      inputValue.value = props.initialValue ?? '';
      if (props.mode === 'prompt') {
        await nextTick();
        inputEl.value?.focus();
        inputEl.value?.select();
      }
    }
  },
);

function onConfirm() {
  emit('confirm', inputValue.value);
}
</script>

<template>
  <div v-if="visible" class="dialog-overlay" @click.self="emit('cancel')">
    <div class="dialog-card" role="dialog" aria-modal="true">
      <h3 v-if="title" class="dialog-title">{{ title }}</h3>
      <p v-if="message" class="dialog-message">{{ message }}</p>
      <input
        v-if="mode === 'prompt'"
        ref="inputEl"
        v-model="inputValue"
        class="dialog-input"
        type="text"
        @keydown.enter="onConfirm"
      />
      <div class="dialog-actions">
        <button type="button" class="action-btn" @click="emit('cancel')">
          {{ t('common.cancel') }}
        </button>
        <button
          type="button"
          class="primary-btn"
          :class="{ danger }"
          @click="onConfirm"
        >
          {{ confirmLabel || t('common.confirm') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(6, 20, 18, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}

.dialog-card {
  width: min(92vw, 400px);
  background: var(--bg-dialog);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: 14px;
  padding: 1.1rem 1.2rem;
  box-shadow: 0 12px 40px rgba(6, 20, 18, 0.3);
}

.dialog-title {
  font-size: 1rem;
  margin-bottom: 0.5rem;
}

.dialog-message {
  font-size: 0.92rem;
  line-height: 1.6;
  color: var(--text-secondary);
  margin-bottom: 0.4rem;
  word-break: break-word;
}

.dialog-input {
  width: 100%;
  box-sizing: border-box;
  margin-top: 0.5rem;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 16px;
  font-family: inherit;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 1rem;
}

.action-btn {
  min-height: 40px;
  padding: 0.5rem 0.95rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-button);
  color: var(--text-primary);
  font-size: 0.9rem;
  cursor: pointer;
}

.primary-btn {
  min-height: 40px;
  padding: 0.5rem 1.1rem;
  border: none;
  border-radius: 8px;
  background: var(--bg-primary);
  color: #fff;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
}

.primary-btn:hover {
  background: var(--bg-primary-hover);
}

.primary-btn.danger {
  background: var(--bg-danger);
}

.primary-btn.danger:hover {
  background: var(--bg-danger-hover);
}
</style>
