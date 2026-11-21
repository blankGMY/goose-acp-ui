<script setup lang="ts">
// MCP App (ext-apps) host for the web UI.
//
// Renders the UI attached to a tool call in a sandboxed iframe and
// bridges it to the agent over the existing ACP connection: app HTML
// comes from the tool update itself (or `_goose/unstable/resources/read`)
// and app-initiated tool calls go back via `_goose/unstable/tools/call`.
//
// The app document is loaded from a real gateway URL when possible
// (the gateway serves it with a CSP `sandbox` header, which forces an
// opaque origin), with srcdoc as fallback. Either way the iframe runs
// in an opaque origin, so app scripts cannot reach the page or the
// gateway API.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { AppBridge, PostMessageTransport } from '@mcp-ui/client';
import type { McpUiHostContext } from '@mcp-ui/client';
import { useSessionStore } from '../stores/session';

const props = defineProps<{
  sessionId: string;
  extensionName: string;
  toolName: string;
  resourceUri: string;
  html?: string;
  toolInput?: Record<string, unknown>;
  rawContent?: unknown[];
  rawOutput?: unknown;
}>();

const store = useSessionStore();
const frameEl = ref<HTMLIFrameElement | null>(null);
const frameHeight = ref(360);
const loadError = ref<string | null>(null);
let bridge: AppBridge | null = null;
let dataSent = false;
let sendDataImpl: (() => void) | null = null;

// Deep-clone store data into plain objects. Pinia state is wrapped in
// Vue reactive proxies, and postMessage's structured clone throws
// "could not be cloned" on proxies - that silently killed every data
// delivery to the app. The payloads are JSON-safe by construction.
function plain<T>(v: T): T {
  if (v === undefined || v === null) return v;
  return JSON.parse(JSON.stringify(v)) as T;
}

// Convert ACP tool-update content items into MCP content blocks.
function toMcpContent(raw: unknown[] | undefined): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  const out: Record<string, unknown>[] = [];
  for (const item of raw as Record<string, any>[]) {
    if (item?.type === 'content' && item.content && typeof item.content === 'object') {
      out.push(item.content as Record<string, unknown>);
    } else if (item?.type === 'resource_link' || item?.type === 'resource') {
      out.push(item);
    }
  }
  return out;
}

