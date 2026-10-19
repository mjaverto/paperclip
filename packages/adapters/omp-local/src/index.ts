export const type = "omp_local";
export const label = "OMP";

export const SANDBOX_INSTALL_COMMAND = "npm install -g @oh-my-pi/pi-coding-agent@18.11.3";

export const models: Array<{ id: string; label: string }> = [];

export const agentConfigurationDoc = `# omp_local agent configuration

Adapter: omp_local

Use when:
- You want Paperclip to run OMP (Oh My Pi, https://omp.sh) locally as the agent runtime
- You want provider/model routing in OMP format (--provider <name> --model <id>; --model also accepts fuzzy ids)
- You want OMP session resume across heartbeats via --resume with a managed --session-dir
- You want OMP's tool set (read, bash, edit, write, grep, find, plus LSP-augmented tools)

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)
- The omp CLI is not installed on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file appended to system prompt via --append-system-prompt
- promptTemplate (string, optional): user prompt template passed as the positional prompt
- model (string, required): OMP model selector in provider/model format (for example anthropic/claude-opus-4-6). Discover with \`omp models --json\`
- thinking (string, optional): thinking level (off, minimal, low, medium, high, xhigh, max, auto)
- command (string, optional): defaults to "omp"
- env (object, optional): KEY=VALUE environment variables

OMP-specific fields:
- smolModel (string, optional): fast model for lightweight tasks, passed via --smol (provider/model selector)
- slowModel (string, optional): reasoning model for thorough analysis, passed via --slow
- planModel (string, optional): planning model, passed via --plan
- tools (string, optional): comma-separated tool allowlist passed via --tools (for example "read,bash,edit,write,grep,find"). Omit to enable all built-in tools.
- noLsp (boolean, optional): pass --no-lsp to disable LSP tools, formatting, and diagnostics
- noPty (boolean, optional): pass --no-pty to disable PTY-based interactive bash execution
- maxTimeSec (number, optional): stop the session after this duration, passed via --max-time

Advisor roster:
- Add a WATCHDOG.yml file next to the entry instructions file (in the same instructions
  bundle) to give this agent its own advisor roster: named reviewers with their own
  model, review mode (turn or agent-end), tool grants, and per-advisor prompts. OMP
  discovers the roster at <agent dir>/WATCHDOG.yml, and Paperclip stages the bundle's
  roster into the managed agent dir for each run, so different agents can run
  different advisors. The run overlay enables the advisor subsystem only when a
  roster was staged; agents without a roster keep advisors off and never start the
  operator's own advisor models.
- A roster is staged only when the run can authenticate without the host agent dir,
  which the staged dir replaces: set OMP_AUTH_BROKER_URL (recommended; shares existing
  OMP logins without copying them) or PAPERCLIP_OMP_PROVIDERS (declarative custom
  providers). With neither, the roster is not staged, advisors stay off, and the run
  surfaces a config-gap note. Host config and credentials are never copied.
- To reuse existing OMP subscription logins locally, run \`omp auth-broker serve\`
  on the Paperclip host (keep it running, for example as a systemd user service; runs
  cannot authenticate while it is down) and set \`OMP_AUTH_BROKER_URL=http://127.0.0.1:8765\`
  in the Paperclip server environment or the agent's env. OMP reads the broker token
  from its normal config root; no separate provider API keys are needed.
- For example, use \`anthropic/claude-sonnet-5-5\` as the primary model, with
  \`anthropic/claude-opus-5-5:max\` and \`openai-codex/gpt-6.1-sol\` in WATCHDOG.yml.
  The Codex provider uses the existing ChatGPT/Codex login; \`openai/...\` requires
  an OpenAI API key instead.
- Remote execution targets need a reachable broker URL and an explicitly supplied
  OMP_AUTH_BROKER_TOKEN, or their own provider credentials. Host logins are never
  copied into remote assets, and a loopback broker URL is local-host only.

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
- stdoutLogMode (string, optional, default "compact"): controls how OMP --mode json stdout is
  compacted before entering the Paperclip run log. OMP emits cumulative state
  in every message_update event, which makes run logs grow ~quadratically.
  Modes:
  - "raw": legacy passthrough, no filtering (full transcript; large logs).
  - "compact" (default): strips cumulative copies (message_update.message,
    assistantMessageEvent.partial), converts tool_execution_update to a
    throttled content-free Paperclip progress event, and drops content-free
    advisor_* events. Streaming deltas are preserved — parseOmpJsonl output
    and live UI typing are unchanged.
  In compact mode, if a run is terminated before tool_execution_end, its
  partial tool output is not retained; use "raw" when full forensic output is required.
  Oversized individual lines are handled by the server's run-log pipeline
  (redaction + head/tail cap) regardless of mode. Invalid explicit mode values
  fail safe to "raw" rather than enabling a lossy transformation.

Notes:
- OMP supports many providers and models. Use \`omp models --json\` to list available options.
- Paperclip requires an explicit \`model\` value for \`omp_local\` agents.
- Sessions are stored under ~/.omp/paperclip/sessions/<agentId>/ and resumed with --resume.
- All built-in tools are enabled by default; restrict them with the \`tools\` field.
- Agent instructions are appended to OMP's system prompt via --append-system-prompt, while the user task is sent as the positional prompt.
- Headless runs pass --approval-mode yolo explicitly so a host-side always-ask approval setting cannot block non-interactive execution.
- Custom/OpenAI-compatible endpoints are supported via PAPERCLIP_OMP_PROVIDERS (same providers JSON shape as pi, materialized into a managed models.yml pointed at by PI_CODING_AGENT_DIR, which OMP honors).
- A WATCHDOG.yml sibling of the entry instructions file is the per-agent advisor
  roster (see "Advisor roster" above); reviewers run with the agent each heartbeat
  using the configured broker or provider credentials.
`;
