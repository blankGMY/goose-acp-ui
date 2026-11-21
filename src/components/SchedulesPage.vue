<script setup lang="ts">
/**
 * Schedules page: recurring recipe runs, backed by the gateway API
 * (which drives the `goose schedule` CLI on the Pi). A schedule snapshots
 * the recipe file at the moment it is added; editing the recipe later
 * does not change what an existing schedule runs.
 */
import { onMounted, reactive, ref } from 'vue';
import { gatewayApi, type RecipeInfo, type ScheduleInfo } from '../lib/gateway';
import { useI18n } from '../lib/i18n';
import AppDialog from './AppDialog.vue';
import { useDialog } from '../lib/useDialog';

const { t } = useI18n();
const { dialog, askConfirm, onDialogConfirm, onDialogCancel } = useDialog();

const schedules = ref<ScheduleInfo[]>([]);
const recipes = ref<RecipeInfo[]>([]);
const loading = ref(true);
const error = ref('');
const notice = ref('');
const busyId = ref('');

const form = reactive({
  id: '',
  cron: '0 9 * * *',
  recipeFile: '',
});

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [s, r] = await Promise.all([
      gatewayApi<{ schedules: ScheduleInfo[] }>('/api/schedules'),
      gatewayApi<{ recipes: RecipeInfo[] }>('/api/recipes'),
    ]);
    schedules.value = s.schedules;
    recipes.value = r.recipes;
    if (!form.recipeFile && recipes.value.length) {
      form.recipeFile = recipes.value[0].file;
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function add() {
  error.value = '';
  notice.value = '';
  try {
    await gatewayApi('/api/schedules/add', {
      id: form.id.trim(),
      cron: form.cron.trim(),
      recipeFile: form.recipeFile,
    });
    notice.value = `Schedule "${form.id.trim()}" added.`;
    form.id = '';
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function remove(schedule: ScheduleInfo) {
  if (!(await askConfirm(t('sch.confirmRemove').replace('{id}', schedule.id), { danger: true, confirmLabel: t('common.delete') }))) return;
  busyId.value = schedule.id;
  error.value = '';
  try {
    await gatewayApi('/api/schedules/remove', { id: schedule.id });
    notice.value = t('sch.removed').replace('{id}', schedule.id);
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busyId.value = '';
  }
}

async function runNow(schedule: ScheduleInfo) {
  busyId.value = schedule.id;
  error.value = '';
  notice.value = '';
  try {
    await gatewayApi('/api/schedules/run-now', { id: schedule.id });
    notice.value = `"${schedule.id}" started - its run appears as a new session in the list.`;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busyId.value = '';
  }
}

function recipeName(source: string): string {
  return source.split('/').pop() || source;
}

onMounted(load);
</script>

<template>
  <div>
    <h2>{{ t('sch.title') }}</h2>
    <p class="intro">
      Run a recipe on a cron schedule. The Pi's Goose runs around the clock,
      so schedules fire as long as the Pi is on. Adding a schedule snapshots
      the recipe - later edits to the recipe do not affect it.
    </p>

    <p v-if="error" class="banner error-banner-inline">{{ error }}</p>
    <p v-if="notice" class="banner notice-banner">{{ notice }}</p>
    <p v-if="loading" class="muted">{{ t('common.loading') }}</p>
    <p v-else-if="schedules.length === 0" class="muted">{{ t('sch.empty') }}</p>

    <ul v-else class="schedule-list">
      <li v-for="schedule in schedules" :key="schedule.id" class="schedule-row">
        <div class="schedule-main">
          <div class="schedule-title">
            <span class="schedule-name">{{ schedule.id }}</span>
            <span class="chip">{{ schedule.status || 'scheduled' }}</span>
          </div>
          <p class="schedule-meta">
            <span class="mono">{{ schedule.cron }}</span>
            · {{ recipeName(schedule.recipeSource) }}
            · {{ t('sch.lastRun') }}: {{ schedule.lastRun || t('sch.never') }}
          </p>
        </div>
        <div class="schedule-actions">
          <button class="ghost-btn" :disabled="busyId === schedule.id" @click="runNow(schedule)">
            {{ t('sch.runNow') }}
          </button>
          <button class="remove-btn" :disabled="busyId === schedule.id" @click="remove(schedule)">
            {{ t('sch.remove') }}
          </button>
        </div>
      </li>
    </ul>

    <h3 class="form-title">{{ t('sch.addTitle') }}</h3>
    <p v-if="!loading && recipes.length === 0" class="muted">
      {{ t('sch.needRecipe') }}
    </p>
    <form v-else class="add-form" @submit.prevent="add">
      <label>
        {{ t('sch.id') }}
        <input v-model="form.id" required placeholder="e.g. morning-briefing" autocomplete="off" />
      </label>
      <label>
        {{ t('sch.cron') }}
        <input v-model="form.cron" required placeholder="0 9 * * *" autocomplete="off" class="mono-input" />
        <span class="hint">{{ t('sch.hint') }}</span>
      </label>
      <label>
        {{ t('sch.recipe') }}
        <select v-model="form.recipeFile">
          <option v-for="recipe in recipes" :key="recipe.file" :value="recipe.file">
            {{ recipe.title }} ({{ recipe.file }})
          </option>
        </select>
      </label>
      <button type="submit" class="primary-btn">{{ t('sch.add') }}</button>
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
  margin-bottom: 1.5rem;
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

.schedule-list {
  list-style: none;
  padding: 0;
  margin: 0 0 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.schedule-row {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.8rem 1rem;
  background: var(--bg-main);
  border: 1px solid var(--border-color);
  border-radius: 10px;
}

.schedule-main {
  flex: 1;
  min-width: 0;
}

.schedule-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.45rem;
}

.schedule-name {
  font-weight: 600;
}

.chip {
  font-size: 0.7rem;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  background: var(--bg-user);
  color: var(--text-primary);
}

.schedule-meta {
  margin: 0.35rem 0 0;
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.mono,
.mono-input {
  font-family: ui-monospace, 'SF Mono', Consolas, monospace;
}

.schedule-actions {
  display: flex;
  gap: 0.5rem;
  flex: none;
}

.ghost-btn {
  padding: 0.45rem 0.8rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: transparent;
  color: var(--text-primary);
  font-size: 0.85rem;
  cursor: pointer;
}

.ghost-btn:hover {
  background: var(--bg-hover);
}

.remove-btn {
  padding: 0.45rem 0.8rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: transparent;
  color: var(--bg-danger);
  font-size: 0.85rem;
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

.add-form .hint {
  color: var(--text-muted);
  font-size: 0.8rem;
  line-height: 1.5;
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
