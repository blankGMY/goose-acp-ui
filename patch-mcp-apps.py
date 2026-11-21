#!/usr/bin/env python3
"""Patch acp-ui for MCP App (ext-apps) hosting:
- types.ts: McpAppInfo + ToolCallInfo raw/mcpApp fields
- acp-bridge.ts: generic extRequest()
- session.ts: capture rawInput/rawContent/rawOutput/_meta.goose.mcpApp;
  add mcpAppReadResource/mcpAppCallTool/mcpAppToolDef store helpers
- ChatView.vue: render <McpAppView> under completed app tool calls
All files are CRLF; normalize, patch on unique anchors, restore CRLF.
"""
import sys

ROOT = "/home/hatch/workspace/acp-ui-build"


def patch(rel, pairs):
    path = f"{ROOT}/{rel}"
    data = open(path, "rb").read().decode("utf-8").replace("\r\n", "\n")
    for old, new in pairs:
        n = data.count(old)
        if n != 1:
            print(f"FAIL {rel}: anchor count {n} for {old[:70]!r}")
            sys.exit(1)
        data = data.replace(old, new)
    open(path, "wb").write(data.replace("\n", "\r\n").encode("utf-8"))
    print(f"OK {rel}: {len(pairs)} edits")


patch("src/lib/types.ts", [
    ("""  /** Content the tool produced: text output, file diffs, terminal refs. */
  content?: ToolCallContentItem[];
}""",
     """  /** Content the tool produced: text output, file diffs, terminal refs. */
  content?: ToolCallContentItem[];
  /** Raw arguments the agent passed to the tool (ACP rawInput). */
  rawInput?: Record<string, unknown>;
  /** Raw ACP content items of the latest tool update (unmapped). */
  rawContent?: unknown[];
  /** Raw structured output of the tool (ACP rawOutput), when present. */
  rawOutput?: unknown;
  /** MCP App attached to this tool call (from _meta.goose.mcpApp). */
  mcpApp?: McpAppInfo;
}

/** An MCP App (ext-apps UI) attached to a tool call. */
export interface McpAppInfo {
  resourceUri: string;
  extensionName: string;
  toolName: string;
  /** App HTML inlined in the tool update (resourceResult), when present. */
  html?: string;
}"""),
])

patch("src/lib/acp-bridge.ts", [
    ("""  async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {""",
     """  /**
   * Send an extension (non-standard) JSON-RPC request to the agent,
   * e.g. Goose's `_goose/unstable/*` methods used for MCP Apps.
   */
  async extRequest<T>(method: string, params?: unknown): Promise<T> {
    return this.sendRequest<T>(method, params);
  }

  async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {"""),
])

