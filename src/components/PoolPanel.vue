<script setup lang="ts">
/**
 * GPT account pool panel, shown under the `pool` extension on the
 * Extensions page. Read-only view: which ChatGPT accounts are in the
 * pool, which one is active, park state, and live quota per account.
 * Data comes from the gateway's /api/pool/status (pool.py status-json).
 */
import { onMounted, ref } from 'vue';
import { poolStatus, type PoolAccount, type PoolStatus } from '../lib/gateway';
import { useI18n } from '../lib/i18n';

const { t } = useI18n();

const data = ref<PoolStatus | null>(null);
const loading = ref(true);
const error = ref('');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    data.value = await poolStatus();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function fmtTime(epochSec: number | null | undefined): string {
  if (!epochSec) return '-';
  const d = new Date(epochSec * 1000);
  return d.toLocaleString(undefined, {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function stateLabel(a: PoolAccount): string {
  if (a.is_active) return t('pool.active');
  if (a.state === 'parked') return t('pool.parked');
  return t('pool.standby');
}

function reasonLabel(a: PoolAccount): string {
  if (a.park_reason === 'capped') return t('pool.reasonCapped');
  if (a.park_reason === 'invalid') return t('pool.reasonInvalid');
  if (a.park_reason === 'manual') return t('pool.reasonManual');
  return a.park_reason || '';
}

function barClass(used: number): string {
  if (used >= 90) return 'fill fill-danger';
  if (used >= 70) return 'fill fill-warning';
  return 'fill';
}
</script>

<template>
  <div class="pool-panel">
    <div class="pool-head">
      <span class="pool-title">{{ t('pool.title') }}</span>
      <button class="refresh-btn" :disabled="loading" @click="load">
        {{ t('pool.refresh') }}
      </button>
    </div>
    <p v-if="error" class="pool-error">{{ t('pool.loadFailed') }}: {{ error }}</p>
    <p v-else-if="loading && !data" class="pool-muted">{{ t('common.loading') }}</p>
    <ul v-else-if="data" class="pool-list">
      <li v-for="a in data.accounts" :key="a.id" class="pool-acct">
        <div class="pool-line">
          <span class="pool-id">{{ a.id }}</span>
          <span class="pool-acct-id">{{ a.account }}</span>
          <span
            class="chip"
            :class="a.is_active ? 'chip-active' : a.state === 'parked' ? 'chip-parked' : 'chip-muted'"
          >{{ stateLabel(a) }}</span>
          <span v-if="a.plan" class="chip chip-muted">{{ a.plan }}</span>
          <span v-if="a.state === 'parked' && reasonLabel(a)" class="pool-note">
            {{ reasonLabel(a) }}<template v-if="a.parked_until"> · {{ t('pool.until').replace('{time}', fmtTime(a.parked_until)) }}</template>
          </span>
          <span v-else-if="a.health === 'invalid' || a.health === 'error'" class="pool-note">
            {{ t('pool.healthError') }}
          </span>
        </div>
        <div v-if="a.primary" class="pool-window">
          <span class="pool-win-label">{{ t('pool.window5h') }}</span>
          <div class="bar"><div :class="barClass(a.primary.used)" :style="{ width: Math.min(100, a.primary.used) + '%' }"></div></div>
          <span class="pool-win-num">{{ a.primary.used }}%</span>
          <span class="pool-win-reset">{{ t('pool.resetAt').replace('{time}', fmtTime(a.primary.reset)) }}</span>
        </div>
        <div v-if="a.secondary" class="pool-window">
          <span class="pool-win-label">{{ t('pool.windowWeek') }}</span>
          <div class="bar"><div :class="barClass(a.secondary.used)" :style="{ width: Math.min(100, a.secondary.used) + '%' }"></div></div>
          <span class="pool-win-num">{{ a.secondary.used }}%</span>
          <span class="pool-win-reset">{{ t('pool.resetAt').replace('{time}', fmtTime(a.secondary.reset)) }}</span>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.pool-panel {
  margin-top: 0.8rem;
  border-top: 1px solid var(--border-color);
  padding-top: 0.8rem;
}

.pool-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.6rem;
}

.pool-title {
  font-weight: 600;
  color: var(--text-primary);
}

.refresh-btn {
  background: var(--bg-button);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 0.3rem 0.7rem;
  cursor: pointer;
  font-size: 0.85rem;
}

.refresh-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

.pool-error {
  color: var(--bg-danger);
  font-size: 0.9rem;
}

.pool-muted {
  color: var(--text-muted);
  font-size: 0.9rem;
}

.pool-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}

.pool-acct {
  background: var(--bg-hover);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  padding: 0.6rem 0.8rem;
}

.pool-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.45rem;
  margin-bottom: 0.45rem;
}

.pool-id {
  font-weight: 600;
  color: var(--text-primary);
}

.pool-acct-id {
  color: var(--text-muted);
  font-size: 0.85rem;
}

.chip {
  font-size: 0.75rem;
  padding: 0.12rem 0.5rem;
  border-radius: 999px;
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
}

.chip-active {
  color: var(--text-accent);
  border-color: var(--text-accent);
  font-weight: 600;
}

.chip-parked {
  color: var(--bg-danger);
  border-color: var(--bg-danger);
}

.chip-muted {
  color: var(--text-muted);
}

.pool-note {
  color: var(--text-secondary);
  font-size: 0.85rem;
}

.pool-window {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  font-size: 0.85rem;
  color: var(--text-secondary);
  margin-top: 0.3rem;
}

.pool-win-label {
  flex: 0 0 5.2rem;
  color: var(--text-muted);
}

.bar {
  flex: 1;
  height: 8px;
  border-radius: 999px;
  background: var(--bg-input);
  overflow: hidden;
}

.fill {
  height: 100%;
  background: var(--text-accent);
  border-radius: 999px;
}

.fill-warning {
  background: var(--bg-warning);
}

.fill-danger {
  background: var(--bg-danger);
}

.pool-win-num {
  flex: 0 0 2.6rem;
  text-align: right;
  color: var(--text-primary);
}

.pool-win-reset {
  color: var(--text-muted);
  font-size: 0.8rem;
}
</style>
