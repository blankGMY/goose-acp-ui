import { ref } from 'vue';

// Tiny i18n for the console chrome. Dictionaries are keyed by stable ids;
// English is the source text. The locale is a module-level ref shared by
// every component — reading it inside t() during render makes templates
// re-render on switch. The choice persists to localStorage.

export type Locale = 'en' | 'zh';

function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem('acp-ui:locale');
    if (stored === 'en' || stored === 'zh') return stored;
  } catch { /* storage unavailable */ }
  return navigator.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export const locale = ref<Locale>(initialLocale());

export function setLocale(next: Locale): void {
  locale.value = next;
  try {
    localStorage.setItem('acp-ui:locale', next);
  } catch { /* storage unavailable */ }
}

const dict: Record<string, { en: string; zh: string }> = {
  'nav.sessions': { en: 'Sessions', zh: '会话' },
  'nav.extensions': { en: 'Extensions', zh: '扩展' },
  'nav.recipes': { en: 'Recipes', zh: '配方' },
  'nav.schedules': { en: 'Schedules', zh: '定时' },
  'nav.skills': { en: 'Skills', zh: '技能' },
  'nav.settings': { en: 'Settings', zh: '设置' },

  'app.workingDir': { en: 'Working Directory:', zh: '工作目录：' },
  'app.sessionMcp': { en: 'Session MCP server (optional):', zh: '会话 MCP 服务器（可选）：' },
  'app.newSession': { en: 'New Session', zh: '新建会话' },
  'app.connecting': { en: 'Connecting...', zh: '连接中…' },
  'app.disconnect': { en: 'Disconnect', zh: '断开连接' },
  'app.reconnect': { en: 'Reconnect', zh: '重新连接' },
  'app.welcomeTitle': { en: 'Welcome to Goose', zh: '欢迎使用 Goose' },
  'app.welcomeText': { en: 'Select an agent and create a new session to get started.', zh: '在左侧选择智能体并新建会话即可开始。' },
  'app.selectAgentFirst': { en: 'Select an agent in the sidebar first, then run the recipe.', zh: '先在左侧栏选择一个智能体，再运行配方。' },

  'list.savedSessions': { en: 'Saved Sessions', zh: '已保存的会话' },
  'list.search': { en: 'Search sessions', zh: '搜索会话' },
  'list.noMatch': { en: 'No sessions match your search.', zh: '没有符合搜索的会话。' },
  'list.rename': { en: 'Rename session', zh: '重命名会话' },
  'list.delete': { en: 'Delete session', zh: '删除会话' },

  'chat.export': { en: 'Export', zh: '导出' },
  'chat.exportTitle': { en: 'Export session as Markdown', zh: '把会话导出为 Markdown' },
  'chat.ready': { en: 'Ready', zh: '就绪' },
  'chat.working': { en: 'Working', zh: '工作中' },
  'chat.context': { en: 'Context', zh: '上下文' },
  'chat.gptQuota': { en: 'GPT 5h {p}% · wk {s}%', zh: 'GPT 5h {p}% · 周 {s}%' },
  'chat.gptQuotaTitle': { en: 'GPT {plan}: 5-hour window resets {p}, weekly window resets {s}', zh: 'GPT {plan}：5 小时窗口 {p} 重置，周窗口 {s} 重置' },
  'chat.send': { en: 'Send', zh: '发送' },
  'chat.cancel': { en: 'Cancel', zh: '取消' },
  'chat.toBottom': { en: 'Back to bottom', zh: '回到底部' },
  'chat.you': { en: 'You', zh: '你' },
  'chat.assistant': { en: 'Assistant', zh: '助手' },
  'chat.copyMessage': { en: 'Copy message', zh: '复制消息' },
  'chat.copied': { en: 'Copied', zh: '已复制' },
  'chat.editMessage': { en: 'Edit', zh: '编辑' },
  'chat.loadingHistory': { en: 'Loading history…', zh: '正在加载历史…' },
  'chat.cacheSyncing': { en: 'Showing device cache · syncing…', zh: '已显示本地缓存 · 同步中…' },
  'chat.cacheStale': { en: 'Sync incomplete · showing device cache', zh: '同步未完成 · 显示本地缓存' },
  'chat.showEarlier': { en: 'Show {n} earlier messages', zh: '显示更早的 {n} 条消息' },
  'chat.placeholder': { en: 'Type your message...', zh: '输入消息…' },
  'chat.placeholderCmd': { en: 'Type your message... (/ for commands)', zh: '输入消息…（/ 唤起命令）' },
  'chat.reconnecting': { en: 'Reconnecting…', zh: '重新连接中…' },
  'chat.plan': { en: 'Plan', zh: '计划' },
  'chat.attachFile': { en: 'Attach an image or a text file', zh: '添加图片或文本文件' },
  'chat.attachLink': { en: 'Attach a link as context', zh: '添加链接作为上下文' },
  'chat.removeAttachment': { en: 'Remove attachment', zh: '移除附件' },
  'chat.linkPrompt': { en: 'Attach a link as context (https://…)', zh: '输入要作为上下文的链接（https://…）' },
  'chat.thought': { en: 'Thought', zh: '思考过程' },
  'chat.showThinking': { en: 'Show Thinking', zh: '查看思考' },
  'chat.hideThinking': { en: 'Hide Thinking', zh: '隐藏思考' },

  'perm.title': { en: 'Permission Required', zh: '需要授权' },

  'ext.title': { en: 'Extensions', zh: '扩展' },
  'ext.addTitle': { en: 'Add an extension', zh: '添加扩展' },
  'pool.title': { en: 'GPT account pool', zh: 'GPT 账号池' },
  'pool.refresh': { en: 'Refresh', zh: '刷新' },
  'pool.active': { en: 'Active', zh: '在用' },
  'pool.standby': { en: 'Standby', zh: '备用' },
  'pool.parked': { en: 'Parked', zh: '停泊' },
  'pool.until': { en: 'until {time}', zh: '至 {time}' },
  'pool.reasonCapped': { en: 'usage limit reached', zh: '额度用满' },
  'pool.reasonInvalid': { en: 'login invalid', zh: '登录失效' },
  'pool.reasonManual': { en: 'parked manually', zh: '手动停泊' },
  'pool.window5h': { en: '5-hour window', zh: '5 小时窗口' },
  'pool.windowWeek': { en: 'Weekly window', zh: '每周窗口' },
  'pool.resetAt': { en: 'resets {time}', zh: '{time} 重置' },
  'pool.loadFailed': { en: 'Failed to load pool status', zh: '号池状态加载失败' },
  'pool.healthError': { en: 'status check failed', zh: '状态查询失败' },
  'ext.add': { en: 'Add extension', zh: '添加扩展' },
  'ext.remove': { en: 'Remove', zh: '移除' },
  'ext.empty': { en: 'No extensions found.', zh: '没有找到扩展。' },
  'ext.note': { en: 'Changes apply to new sessions.', zh: '改动对新建会话生效。' },
  'ext.name': { en: 'Name', zh: '名称' },
  'ext.type': { en: 'Type', zh: '类型' },
  'ext.description': { en: 'Description', zh: '描述' },
  'ext.uri': { en: 'MCP server URL', zh: 'MCP 服务器地址' },
  'ext.auth': { en: 'Authorization header (optional)', zh: 'Authorization 头（可选）' },
  'ext.command': { en: 'Command', zh: '命令' },
  'ext.args': { en: 'Arguments (space separated)', zh: '参数（空格分隔）' },

  'rec.title': { en: 'Recipes', zh: '配方' },
  'rec.createTitle': { en: 'Create a recipe', zh: '新建配方' },
  'rec.save': { en: 'Save recipe', zh: '保存配方' },
  'rec.run': { en: 'Run', zh: '运行' },
  'rec.empty': { en: 'No recipes yet. Create the first one below.', zh: '还没有配方。在下面创建第一个。' },
  'ext.confirmRemove': { en: 'Remove extension "{name}"? This deletes it from Goose\'s config.', zh: '移除扩展“{name}”？这会把它从 Goose 的配置里删除。' },
  'sch.confirmRemove': { en: 'Remove schedule "{id}"?', zh: '移除定时任务“{id}”？' },
  'rec.fTitle': { en: 'Title', zh: '标题' },
  'rec.fDescription': { en: 'Description', zh: '描述' },
  'rec.fInstructions': { en: 'Instructions', zh: '指令' },
  'rec.fPrompt': { en: 'Prompt', zh: '提示词' },

  'sch.title': { en: 'Schedules', zh: '定时任务' },
  'sch.addTitle': { en: 'Add a schedule', zh: '添加定时' },
  'sch.add': { en: 'Add schedule', zh: '添加' },
  'sch.runNow': { en: 'Run now', zh: '立即运行' },
  'sch.remove': { en: 'Remove', zh: '移除' },
  'sch.empty': { en: 'No schedules yet.', zh: '还没有定时任务。' },
  'sch.cron': { en: 'Cron expression', zh: 'Cron 表达式' },
  'sch.recipe': { en: 'Recipe', zh: '配方' },

  'set.title': { en: 'Settings', zh: '设置' },
  'set.save': { en: 'Save', zh: '保存' },
  'set.saving': { en: 'Saving...', zh: '保存中…' },
  'set.cancel': { en: 'Cancel', zh: '取消' },

  'common.loading': { en: 'Loading…', zh: '加载中…' },
  'common.cancel': { en: 'Cancel', zh: '取消' },
  'common.confirm': { en: 'Confirm', zh: '确认' },
  'common.delete': { en: 'Delete', zh: '删除' },
  'list.confirmDelete': { en: 'Delete this session?', zh: '删除这个会话？' },
  'chat.thinking': { en: 'Thinking...', zh: '思考中…' },
  'app.configureAgents': { en: 'Configure agents in your config file to begin.', zh: '先在配置文件里配置智能体，再开始使用。' },
  'rec.intro': { en: 'A recipe packages instructions and a prompt into a reusable workflow. Running one starts (or continues) a session with that content as the first message.', zh: '配方把指令和提示词打包成可复用的工作流。运行一个配方会新建（或继续）一个会话，并把配方内容作为第一条消息发出。' },
  'rec.savedAs': { en: 'Recipe saved as {file}.', zh: '配方已保存为 {file}。' },
  'ext.removed': { en: '{name} removed.', zh: '已删除扩展 {name}。' },
  'sch.removed': { en: 'Schedule "{id}" removed.', zh: '已删除定时任务“{id}”。' },
  'set.connection': { en: 'Connection', zh: '连接' },
  'list.noSessionsForDir': { en: 'No sessions in this working directory yet.', zh: '当前工作目录下还没有会话。' },
  'list.emptyTitle': { en: 'No saved sessions yet.', zh: '还没有保存的会话。' },
  'list.emptyHint': { en: 'Create a new session to get started.', zh: '新建一个会话开始使用。' },
  'set.agents': { en: 'Agents', zh: '智能体连接' },
  'set.name': { en: 'Name', zh: '名称' },
  'set.transport': { en: 'Transport', zh: '连接方式' },
  'set.transportStdio': { en: 'stdio (local subprocess)', zh: 'stdio（本地子进程）' },
  'set.transportWebsocket': { en: 'websocket (remote)', zh: 'websocket（远程）' },
  'set.transportHttp': { en: 'http (remote)', zh: 'http（远程）' },
  'set.stdioUnavailable': { en: 'stdio is not available on this platform.', zh: '此平台不支持 stdio。' },
  'set.command': { en: 'Command', zh: '命令' },
  'set.arguments': { en: 'Arguments', zh: '参数' },
  'set.argumentsHint': { en: 'Space-separated. Use quotes for args with spaces.', zh: '用空格分隔；带空格的参数请加引号。' },
  'set.headers': { en: 'Headers', zh: '请求头' },
  'set.configFile': { en: 'Config File', zh: '配置文件' },
  'set.configReloadNote': { en: 'Changes to this file are automatically reloaded.', zh: '对此文件的修改会自动重新加载。' },
  'set.addAgent': { en: '+ Add Agent', zh: '+ 添加智能体' },
  'set.edit': { en: 'Edit', zh: '编辑' },
  'set.confirmDeleteAgent': { en: 'Delete agent "{name}"?', zh: '删除智能体“{name}”？' },
  'tm.title': { en: 'ACP Traffic', zh: 'ACP 流量' },
  'tm.requests': { en: 'Requests', zh: '请求' },
  'tm.responses': { en: 'Responses', zh: '响应' },
  'tm.notifications': { en: 'Notifications', zh: '通知' },
  'common.optional': { en: '(optional)', zh: '（可选）' },
  'ext.builtIn': { en: 'built-in', zh: '内置' },
  'ext.hasAuth': { en: 'has auth', zh: '已配密钥' },
  'ext.enabled': { en: 'Enabled', zh: '已启用' },
  'ext.disabled': { en: 'Disabled', zh: '已禁用' },
  'ext.typeRemote': { en: 'Remote (streamable HTTP)', zh: '远程（streamable HTTP）' },
  'ext.typeStdio': { en: 'Local command (stdio, runs on the Pi)', zh: '本地命令（stdio，在树莓派上运行）' },
  'ext.argsNote': { en: '(space-separated)', zh: '（空格分隔）' },
  'rec.instrNote': { en: '(context / rules for the agent)', zh: '（给智能体的上下文/规则）' },
  'rec.promptNote': { en: '(the task itself)', zh: '（任务本身）' },
  'skills.title': { en: 'Skills', zh: '技能' },
  'skills.intro': { en: 'Skills are instruction packs the agent loads on demand. Each skill is a directory on the Pi (~/.agents/skills) holding a SKILL.md file. Edits apply to new sessions.', zh: '技能是智能体按需加载的指令包。每个技能是树莓派上的一个目录（~/.agents/skills），里面有一份 SKILL.md。修改对新会话生效。' },
  'skills.empty': { en: 'No skills found.', zh: '还没有技能。' },
  'skills.builtin': { en: 'Built-in', zh: '内置' },
  'skills.filesLabel': { en: 'files', zh: '个文件' },
  'skills.edit': { en: 'Edit', zh: '编辑' },
  'skills.delete': { en: 'Delete', zh: '删除' },
  'skills.confirmDelete': { en: 'Delete skill "{name}"? The whole skill directory will be removed.', zh: '删除技能“{name}”？整个技能目录都会被删除。' },
  'skills.editorTitle': { en: 'Edit SKILL.md', zh: '编辑 SKILL.md' },
  'skills.save': { en: 'Save', zh: '保存' },
  'skills.cancel': { en: 'Cancel', zh: '取消' },
  'skills.createTitle': { en: 'New skill', zh: '新建技能' },
  'skills.fName': { en: 'Name (directory)', zh: '名称（目录名）' },
  'skills.fContent': { en: 'SKILL.md content', zh: 'SKILL.md 内容' },
  'skills.create': { en: 'Create skill', zh: '创建技能' },
  'skills.saved': { en: 'Saved.', zh: '已保存。' },
  'skills.created': { en: 'Skill created.', zh: '技能已创建。' },
  'skills.deleted': { en: 'Skill deleted.', zh: '技能已删除。' },
  'sch.lastRun': { en: 'last run', zh: '上次运行' },
  'sch.never': { en: 'never', zh: '从未' },
  'sch.id': { en: 'Schedule ID', zh: '定时 ID' },
  'sch.needRecipe': { en: 'Create a recipe first - schedules run recipes.', zh: '先创建一个配方——定时任务运行的是配方。' },
  'sch.hint': { en: 'Five fields (minute hour day month weekday), or @daily / @hourly. Example: "0 9 * * *" is every day at 09:00.', zh: '五个字段（分 时 日 月 周），或 @daily / @hourly。例："0 9 * * *" 是每天 09:00。' },
};

export function t(key: string): string {
  const entry = dict[key];
  return entry ? entry[locale.value] : key;
}

export function useI18n(): { locale: typeof locale; setLocale: typeof setLocale; t: typeof t } {
  return { locale, setLocale, t };
}
