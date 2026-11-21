# Cude IDE security model (0.1.0)

## Guarantee boundary

No desktop IDE can promise that no person, AI model, extension, operating-system exploit, or supply-chain compromise can ever break it. Cude 0.1.0 is an early, branded Code-OSS/VSCodium-derived distribution, not a hardened OS sandbox. Treat security as layered risk reduction, disclose what code leaves the machine, and keep dangerous operations opt-in.

## 0.1.0 protections

- Workspace Trust is enabled. New folders are prompted and opened restricted until trusted; empty windows are untrusted by default. Cude AI is enabled in untrusted workspaces only for safe UI features; all model, project-write, MCP, and terminal paths are guarded in code.
- Cude blocks provider requests, project writes, MCP connections, and terminal launches until the current window is trusted. This is an extension-level guard, not a sandbox against a malicious extension or a compromised runtime.
- Provider, model, endpoint, timeout and API credentials are application/user-scoped, never read from workspace settings. Credentials are separated by provider in OS-backed SecretStorage.
- Provider endpoints must use HTTPS, except HTTP loopback for local Ollama. URLs with embedded credentials, query strings or fragments are rejected. Gemini keys use `x-goog-api-key`, not a URL query.
- Proposed edits are reviewed in a diff; application needs explicit confirmation. Terminal commands and stdio MCP launch require explicit confirmation. AI-generated instructions are untrusted input and are never permission.
- Product and extension automatic updates are disabled in 0.1.0. Cude Studio must build and distribute each release. The current build still downloads a pinned upstream base at build time; that is not a runtime update channel.

## AI usage modes and data flow

1. **Local model (Ollama):** preferred for private work when the user's machine can run a suitable model. Requests stay on loopback unless the user changes the product code; custom plain HTTP endpoints are blocked.
2. **BYOK:** the user supplies a provider key, stored in OS-backed SecretStorage. Prompts, selected code, and active-file context sent to a configured cloud provider leave the machine and are governed by that provider's terms and retention. Use provider key restrictions, quotas, and rotation.
3. **Puter User-Pays (not integrated in 0.1.0):** official Puter docs describe per-user accounts/usage and monthly free allowances, with upgrade prompts after allowance is exhausted. This is not unlimited free inference. Before integration, verify the desktop/webview origin and OAuth handoff, explain data transfer, request consent before first send, and allow sign-out/revocation.
4. **Cude shared free pool (not integrated):** never embed pool keys in the app, extension, or repository. A distributed client cannot keep them secret. This requires a Cude-owned backend with user authentication, strict per-account/IP quotas, rate limits, abuse detection, spend caps, request-size/time limits, provider isolation, audit controls, and an emergency kill switch. Until that service exists, the pool stays off. A user-selected BYOK/Puter/local provider must not silently fail over to another destination because that changes where source code is sent.

## Remaining risks

- Workspace Trust cannot sandbox a malicious extension or defend against OS/runtime vulnerabilities. Install only reviewed extensions and keep system protections enabled.
- Cude 0.1.0's agent is a planner, not a permissioned autonomous execution engine. MCP `tools/call`, robust extension allowlisting, signed updates, OS-level process/network isolation, reproducible source builds, threat-model review, and security integration tests remain future work.
- The Cude source fork/build system is not complete; current binaries derive from a pinned VSCodium release. Open-source licenses and third-party notices remain included.

## References

- [Workspace Trust](https://code.visualstudio.com/docs/editing/workspaces/workspace-trust)
- [Workspace Trust Extension Guide](https://code.visualstudio.com/api/extension-guides/workspace-trust)
- [Puter User-Pays Model](https://docs.puter.com/user-pays-model/)
- [Puter security and permissions](https://docs.puter.com/security/)
- [Puter supported platforms](https://docs.puter.com/supported-platforms/)
- [Gemini API key authentication](https://ai.google.dev/api)

## Signed release artifacts

The release operator can sign a Windows ZIP with an Ed25519 release key kept outside the project. Use an unused manifest path for each publication and a strictly increasing release sequence.

    node build/release-manifest.js prepare <zip> <https-zip-url> <version> <minimum-pool-version> <sequence> <private-pem> <output-json>
    node build/release-manifest.js verify <zip> <manifest> <public-pem> <trusted-https-origin> <minimum-accepted-sequence>

Publish the ZIP and signed manifest together through the authorized Cude release host. Consumers must use a public key pinned independently of that host and remember the last accepted sequence. Key rotation requires a separate trust decision. This command prepares and verifies the artifacts. A production feed and server rollout still require the authorized operator. A client-supplied version is not authorization.

The Windows IDE registers **Cude: Configure Release Trust** and **Cude: Check for Signed Updates**. Provision a local JSON file with the release feed URL under `feed` and the Ed25519 public PEM under `key`. Verify the fingerprint through an independent channel when the IDE prompts. The IDE checks the signed manifest, records its accepted sequence and hash, and offers a verified ZIP download to a chosen folder. It never installs the ZIP automatically. It does not disable the editor based on an update feed.

## Contact

Report security issues privately to [cudide-sup@outlook.com](mailto:cudide-sup@outlook.com).
