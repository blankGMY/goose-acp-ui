<script setup lang="ts">
/**
 * Skills page: manage the agent's skills, which live as directories
 * under ~/.agents/skills on the Pi (one SKILL.md each). The gateway API
 * does the file operations; builtin skills (shipped with Goose) are
 * listed read-only. Edits apply to new sessions.
 */
import { onMounted, reactive, ref, watch } from 'vue';
import { gatewayApi, type SkillInfo } from '../lib/gateway';
import { useI18n } from '../lib/i18n';
import AppDialog from './AppDialog.vue';
import { useDialog } from '../lib/useDialog';

const { t } = useI18n();
const { dialog, askConfirm, onDialogConfirm, onDialogCancel } = useDialog();

const skills = ref<SkillInfo[]>([]);
const loading = ref(true);
const error = ref('');
const notice = ref('');

const editingName = ref('');
const editContent = ref('');
const editLoading = ref(false);

const TEMPLATE = `---
name: my-skill
description: >
  What this skill does, and when the agent should use it.
---

# Instructions

Write the skill instructions here.
`;

const form = reactive({
  name: '',
  content: TEMPLATE,
});

// Keep the template's frontmatter name in sync while it is untouched.
watch(
  () => form.name,
  (name) => {
    if (name && form.content.includes('name: my-skill')) {
      form.content = form.content.replace('name: my-skill', `name: ${name}`);
    }
  },
);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const data = await gatewayApi<{ skills: SkillInfo[] }>('/api/skills');
    skills.value = data.skills;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function startEdit(skill: SkillInfo) {
  error.value = '';
  notice.value = '';
  editLoading.value = true;
  editingName.value = skill.name;
  editContent.value = '';
  try {
    const data = await gatewayApi<{ content: string }>('/api/skills/content', { name: skill.name });
    editContent.value = data.content;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    editingName.value = '';
  } finally {
    editLoading.value = false;
  }
}

async function saveEdit() {
  error.value = '';
  notice.value = '';
  try {
    await gatewayApi('/api/skills/save', { name: editingName.value, content: editContent.value });
    notice.value = t('skills.saved');
    editingName.value = '';
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function remove(skill: SkillInfo) {
  if (!(await askConfirm(t('skills.confirmDelete').replace('{name}', skill.name), { danger: true, confirmLabel: t('common.delete') }))) return;
  error.value = '';
  notice.value = '';
  try {
    await gatewayApi('/api/skills/delete', { name: skill.name });
    notice.value = t('skills.deleted');
    if (editingName.value === skill.name) editingName.value = '';
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function create() {
  error.value = '';
  notice.value = '';
  try {
    await gatewayApi('/api/skills/create', { name: form.name.trim(), content: form.content });
    notice.value = t('skills.created');
    form.name = '';
    form.content = TEMPLATE;
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

onMounted(load);
</script>

<template>
  <div>
    <h2>{{ t('skills.title') }}</h2>
    <p class="intro">{{ t('skills.intro') }}</p>

    <p v-if="error" class="banner error-banner-inline">{{ error }}</p>
    <p v-if="notice" class="banner notice-banner">{{ notice }}</p>
    <p v-if="loading" class="muted">{{ t('common.loading') }}</p>
    <p v-else-if="skills.length === 0" class="muted">{{ t('skills.empty') }}</p>

    <ul v-else class="skill-list">
      <li v-for="skill in skills" :key="skill.name" class="skill-row">
        <div class="skill-main">
          <div class="skill-title">
            <span class="skill-name">{{ skill.name }}</span>
            <span v-if="skill.builtin" class="chip chip-accent">{{ t('skills.builtin') }}</span>
            <span v-else class="chip chip-muted">{{ skill.files.length }} {{ t('skills.filesLabel') }}</span>
          </div>
          <p v-if="skill.description" class="skill-desc">{{ skill.description }}</p>
        </div>
        <div v-if="!skill.builtin" class="skill-actions">
          <button class="action-btn" @click="startEdit(skill)">{{ t('skills.edit') }}</button>
          <button class="action-btn danger" @click="remove(skill)">{{ t('skills.delete') }}</button>
        </div>
      </li>
    </ul>

    <div v-if="editingName" class="editor-panel">
      <h3 class="form-title">{{ t('skills.editorTitle') }} — {{ editingName }}</h3>
      <p v-if="editLoading" class="muted">{{ t('common.loading') }}</p>
      <textarea v-else v-model="editContent" class="code-editor" rows="20" spellcheck="false"></textarea>
      <div class="editor-actions">
        <button class="primary-btn" :disabled="editLoading" @click="saveEdit">{{ t('skills.save') }}</button>
        <button class="action-btn" @click="editingName = ''">{{ t('skills.cancel') }}</button>
      </div>
    </div>

    <h3 class="form-title">{{ t('skills.createTitle') }}</h3>
    <form class="create-form" @submit.prevent="create">
      <label>
        {{ t('skills.fName') }}
        <input v-model="form.name" required placeholder="e.g. my-skill" autocomplete="off" />
      </label>
      <label>
        {{ t('skills.fContent') }}
        <textarea v-model="form.content" class="code-editor" rows="12" spellcheck="false"></textarea>
      </label>
      <button type="submit" class="primary-btn">{{ t('skills.create') }}</button>
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

.skill-list {
  list-style: none;
  padding: 0;
  margin: 0 0 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.skill-row {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.8rem 1rem;
  background: var(--bg-main);
  border: 1px solid var(--border-color);
  border-radius: 10px;
}

.skill-main {
  flex: 1;
  min-width: 0;
}

.skill-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.45rem;
}

.skill-name {
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

.chip-accent {
  background: var(--bg-user);
  color: var(--text-primary);
}

.skill-desc {
  margin: 0.35rem 0 0;
  font-size: 0.88rem;
  color: var(--text-secondary);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.skill-actions {
  display: flex;
  gap: 0.4rem;
  flex: none;
}

.action-btn {
  min-height: 40px;
  padding: 0.5rem 0.8rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-main);
  color: var(--text-primary);
  font-size: 0.88rem;
  cursor: pointer;
}

.action-btn:hover {
  background: var(--bg-hover);
}

.action-btn.danger {
  color: var(--bg-danger);
}

.editor-panel {
  margin-bottom: 1.5rem;
}

.editor-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.6rem;
  align-items: center;
}

.code-editor {
  width: 100%;
  box-sizing: border-box;
  padding: 0.7rem 0.8rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-main);
  color: var(--text-primary);
  font-size: 0.88rem;
  font-family: ui-monospace, 'SF Mono', Consolas, monospace;
  line-height: 1.55;
  resize: vertical;
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

.create-form input {
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
  flex: none;
}

.primary-btn:hover {
  background: var(--bg-primary-hover);
}

.primary-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
