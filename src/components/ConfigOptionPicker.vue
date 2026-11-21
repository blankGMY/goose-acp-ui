<script setup lang="ts">
import { ref, computed } from 'vue';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';

// Generic picker for one ACP session config option (type: "select").
// Agents like Goose expose provider / model / thinking effort this way
// instead of via session/set_model, which is why this component exists:
// it renders whatever configOptions the agent advertises and reports the
// chosen value back so the store can call session/set_config_option.

const props = defineProps<{
  option: SessionConfigOption;
  disabled?: boolean;
  dropUp?: boolean;
}>();

const emit = defineEmits<{
  change: [value: string];
}>();

const isOpen = ref(false);

interface FlatOption {
  value: string;
  name: string;
  description?: string;
}

// Config option values can be a flat list or grouped; flatten to one list.
const flatOptions = computed<FlatOption[]>(() => {
  const out: FlatOption[] = [];
  const raw = (props.option.options ?? []) as unknown as Array<Record<string, unknown>>;
  for (const entry of raw) {
    if (Array.isArray(entry.options)) {
      for (const sub of entry.options as Array<Record<string, unknown>>) {
        out.push({
          value: String(sub.value),
          name: String(sub.name ?? sub.value),
          description: sub.description ? String(sub.description) : undefined,
        });
      }
    } else if (entry.value != null) {
      out.push({
        value: String(entry.value),
        name: String(entry.name ?? entry.value),
        description: entry.description ? String(entry.description) : undefined,
      });
    }
  }
  return out;
});

const currentValue = computed(() => String(props.option.currentValue ?? ''));
const currentOption = computed(() =>
  flatOptions.value.find(o => o.value === currentValue.value)
);

function getOptionIcon(configId: string): string {
  switch (configId.toLowerCase()) {
    case 'model': return '🤖';
    case 'provider': return '🔌';
    case 'thinking_effort': return '🧠';
    case 'mode': return '⚙️';
    default: return '⚙️';
  }
}

function toggleDropdown() {
  if (!props.disabled) {
    isOpen.value = !isOpen.value;
  }
}

function selectValue(value: string) {
  if (value !== currentValue.value) {
    emit('change', value);
  }
  isOpen.value = false;
}

function handleClickOutside(event: MouseEvent) {
  const target = event.target as HTMLElement;
  if (!target.closest('.config-picker')) {
    isOpen.value = false;
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('click', handleClickOutside);
}
</script>

<template>
  <div class="config-picker" :class="{ disabled, 'drop-up': dropUp }">
    <button
      class="config-button"
      :disabled="disabled"
      @click.stop="toggleDropdown"
      :title="`${option.name}: ${currentOption?.name || currentValue}`"
    >
      <span class="config-icon">{{ getOptionIcon(option.id) }}</span>
      <span class="config-name">{{ currentOption?.name || currentValue }}</span>
      <span class="dropdown-arrow">{{ isOpen ? '▲' : '▼' }}</span>
    </button>

    <Transition name="dropdown">
      <div v-if="isOpen" class="dropdown-menu" @click.stop>
        <div class="dropdown-title">{{ option.name }}</div>
        <div
          v-for="item in flatOptions"
          :key="item.value"
          :class="['dropdown-item', { selected: item.value === currentValue }]"
          @click="selectValue(item.value)"
        >
          <div class="item-content">
            <span class="item-name">{{ item.name }}</span>
            <span v-if="item.description" class="item-description">
              {{ item.description }}
            </span>
          </div>
          <span v-if="item.value === currentValue" class="check-mark">✓</span>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.config-picker {
  position: relative;
  display: inline-block;
}

.config-picker.disabled {
  opacity: 0.6;
  pointer-events: none;
}

.config-button {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.625rem;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-main);
  color: var(--text-primary);
  font-size: 0.8rem;
  cursor: pointer;
  transition: all 0.15s ease;
  max-width: 220px;
}

.config-button:hover:not(:disabled) {
  background: var(--bg-hover);
  border-color: var(--text-accent);
}

.config-button:disabled {
  cursor: not-allowed;
}

.config-icon {
  font-size: 0.9rem;
  flex-shrink: 0;
}

.config-name {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dropdown-arrow {
  font-size: 0.6rem;
  color: var(--text-muted);
  margin-left: 0.25rem;
  flex-shrink: 0;
}

.dropdown-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  min-width: 240px;
  max-width: 360px;
  max-height: 320px;
  overflow-y: auto;
  background: var(--bg-main);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 100;
}

@media (prefers-color-scheme: dark) {
  .dropdown-menu {
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  }
}

/* On phones re-anchor the menu to the viewport so it always fits, and make
   the button a comfortable touch target. */
@media (max-width: 800px) {
  .dropdown-menu {
    position: fixed;
    top: calc(env(safe-area-inset-top, 0px) + 4rem);
    left: 0.5rem;
    right: 0.5rem;
    bottom: auto;
    min-width: 0;
    max-width: none;
    max-height: calc(100vh - 6rem);
  }

  .config-button {
    min-height: 40px;
    padding: 0.5rem 0.75rem;
    font-size: 0.85rem;
  }
}

.dropdown-title {
  padding: 0.5rem 0.75rem 0.25rem;
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}

.dropdown-item {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.625rem 0.75rem;
  cursor: pointer;
  transition: background 0.1s ease;
}

.dropdown-item:hover {
  background: var(--bg-hover);
}

.dropdown-item.selected {
  background: var(--bg-user);
}

.dropdown-item + .dropdown-item {
  border-top: 1px solid var(--border-color);
}

.item-content {
  flex: 1;
  min-width: 0;
}

.item-name {
  display: block;
  font-weight: 500;
  color: var(--text-primary);
  font-size: 0.85rem;
}

.item-description {
  display: block;
  font-size: 0.75rem;
  color: var(--text-muted);
  margin-top: 0.125rem;
  line-height: 1.3;
}

.check-mark {
  color: var(--text-accent);
  font-weight: bold;
  margin-left: auto;
  flex-shrink: 0;
}

.dropdown-enter-active,
.dropdown-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
/* When the picker sits at the bottom of the screen (the chat status
   bar), open its menu upward instead of downward. */
.config-picker.drop-up .dropdown-menu {
  top: auto;
  bottom: calc(100% + 4px);
}

@media (max-width: 800px) {
  .config-picker.drop-up .dropdown-menu {
    top: auto;
    bottom: calc(env(safe-area-inset-bottom, 0px) + 4.5rem);
  }
}
</style>