patch("src/stores/session.ts", [
    ("""import type { SavedSession, ChatMessage, ToolCallInfo, ToolCallContentItem, PermissionRequest, SessionMode, SlashCommand, ModelInfo, AgentConfig } from '../lib/types';""",
     """import type { SavedSession, ChatMessage, ToolCallInfo, ToolCallContentItem, McpAppInfo, PermissionRequest, SessionMode, SlashCommand, ModelInfo, AgentConfig } from '../lib/types';"""),

    ("""  // Connection cancellation
  let connectionAborted = false;""",
     """  // Extract MCP App metadata from a raw session update's _meta
  // (_meta.goose.mcpApp), including the app HTML when the server
  // embeds the resource result in the update itself.
  function extractMcpApp(update: unknown): McpAppInfo | undefined {
    const meta = (update as Record<string, any>)?._meta?.goose?.mcpApp as Record<string, any> | undefined;
    if (!meta || typeof meta.resourceUri !== 'string') return undefined;
    let html: string | undefined;
    const contents = meta.resourceResult?.contents as Record<string, any>[] | undefined;
    if (Array.isArray(contents)) {
      const first = contents.find(c => typeof c?.text === 'string');
      if (first) html = first.text as string;
    }
    return {
      resourceUri: meta.resourceUri,
      extensionName: typeof meta.extensionName === 'string' ? meta.extensionName : '',
      toolName: typeof meta.toolName === 'string' ? meta.toolName : '',
      html,
    };
  }

  // Connection cancellation
  let connectionAborted = false;"""),

    ("""          currentAssistantMsg.toolCalls.push({
            toolCallId: update.toolCallId,
            title: update.title,
            kind: update.kind || 'other',
            status: update.status || 'pending',
            locations: update.locations,
            content: mapToolContent(update.content),
          });""",
     """          currentAssistantMsg.toolCalls.push({
            toolCallId: update.toolCallId,
            title: update.title,
            kind: update.kind || 'other',
            status: update.status || 'pending',
            locations: update.locations,
            content: mapToolContent(update.content),
            rawInput: (update as any).rawInput as Record<string, unknown> | undefined,
            mcpApp: extractMcpApp(update),
          });"""),

    ("""        toolCalls.value.set(update.toolCallId, {
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind || 'other',
          status: update.status || 'pending',
          locations: update.locations,
          content: mapToolContent(update.content),
        });""",
     """        toolCalls.value.set(update.toolCallId, {
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind || 'other',
          status: update.status || 'pending',
          locations: update.locations,
          content: mapToolContent(update.content),
          rawInput: (update as any).rawInput as Record<string, unknown> | undefined,
          mcpApp: extractMcpApp(update),
        });"""),

    ("""          if (update.content?.length) existing.content = mapToolContent(update.content);
          // Also update in the message's toolCalls array""",
     """          if (update.content?.length) existing.content = mapToolContent(update.content);
          if (Array.isArray((update as any).content)) existing.rawContent = (update as any).content as unknown[];
          if ((update as any).rawOutput !== undefined) existing.rawOutput = (update as any).rawOutput;
          const appMeta = extractMcpApp(update);
          if (appMeta) existing.mcpApp = appMeta;
          // Also update in the message's toolCalls array"""),

    ("""                if (update.content?.length) tc.content = mapToolContent(update.content);
              }""",
     """                if (update.content?.length) tc.content = mapToolContent(update.content);
                if (Array.isArray((update as any).content)) tc.rawContent = (update as any).content as unknown[];
                if ((update as any).rawOutput !== undefined) tc.rawOutput = (update as any).rawOutput;
                if (appMeta) tc.mcpApp = appMeta;
              }"""),

    ("""  async function sendPrompt(""",
     """  // ---- MCP Apps (ext-apps) host support -------------------------------
  // App HTML and app-initiated tool calls ride the same ACP connection
  // via Goose's `_goose/unstable/*` extension methods; no extra channel.
  const toolDefCache = new Map<string, { name: string; description?: string; inputSchema?: unknown }>();

  async function mcpAppReadResource(sessionId: string, extensionName: string, uri: string): Promise<{ uri: string; mimeType: string | null; text: string }> {
    if (!acpClient) throw new Error('Not connected');
    const resp = await acpClient.extRequest<{ result?: { contents?: Record<string, any>[] } }>(
      '_goose/unstable/resources/read', { sessionId, extensionName, uri });
    const contents = resp?.result?.contents || [];
    const first = contents.find(c => typeof c?.text === 'string') || contents[0];
    if (!first) throw new Error(`Resource '${uri}' returned no contents`);
    let text = typeof first.text === 'string' ? first.text : '';
    if (!text && typeof first.blob === 'string') {
      const bin = atob(first.blob);
      const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0));
      text = new TextDecoder().decode(bytes);
    }
    return { uri: typeof first.uri === 'string' ? first.uri : uri, mimeType: (first.mimeType as string) ?? null, text };
  }

  async function mcpAppCallTool(sessionId: string, extensionName: string, name: string, args: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
    if (!acpClient) throw new Error('Not connected');
    const resp = await acpClient.extRequest<Record<string, any>>(
      '_goose/unstable/tools/call',
      { sessionId, extensionName, name: `${extensionName}__${name}`, arguments: args || {} });
    return {
      content: Array.isArray(resp?.content) ? resp.content : [],
      isError: !!resp?.isError,
      ...(resp?.structuredContent !== undefined ? { structuredContent: resp.structuredContent } : {}),
      ...(resp?._meta !== undefined ? { _meta: resp._meta } : {}),
    };
  }

  async function mcpAppToolDef(sessionId: string, extensionName: string, toolName: string): Promise<{ name: string; description?: string; inputSchema?: unknown } | undefined> {
    const key = `${sessionId}:${extensionName}__${toolName}`;
    const cached = toolDefCache.get(key);
    if (cached) return cached;
    if (!acpClient) return undefined;
    const resp = await acpClient.extRequest<{ tools?: Record<string, any>[] }>(
      '_goose/unstable/tools/list', { sessionId });
    const full = `${extensionName}__${toolName}`;
    const found = (resp?.tools || []).find(t => t?.name === full);
    if (!found) return undefined;
    const def = { name: toolName, description: found.description as string | undefined, inputSchema: found.inputSchema };
    toolDefCache.set(key, def);
    return def;
  }

  async function sendPrompt("""),

    ("""    resumeSession,
    sendPrompt,
""",
     """    resumeSession,
    sendPrompt,
    mcpAppReadResource,
    mcpAppCallTool,
    mcpAppToolDef,
"""),
])

patch("src/components/ChatView.vue", [
    ("""import Icon from './Icon.vue';""",
     """import Icon from './Icon.vue';
import McpAppView from './McpAppView.vue';"""),

    ("""              <div v-else-if="item.kind === 'terminal'" class="tool-terminal">Terminal {{ item.terminalId }}</div>
            </template>
          </div>
          </template>""",
     """              <div v-else-if="item.kind === 'terminal'" class="tool-terminal">Terminal {{ item.terminalId }}</div>
            </template>
          </div>
          <McpAppView
            v-if="tc.mcpApp && tc.status === 'completed'"
            :session-id="sessionStore.currentSession?.sessionId || ''"
            :extension-name="tc.mcpApp.extensionName"
            :tool-name="tc.mcpApp.toolName"
            :resource-uri="tc.mcpApp.resourceUri"
            :html="tc.mcpApp.html"
            :tool-input="tc.rawInput"
            :raw-content="tc.rawContent"
            :raw-output="tc.rawOutput"
          />
          </template>"""),
])

print("ALL PATCHES APPLIED")
