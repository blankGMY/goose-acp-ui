<script setup lang="ts">
/**
 * Recipes page: list the recipe files stored on the Pi, create new ones,
 * and run one. Running emits `run` to the app shell, which owns session
 * creation (agent + working directory live there) and then sends the
 * recipe's instructions + prompt as the first message.
 */
import { onMounted, reactive, ref } from 'vue';
import { gatewayApi, type RecipeInfo } from '../lib/gateway';
import { useI18n } from '../lib/i18n';

const { t } = useI18n();

const emit = defineEmits<{
  run: [recipe: RecipeInfo, values: Record<string, string>];
}>();

// Parameter values per recipe file, seeded from the recipes' defaults.
const paramValues = reactive<Record<string, Record<string, string>>>({});

const recipes = ref<RecipeInfo[]>([]);
const loading = ref(true);
const error = ref('');
const notice = ref('');

const form = reactive({
  title: '',
  description: '',
  instructions: '',
  prompt: '',
});

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const data = await gatewayApi<{ recipes: RecipeInfo[] }>('/api/recipes');
    recipes.value = data.recipes;
    for (const r of recipes.value) {
      if (r.parameters?.length && !paramValues[r.file]) {
        paramValues[r.file] = Object.fromEntries(r.parameters.map(p => [p.key, p.default || '']));
      }
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function create() {
  error.value = '';
  notice.value = '';
  try {
    const data = await gatewayApi<{ file: string }>('/api/recipes/create', {
      title: form.title.trim(),
      description: form.description.trim(),
      instructions: form.instructions.trim(),
      prompt: form.prompt.trim(),
    });
    notice.value = t('rec.savedAs').replace('{file}', data.file);
    form.title = '';
    form.description = '';
    form.instructions = '';
    form.prompt = '';
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

onMounted(load);
</script>

<template>
  <div>
    <h2>{{ t('rec.title') }}</h2>
    <p class="intro">{{ t('rec.intro') }}</p>

    <p v-if="error" class="banner error-banner-inline">{{ error }}</p>
    <p v-if="notice" class="banner notice-banner">{{ notice }}</p>
    <p v-if="loading" class="muted">{{ t('common.loading') }}</p>
    <p v-else-if="recipes.length === 0" class="muted">
      {{ t('rec.empty') }}
    </p>

    <ul v-else class="recipe-list">
      <li v-for="recipe in recipes" :key="recipe.file" class="recipe-row">
        <div class="recipe-main">
          <div class="recipe-title">
            <span class="recipe-name">{{ recipe.title }}</span>
            <span class="chip chip-muted">{{ recipe.file }}</span>
          </div>
          <p v-if="recipe.description" class="recipe-desc">{{ recipe.description }}</p>
          <div v-if="recipe.parameters?.length" class="recipe-params">
            <label v-for="p in recipe.parameters" :key="p.key" class="param-field">
              <span class="param-name">{{ p.key }}<span v-if="p.requirement === 'required'" class="required">*</span></span>
              <input v-model="paramValues[recipe.file][p.key]" :placeholder="p.description || p.key" autocomplete="off" />
            </label>
          </div>
        </div>
        <button class="primary-btn" @click="emit('run', recipe, paramValues[recipe.file] || {})">{{ t('rec.run') }}</button>
      </li>
    </ul>

    <h3 class="form-title">{{ t('rec.createTitle') }}</h3>
    <form class="create-form" @submit.prevent="create">
      <label>
        {{ t('rec.fTitle') }}
        <input v-model="form.title" required placeholder="e.g. Morning briefing" autocomplete="off" />
      </label>
      <label>
        {{ t('rec.fDescription') }} <span class="optional">{{ t('common.optional') }}</span>
        <input v-model="form.description" placeholder="What this recipe does" autocomplete="off" />
      </label>
      <label>
        {{ t('rec.fInstructions') }} <span class="optional">{{ t('rec.instrNote') }}</span>
        <textarea v-model="form.instructions" rows="4" placeholder="e.g. You prepare a short morning briefing…"></textarea>
      </label>
      <label>
        {{ t('rec.fPrompt') }} <span class="optional">{{ t('rec.promptNote') }}</span>
        <textarea v-model="form.prompt" rows="3" placeholder="e.g. Summarize today's calendar and unread mail."></textarea>
      </label>
      <button type="submit" class="primary-btn">{{ t('rec.save') }}</button>
    </form>
  </div>
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

.recipe-list {
  list-style: none;
  padding: 0;
  margin: 0 0 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.recipe-row {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.8rem 1rem;
  background: var(--bg-main);
  border: 1px solid var(--border-color);
  border-radius: 10px;
}

.recipe-main {
  flex: 1;
  min-width: 0;
}

.recipe-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.45rem;
}

.recipe-name {
  font-weight: 600;
}

.chip {
  font-size: 0.7rem;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
}

.chip-muted {
  background: var(--bg-hover);
  color: var(--text-muted);
}

.recipe-desc {
  margin: 0.35rem 0 0;
  font-size: 0.88rem;
  color: var(--text-secondary);
  line-height: 1.5;
}

.recipe-params {
  margin-top: 0.6rem;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.param-field {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.85rem;
}

.param-name {
  min-width: 90px;
  color: var(--text-secondary);
  font-family: ui-monospace, 'SF Mono', Consolas, monospace;
}

.param-field .required {
  color: var(--bg-danger);
}

.param-field input {
  flex: 1;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-main);
  color: var(--text-primary);
  font-size: 0.9rem;
  font-family: inherit;
}

.form-title {
  font-size: 1rem;
  margin: 0 0 0.75rem;
}

.create-form {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  max-width: 680px;
}

.create-form label {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  font-size: 0.88rem;
  color: var(--text-secondary);
}

.create-form .optional {
  color: var(--text-muted);
  font-size: 0.8rem;
}

.create-form input,
.create-form textarea {
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-main);
  color: var(--text-primary);
  font-size: 0.95rem;
  font-family: inherit;
  resize: vertical;
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
  flex: none;
}

.primary-btn:hover {
  background: var(--bg-primary-hover);
}
</style>
