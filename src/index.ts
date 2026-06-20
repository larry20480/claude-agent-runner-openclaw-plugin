/**
 * OpenClaw plugin: claude_agent_delegate.
 *
 * Spawns the local `claude` CLI in `-p --output-format=stream-json` mode and
 * pipes each NDJSON event to the OpenClaw logger + a per-run transcript file.
 * One Claude session is kept alive per OpenClaw `sessionKey`: the first
 * delegate spawns a new session and records its id; later delegates from the
 * same conversation resume via `--resume`.
 */
import { spawn } from "node:child_process";
import { mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  definePluginEntry,
  jsonResult,
  textResult,
  type AgentTool,
  type AgentToolResult,
  type OpenClawPluginApi,
  type OpenClawPluginToolContext,
  type PluginLogger,
} from "./define-plugin-entry.js";

interface PluginConfig {
  claudeBin: string;
  transcriptDir: string;
  extraArgs: string[];
}

const DEFAULT_TRANSCRIPT_DIR = join(homedir(), ".openclaw", "logs", "claude-agent-runner");

function resolveConfig(raw: Record<string, unknown> | undefined): PluginConfig {
  const r = raw ?? {};
  return {
    claudeBin: typeof r.claudeBin === "string" && r.claudeBin.trim() ? r.claudeBin : "claude",
    transcriptDir:
      typeof r.transcriptDir === "string" && r.transcriptDir.trim()
        ? r.transcriptDir
        : DEFAULT_TRANSCRIPT_DIR,
    extraArgs: Array.isArray(r.extraArgs) ? r.extraArgs.filter((x): x is string => typeof x === "string") : [],
  };
}

interface DelegateParams {
  task: string;
  /** false → force a fresh Claude session even if a prior one exists for this conversation. */
  continue?: boolean;
  /** Override model id (passed to `claude --model`). */
  model?: string;
}

function readParams(raw: unknown): DelegateParams {
  if (!raw || typeof raw !== "object") throw new Error("missing tool parameters");
  const r = raw as Record<string, unknown>;
  const task = typeof r.task === "string" ? r.task.trim() : "";
  if (!task) throw new Error("`task` is required and must be a non-empty string");
  return {
    task,
    ...(typeof r.continue === "boolean" ? { continue: r.continue } : {}),
    ...(typeof r.model === "string" && r.model.trim() ? { model: r.model } : {}),
  };
}

interface RunOutcome {
  claudeSessionId: string | null;
  finalText: string;
  exitCode: number | null;
  eventCount: number;
  numTurns: number | null;
  durationMs: number | null;
  totalCostUsd: number | null;
  errorMessage: string | null;
  transcriptPath: string;
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: Array<{ type: string; text?: string }> };
  result?: string;
  is_error?: boolean;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  [k: string]: unknown;
}

