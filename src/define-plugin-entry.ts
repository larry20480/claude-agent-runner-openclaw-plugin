/**
 * Minimal local shim of `@openclaw/plugin-sdk`.
 *
 * The real SDK is a workspace-only package not published to npm — so we cannot
 * depend on it. The runtime `definePluginEntry` is structurally an identity
 * function with a lazy `configSchema` getter; we mirror that here, plus the
 * minimum types we touch from `OpenClawPluginToolContext` / `AnyAgentTool`.
 *
 * If the OpenClaw plugin loader rejects this shape later, replace this file
 * with a real import from the SDK once it becomes consumable.
 */

export type JsonSchema = Record<string, unknown>;

export interface PluginLogger {
  debug?(msg: string, meta?: Record<string, unknown>): void;
  info?(msg: string, meta?: Record<string, unknown>): void;
  warn?(msg: string, meta?: Record<string, unknown>): void;
  error?(msg: string, meta?: Record<string, unknown>): void;
}

export interface PluginRuntimeLifecycleRegistration {
  id: string;
  description?: string;
  cleanup: () => void | Promise<void>;
}

export interface OpenClawPluginToolContext {
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  resolveApiKeyForProvider?: (providerId: string) => Promise<string | undefined>;
}

/**
 * Tool result shape mirrored from the bundled common helpers' `textResult` /
 * `jsonResult` — that is what `api.registerTool` expects to receive back.
 */
export interface AgentToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
}

export function textResult(text: string, details?: unknown): AgentToolResult {
  return { content: [{ type: "text", text }], details };
}

export function jsonResult(payload: unknown): AgentToolResult {
  return textResult(JSON.stringify(payload, null, 2), payload);
}

export interface AgentTool {
  name: string;
  label?: string;
  description: string;
  parameters: JsonSchema;
  execute: (
    toolCallId: string,
    rawParams: unknown,
  ) => Promise<AgentToolResult> | AgentToolResult;
}

export type OpenClawPluginToolFactory = (
  ctx: OpenClawPluginToolContext,
) => AgentTool | AgentTool[] | null | undefined;

export interface OpenClawPluginApi {
  logger: PluginLogger;
  /** Raw plugin config (`openclaw.json` `plugins.entries.<id>` block). */
  pluginConfig?: Record<string, unknown>;
  lifecycle: {
    registerRuntimeLifecycle: (reg: PluginRuntimeLifecycleRegistration) => void;
  };
  registerTool: (
    tool: AgentTool | OpenClawPluginToolFactory,
    opts?: Record<string, unknown>,
  ) => void;
  // Forward-compat: any extra plugin api surface accessed dynamically.
  [extra: string]: unknown;
}

export interface PluginConfigSchemaSpec {
  // Loose JSON-Schema-ish container. The real SDK accepts typebox / json.
  type: "object";
  additionalProperties?: boolean;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  [k: string]: unknown;
}

export interface PluginEntry {
  id: string;
  name?: string;
  description?: string;
  kind?: string;
  configSchema: { readonly schema: PluginConfigSchemaSpec };
  register: (api: OpenClawPluginApi) => void | Promise<void>;
}

export interface PluginEntryInput {
  id: string;
  name?: string;
  description?: string;
  kind?: string;
  configSchema?: PluginConfigSchemaSpec;
  register: (api: OpenClawPluginApi) => void | Promise<void>;
}

const EMPTY_CONFIG_SCHEMA: PluginConfigSchemaSpec = {
  type: "object",
  additionalProperties: false,
  properties: {},
};

/**
 * Identity-style wrapper matching the runtime contract observed in bundled
 * extensions under `dist/extensions/<id>/index.js`. `configSchema` is exposed
 * via a lazy getter — the real SDK uses a cached lazy resolver; cheap to mimic.
 */
export function definePluginEntry(input: PluginEntryInput): PluginEntry {
  const schema = input.configSchema ?? EMPTY_CONFIG_SCHEMA;
  return {
    id: input.id,
    ...(input.name ? { name: input.name } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    get configSchema() {
      return { schema };
    },
    register: input.register,
  };
}
