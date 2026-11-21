# Cude IDE 0.1.0

Cude IDE is a Windows x64 portable development environment branded and configured for Cude Studio, with Cude AI preinstalled. Its 0.1.0 runtime is derived from a pinned VSCodium/Code-OSS distribution; it does not yet build from a Cude-maintained source fork.

## Build and run

From PowerShell at the repository root:

```powershell
.\build\build.ps1
```

The reproducible build pins and SHA-256 verifies its upstream archive and `rcedit`, compiles/tests/packages Cude AI, applies Cude branding, and creates `dist\Cude-IDE-0.1.0-win32-x64.zip`. `TEMP`, `TMP`, npm cache, downloaded files, and build outputs are directed to E:. Node.js 22+ is required.

Extract the portable archive and run `Cude IDE.cmd`. The portable profile starts directly in the Cude AI workspace, with Cude Dark, Cude Icons, the branded application icon, and the upstream welcome surface suppressed. The central Cude AI editor includes chat, Agent and Spec modes, project context, model settings, and **Clone & make it yours**. Configure a model from the Cude AI settings button or **Cude AI: Configure Provider**. Provider keys are held in OS-backed secret storage.

## Cude-owned release policy

The application does not check or download product updates. Product update feeds are blank, built-in extension auto-updates are disabled, and the portable profile disables update checks and automatic extension updates. Cude Studio controls when a new package is built and distributed. This 0.1.0 package has no Cude update service; future updating must use a Cude-owned, signed release channel and explicit rollout policy.

The product identity, logo, icon, theme, settings, Cude AI surface, packaging, and release decisions belong to Cude Studio. The current binary still contains the pinned VSCodium/Code-OSS runtime. MIT license and third-party notices remain in the package as required.

The intended single-core architecture is a Cude-maintained Code-OSS fork. VSCodium compatibility/build hardening should be selectively reviewed and merged into that core, rather than shipping two competing runtimes. That source-fork/build pipeline is not complete in 0.1.0; `build.ps1` currently repackages a pinned VSCodium build.

## Local assistant tools

The Cude AI workspace and Command Palette offer **Cude AI: Detect Codex and Claude Code**. It checks for `codex` and `claude` on PATH and known desktop install locations, then can launch the detected CLI in a Cude integrated terminal or open a detected desktop app. CLI products use their own installations, authentication, and terms; Cude does not proxy their accounts. Detection is best-effort and does not install either tool.

## Cude AI in 0.1.0

- Provider gateway options for OpenAI-compatible endpoints, OpenAI, Anthropic, Gemini, NVIDIA NIM, OpenRouter, and Ollama.
- Main-editor AI conversation with bounded project context, Agent and Spec modes, and selected-code edit proposals reviewed in a diff before approval.
- **Clone & make it yours** accepts public GitHub HTTPS repositories, records origin/license notes, and opens the project under Workspace Trust. It does not run repository scripts or fetch submodules.
- Spec generation into `.cude/specs/`, project memory in `.cude/memory.md`, a basic agent task/status panel, approved terminal command launch, and MCP server inspection from `.cude/mcp.json`.
- Local Codex CLI / Claude Code discovery and launch.

## Security and free AI options

0.1.0 blocks provider requests, MCP, project writes, and terminal commands in untrusted workspaces. Provider settings are app-scoped and API keys are isolated in OS-backed SecretStorage. See [SECURITY.md](SECURITY.md) for the threat model.

The user-funded plan is local Ollama + BYOK now, with an opt-in Puter User-Pays adapter planned after desktop OAuth/origin review. Puter documents a monthly free allowance, not unlimited free usage. A shared Cude key pool is deferred until a cloud partner and protected backend exist; no shared API key ships in the client.

## Known limits and next milestones

0.1.0 is an early foundation, not feature parity with Cursor, Claude Code, or Codex. Its agent stores model-produced plans but does not autonomously orchestrate multi-step file edits; parallel agent execution is not implemented. Spec tasks produce proposals and require manual application. MCP currently inspects configured tools and does not execute tool calls. Automatic provider failover is not implemented. Real model workflows require user-provided credentials or a running local model and were not end-to-end verified in this delivery. The portable packaging target is Windows x64; macOS and Linux release pipelines remain future work.

Recommended sequence: (1) establish the Cude-owned Code-OSS source fork and upstream review/merge gates; (2) build signed reproducible Windows/macOS/Linux releases and Cude-only update distribution; (3) add a permissioned file/terminal tool runtime and real agent orchestration; (4) finish MCP tool execution and provider failover; (5) add broad integration/e2e tests and benchmark reliability before claiming competitor parity.

See [RAPOR_0.1.0.md](RAPOR_0.1.0.md) for packaging and verification details.
