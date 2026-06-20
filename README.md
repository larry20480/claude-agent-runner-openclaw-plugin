# claude-agent-runner-openclaw-plugin

OpenClaw plugin that exposes a single tool — `claude_agent_delegate` — which
spawns a local `claude -p` (Claude Code CLI) sub-process and feeds its
NDJSON event stream into the OpenClaw logger plus a per-run transcript file.

One Claude session is kept per OpenClaw conversation (`sessionKey`): the first
delegate spawns a new session with `--session-id <uuid>`; subsequent
delegations from the same OpenClaw conversation continue with `--resume`.

The Claude sub-process runs with `cwd = OpenClawPluginToolContext.workspaceDir`
and is granted access to that directory via `--add-dir`, so it picks up the
project's `CLAUDE.md`, git state, and skills automatically.

## Install (local development)

```sh
cd /Users/larry/Documents/code/claude-agent-runner-openclaw-plugin
npm install
npm run build
openclaw plugins install -l .          # symlink mode; edits visible after openclaw restart
```

## Config

`openclaw.json` → `plugins.entries["claude-agent-runner"]`:

| Key             | Type       | Default                                                 | Notes                                  |
| --------------- | ---------- | ------------------------------------------------------- | -------------------------------------- |
| `claudeBin`     | `string`   | `claude`                                                | Override path / name of the binary.    |
| `transcriptDir` | `string`   | `~/.openclaw/logs/claude-agent-runner`                  | Per-run NDJSON transcripts.            |
| `extraArgs`     | `string[]` | `[]`                                                    | Appended to every `claude -p` call.    |

Auth, base URL, and model defaults are inherited from the OpenClaw process
environment (`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` /
`ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL`).

## Tool

`claude_agent_delegate({ task, continue?, model? })` — returns a JSON tool
result containing `reply`, `claudeSessionId`, `transcriptPath`, and usage.

- `task` (required) — concrete prompt for the Claude sub-agent.
- `continue` (default `true`) — set `false` to force a fresh sub-session.
- `model` — optional model override forwarded to `claude --model`.

## Notes

- The plugin holds `sessionKey → claudeSessionId` in memory only; it does not
  survive an OpenClaw restart. Re-spawn happens transparently — context just
  starts fresh.
- The SDK shim (`src/define-plugin-entry.ts`) mirrors the runtime shape of
  `definePluginEntry` from `@openclaw/plugin-sdk`, which is workspace-only and
  cannot be depended on as a normal npm package.
