# Direct gateway models for Claude and Codex

This development build shares extension-registered BYOK models with the native Claude and Codex harnesses. Inference goes directly from the SDK to the gateway: Claude uses Anthropic Messages; Codex uses OpenAI Responses. The gateway, such as 9Router, performs protocol conversion.

Enable the existing local Agent Host settings and restart the development window after rebuilding:

```json
{
  "chat.agentHost.claudeAgent.enabled": true,
  "chat.agentHost.codexAgent.enabled": true,
  "chat.agentHost.byokModels.enabled": true
}
```

For gateway-only use while signed out of GitHub, also enable `chat.agentHost.allowSignedOutWhenUsable`.

A provider must explicitly opt in; ordinary Language Model Chat Provider registration does not expose an HTTP endpoint or credentials. Its extension manifest declares a private connection command:

```json
{
  "contributes": {
    "languageModelChatProviders": [{
      "vendor": "example-gateway",
      "displayName": "Example Gateway",
      "directConnection": {
        "command": "example-gateway.resolveDirectConnection",
        "protocols": ["messages", "responses"]
      }
    }]
  }
}
```

The command receives `{ modelId, protocol, configuration }`. `configuration` is the selected registered group's resolved configuration, including secrets. It returns `{ baseUrl, modelId, headers? }`. The URL must be HTTP(S), without credentials/query/fragment; header values must not contain newlines. Return the exact registered model id, including prefixes such as `cx/`. The endpoint must be reachable from the local Agent Host. Only models advertising tool calling and the requested protocol appear in that harness's picker. Existing BYOK policy and source visibility continue to apply.

For 9Router 0.5.95, the Messages base URL is `http://localhost:20128`; the Responses base URL is `http://localhost:20128/v1`. The compatibility patch for the installed **9Router for GitHub Copilot 1.8.3** registers the command and adds the manifest declaration:

```sh
node scripts/patch-9router-direct-connection.mjs /absolute/path/to/hotrungnhan.9router-for-github-copilot-1.8.3
```

The patch backs up `package.json` and `out/extension.js` as `*.before-direct-connection`, checks the extension version/bundle layout, and is idempotent. An extension upgrade can overwrite the patch; unsupported versions require updating the patch. The patch alone does not add this feature to an unmodified release of VS Code: use the modified Code OSS build.

Connections are resolved at conversation startup/resume, not placed in the public model catalogue. Different configuration groups remain separate even when their model ids match. Claude rebuilds its subprocess on direct-model changes while resuming the same session. Codex supplies provider configuration per thread on start, resume, and fork; it does not change `~/.codex/config.toml`. Removed/disabled models fail instead of silently choosing a different account. The direct resolver currently uses the local reverse IPC channel; remote Agent Hosts are not supported by this change.

## Validation performed

- Client TypeScript check passed; 614 targeted Agent Host/workbench unit regressions passed, including exact group secret resolution, private IPC, capability/policy filtering, stale connection rejection, Claude transport switching, and Codex launch configuration.
- Six compatibility patch tests passed for group/legacy credentials, explicit empty keys, case-insensitive custom authorization, version checks, backups, and idempotency.
- Real Claude Agent SDK 0.3.281 and Codex app-server 0.153.0 against local 9Router 0.5.95 using `ark/glm-5.3-flash`: each wrote/read a sandbox file with its native tools and resumed the same conversation; Codex also forked its conversation. A new temporary gateway key was used and deleted after the smoke run; existing credentials were not accessed.
- Isolated Code OSS development window with the patched 9Router extension: both Claude and Codex model pickers displayed the 9Router group, accepted `Gpt 6.1 Sol (cx)`, and retained it as the current model. Source visibility is respected; expand **Other Models** to see unpinned models. No inference was sent from that cloned-profile UI test.

The live SDK smoke verifies these wire paths and native lifecycle operations. It does not establish compatibility with every upstream model. The missing extension dependencies were subsequently installed, and `npm run build-fast-extensions` completed successfully, including Markdown, language servers, and extension media. The desktop production bundle also completed successfully.

## Local macOS application

For the local install, the production desktop bundles replace `Contents/Resources/app/out` in a copy of the existing 1.140.0 application. The matching Electron 43.7.3 runtime, production dependencies, and 97 packaged built-in extensions are retained. Application identity, existing profiles, Marketplace configuration, and the `code` launcher are preserved. Bootstrap package metadata, localization metadata hash, and file integrity hashes are regenerated. `product.json.localBuild` records the source commit and build date; the upstream base commit is retained for existing server/download compatibility.

The original application and user profile are backed up under `~/Library/Application Support/VSCode Local Builds/2026-10-06-direct-models/`. The custom application is signed locally. macOS may request authorization to read the existing Code keychain entries because the application signature changes. Automatic application updates must be disabled for this local build so an official update does not replace the custom core.

The installed application was validated with the existing Code profile: the editor's Claude harness and the separate Agents window's Codex harness each used the registered `cx/gpt-6.1-sol` model, executed `pwd`, and completed a reply. Both harness catalogues contain the nine models visible under the existing source visibility settings. The first launch used an old extension-manifest cache; a window reload refreshed the opt-in declaration. Existing API keys were used by the application without being read or displayed by the test tools. Application auto updates and auto updates for the patched 9Router extension are disabled; other extension update preferences are retained.