class NdjsonBuffer {
  private buf = "";
  consume(chunk: Buffer, onLine: (line: string) => void): void {
    this.buf += chunk.toString("utf8");
    let i: number;
    while ((i = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      const trimmed = line.trim();
      if (trimmed) onLine(trimmed);
    }
  }
  flush(onLine: (line: string) => void): void {
    const t = this.buf.trim();
    if (t) onLine(t);
    this.buf = "";
  }
}

interface RunSpec {
  task: string;
  cwd: string;
  resumeFrom: string | null;
  forcedSessionId: string | null;
  modelOverride?: string;
  config: PluginConfig;
  logger: PluginLogger;
  ctxLabel: string;
}

function runClaude(spec: RunSpec): Promise<RunOutcome> {
  const transcriptPath = join(spec.config.transcriptDir, `${Date.now()}-${randomUUID()}.jsonl`);
  mkdirSync(spec.config.transcriptDir, { recursive: true });
  const transcript = createWriteStream(transcriptPath, { flags: "w" });

  const args: string[] = [
    "-p",
    "--output-format=stream-json",
    "--verbose",
    "--add-dir",
    spec.cwd,
  ];
  if (spec.resumeFrom) {
    args.push("--resume", spec.resumeFrom);
  } else if (spec.forcedSessionId) {
    args.push("--session-id", spec.forcedSessionId);
  }
  if (spec.modelOverride) args.push("--model", spec.modelOverride);
  args.push(...spec.config.extraArgs);
  // Task is the trailing positional prompt.
  args.push(spec.task);

  spec.logger.info?.("claude-agent-runner: spawn", {
    ctx: spec.ctxLabel,
    bin: spec.config.claudeBin,
    cwd: spec.cwd,
    resume: spec.resumeFrom ?? null,
    sessionId: spec.forcedSessionId ?? null,
    transcript: transcriptPath,
  });

  const child = spawn(spec.config.claudeBin, args, {
    cwd: spec.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // stdio[1]/[2] are "pipe" so these are non-null Readable streams.
  const stdout = child.stdout!;
  const stderr = child.stderr!;

  return new Promise<RunOutcome>((resolve) => {
    const outcome: RunOutcome = {
      claudeSessionId: spec.resumeFrom ?? spec.forcedSessionId ?? null,
      finalText: "",
      exitCode: null,
      eventCount: 0,
      numTurns: null,
      durationMs: null,
      totalCostUsd: null,
      errorMessage: null,
      transcriptPath,
    };
    const stdoutBuf = new NdjsonBuffer();
    const stderrChunks: string[] = [];

    const handleEvent = (event: StreamEvent, raw: string): void => {
      transcript.write(raw + "\n");
      outcome.eventCount += 1;
      if (typeof event.session_id === "string" && event.session_id) {
        outcome.claudeSessionId = event.session_id;
      }
      // Surface high-signal events to the OpenClaw logger.
      switch (event.type) {
        case "system":
          spec.logger.info?.(`claude-agent-runner: system.${event.subtype ?? "?"}`, {
            ctx: spec.ctxLabel,
            session_id: event.session_id ?? null,
          });
          break;
        case "assistant": {
          const blocks = event.message?.content ?? [];
          const toolNames = blocks
            .filter((b) => b.type === "tool_use")
            .map((b) => (b as { name?: string }).name ?? "?");
          spec.logger.info?.("claude-agent-runner: assistant", {
            ctx: spec.ctxLabel,
            blocks: blocks.length,
            tools: toolNames,
          });
          break;
        }
        case "user":
          spec.logger.debug?.("claude-agent-runner: tool_result", { ctx: spec.ctxLabel });
          break;
        case "result":
          if (typeof event.result === "string") outcome.finalText = event.result;
          if (typeof event.num_turns === "number") outcome.numTurns = event.num_turns;
          if (typeof event.duration_ms === "number") outcome.durationMs = event.duration_ms;
          if (typeof event.total_cost_usd === "number") outcome.totalCostUsd = event.total_cost_usd;
          if (event.is_error) outcome.errorMessage = event.result ?? "claude reported is_error";
          spec.logger.info?.("claude-agent-runner: result", {
            ctx: spec.ctxLabel,
            subtype: event.subtype ?? null,
            num_turns: outcome.numTurns,
            duration_ms: outcome.durationMs,
            total_cost_usd: outcome.totalCostUsd,
            is_error: event.is_error ?? false,
          });
          break;
        default:
          break;
      }
    };

    stdout.on("data", (chunk: Buffer) => {
      stdoutBuf.consume(chunk, (line) => {
        let parsed: StreamEvent;
        try {
          parsed = JSON.parse(line) as StreamEvent;
        } catch {
          spec.logger.warn?.("claude-agent-runner: non-JSON stdout line", {
            ctx: spec.ctxLabel,
            sample: line.slice(0, 200),
          });
          transcript.write(line + "\n");
          return;
        }
        handleEvent(parsed, line);
      });
    });

    stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrChunks.push(text);
      // Don't spam at info; debug only.
      spec.logger.debug?.("claude-agent-runner: stderr", {
        ctx: spec.ctxLabel,
        sample: text.slice(0, 400),
      });
    });

    const finalize = (code: number | null): void => {
      stdoutBuf.flush((line) => {
        try {
          handleEvent(JSON.parse(line) as StreamEvent, line);
        } catch {
          transcript.write(line + "\n");
        }
      });
      transcript.end();
      outcome.exitCode = code;
      if (code !== 0 && !outcome.errorMessage) {
        const stderr = stderrChunks.join("").slice(-2000);
        outcome.errorMessage = `claude exited with code ${code}${stderr ? `; stderr tail: ${stderr}` : ""}`;
      }
      resolve(outcome);
    };

    child.on("error", (err) => {
      spec.logger.error?.("claude-agent-runner: spawn error", {
        ctx: spec.ctxLabel,
        error: String(err),
      });
      outcome.errorMessage = `failed to spawn ${spec.config.claudeBin}: ${err.message}`;
      finalize(null);
    });

    child.on("close", finalize);
  });
}

function buildToolFactory(api: OpenClawPluginApi, config: PluginConfig) {
  const claudeSessionByOpenClawKey = new Map<string, string>();

  return (ctx: OpenClawPluginToolContext): AgentTool => {
    const ctxLabel =
      ctx.sessionKey ?? ctx.sessionId ?? ctx.agentId ?? "anon";

    const tool: AgentTool = {
      name: "claude_agent_delegate",
      label: "Claude Agent Delegate",
      description:
        "Delegate a focused sub-task to a separate Claude Code session running " +
        "in the same workspace. Use when the current turn would benefit from an " +
        "isolated agent with its own tool budget and context (e.g. multi-file " +
        "refactor, focused investigation, long-running edit). The Claude session " +
        "is tied to the current OpenClaw conversation: subsequent delegations " +
        "from the same conversation resume the same Claude session unless " +
        "`continue=false` is passed.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["task"],
        properties: {
          task: {
            type: "string",
            description:
              "The concrete sub-task for the Claude sub-agent. Write it as you " +
              "would prompt Claude Code directly — be specific about files / goals.",
          },
          continue: {
            type: "boolean",
            description:
              "Defaults to true: continue the previous Claude session for this " +
              "OpenClaw conversation. Set false to force a fresh sub-agent " +
              "session.",
          },
          model: {
            type: "string",
            description:
              "Optional model id override forwarded to `claude --model`.",
          },
        },
      },
      execute: async (_toolCallId, raw): Promise<AgentToolResult> => {
        let params: DelegateParams;
        try {
          params = readParams(raw);
        } catch (err) {
          return textResult(
            `invalid claude_agent_delegate params: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        const cwd = ctx.workspaceDir ?? process.cwd();
        const key = ctxLabel;
        const prior = claudeSessionByOpenClawKey.get(key);
        const resumeFrom = params.continue === false ? null : prior ?? null;
        const forcedSessionId = resumeFrom ? null : randomUUID();

        const spec: RunSpec = {
          task: params.task,
          cwd,
          resumeFrom,
          forcedSessionId,
          ...(params.model ? { modelOverride: params.model } : {}),
          config,
          logger: api.logger,
          ctxLabel,
        };

        const outcome = await runClaude(spec);
        if (outcome.claudeSessionId) {
          claudeSessionByOpenClawKey.set(key, outcome.claudeSessionId);
        }

        const summary =
          outcome.errorMessage !== null
            ? `claude-agent-runner: failed (${outcome.errorMessage})`
            : `claude-agent-runner: ok (${outcome.numTurns ?? 0} turns, ${
                outcome.eventCount
              } events, $${outcome.totalCostUsd ?? 0})`;

        return jsonResult({
          summary,
          reply: outcome.finalText,
          claudeSessionId: outcome.claudeSessionId,
          resumedExisting: resumeFrom !== null,
          openclawSessionKey: key,
          cwd,
          transcriptPath: outcome.transcriptPath,
          usage: {
            numTurns: outcome.numTurns,
            durationMs: outcome.durationMs,
            totalCostUsd: outcome.totalCostUsd,
            eventCount: outcome.eventCount,
          },
          error: outcome.errorMessage,
        });
      },
    };
    return tool;
  };
}

export default definePluginEntry({
  id: "claude-agent-runner",
  name: "Claude Agent Runner",
  description:
    "Delegate focused sub-tasks to a Claude Code sub-process. One Claude " +
    "session per OpenClaw conversation; transcripts stream to disk.",
  register(api) {
    const config = resolveConfig(api.pluginConfig);
    api.lifecycle.registerRuntimeLifecycle({
      id: "claude-agent-runner",
      description: "Claude Agent Runner has no long-lived resources to release.",
      cleanup: () => {},
    });
    api.registerTool(buildToolFactory(api, config));
  },
});