onMounted(async () => {
  const iframe = frameEl.value;
  if (!iframe) return;
  try {
    let html = props.html;
    if (!html) {
      const res = await store.mcpAppReadResource(props.sessionId, props.extensionName, props.resourceUri);
      html = res.text;
    }
    if (!html) throw new Error('Empty app HTML');

    const toolDef = await store
      .mcpAppToolDef(props.sessionId, props.extensionName, props.toolName)
      .catch(() => undefined);
    const isDark = document.documentElement.dataset.theme === 'dark';
    const hostContext = {
      theme: isDark ? 'dark' : 'light',
      displayMode: 'inline',
      containerDimensions: { maxHeight: 900 },
      ...(toolDef ? { toolInfo: { tool: toolDef } } : {}),
    } as unknown as McpUiHostContext;

    bridge = new AppBridge(
      null,
      { name: 'Goose Web Host', version: '1.0.0' },
      {
        openLinks: {},
        serverTools: {},
        serverResources: {},
        logging: {},
      },
      { hostContext },
    );

    bridge.oncalltool = async (params) =>
      (await store.mcpAppCallTool(
        props.sessionId,
        props.extensionName,
        params.name,
        (params.arguments || {}) as Record<string, unknown>,
      )) as any;
    bridge.onreadresource = async (params) => {
      const r = await store.mcpAppReadResource(props.sessionId, props.extensionName, params.uri);
      return { contents: [{ uri: r.uri, mimeType: r.mimeType ?? undefined, text: r.text }] } as any;
    };
    bridge.onopenlink = async (params) => {
      window.open(params.url, '_blank', 'noopener,noreferrer');
      return {};
    };
    bridge.onmessage = async (params) => {
      const blocks = (params as any)?.content as Record<string, any>[] | undefined;
      const text = Array.isArray(blocks)
        ? blocks.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('\n')
        : '';
      if (text) void store.sendPrompt(text).catch(() => undefined);
      return {};
    };
    bridge.onsizechange = (params) => {
      if (typeof params?.height === 'number' && params.height > 0) {
        const next = Math.min(900, Math.max(120, Math.ceil(params.height)));
        // Epsilon guard: the app reports its body height, which tracks
        // the iframe height - reacting to every report loops forever.
        if (Math.abs(next - frameHeight.value) > 8) frameHeight.value = next;
      }
    };
    const sendData = () => {
      if (!bridge || dataSent) return;
      dataSent = true;
      const toolInput = plain(props.toolInput || {});
      const result: Record<string, unknown> = {
        content: plain(toMcpContent(props.rawContent)),
        isError: false,
      };
      if (props.rawOutput && typeof props.rawOutput === 'object' && !Array.isArray(props.rawOutput)) {
        result.structuredContent = plain(props.rawOutput);
      }
      try {
        void bridge.sendToolInput({ arguments: toolInput });
        void bridge.sendToolResult(result as any);
      } catch {
        /* the direct delivery below covers a bridge failure */
      }
      const win = iframe.contentWindow;
      if (win) {
        try {
          win.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: toolInput } }, '*');
          win.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }, '*');
        } catch {
          /* app may have navigated away */
        }
      }
    };
    bridge.oninitialized = () => sendData();
    sendDataImpl = sendData;

    // Connect BEFORE loading the document so the app's ui/initialize
    // (posted as soon as it boots) is not lost; the iframe's
    // WindowProxy stays stable across the navigation.
    await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
    // Prefer a real URL (gateway-stored page, CSP-sandboxed opaque
    // origin) over srcdoc. Fall back to srcdoc if the upload fails or
    // is slow.
    let loadedViaUrl = false;
    try {
      const ctl = new AbortController();
      const killer = setTimeout(() => ctl.abort(), 2500);
      const resp = await fetch('/api/mcp-app-page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html }),
        signal: ctl.signal,
      });
      clearTimeout(killer);
      if (resp.ok) {
        const data = (await resp.json()) as { url?: string };
        if (data.url) {
          iframe.src = data.url;
          loadedViaUrl = true;
        }
      }
    } catch {
      /* fall through to srcdoc */
    }
    if (!loadedViaUrl) iframe.srcdoc = html;
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  }
});

// If the tool data only arrives after mount (history replay order),
// deliver it then.
watch(
  () => [props.toolInput, props.rawOutput] as const,
  ([ti, ro]) => {
    const hasData = (ti && Object.keys(ti).length > 0) || (ro && typeof ro === 'object');
    if (hasData && sendDataImpl) {
      dataSent = false;
      sendDataImpl();
    }
  },
);

onBeforeUnmount(() => {
  try {
    bridge?.close();
  } catch {
    /* ignore */
  }
  bridge = null;
});
</script>

<template>
  <div class="mcp-app-view">
    <div v-if="loadError" class="mcp-app-error">应用加载失败：{{ loadError }}</div>
    <iframe
      v-else
      ref="frameEl"
      class="mcp-app-frame"
      :style="{ height: frameHeight + 'px' }"
      sandbox="allow-scripts allow-forms"
      title="MCP App"
    />
  </div>
</template>

<style scoped>
.mcp-app-view {
  margin: 8px 0 4px;
}
.mcp-app-frame {
  width: 100%;
  border: 1px solid var(--border, #ddd);
  border-radius: 10px;
  background: transparent;
  display: block;
}
.mcp-app-error {
  font-size: 12px;
  opacity: 0.75;
  padding: 6px 2px;
}
</style>
