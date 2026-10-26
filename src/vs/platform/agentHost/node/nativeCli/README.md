# DSH and ZCode in the local Agent Host

These opt-in providers expose DeepSeek Harness and ZCode through the existing VS Code Chat and Agent Host session surfaces. Each independent chat owns one native stdio process, which stays alive across turns. Closing or cancelling that process affects its own chat and native descendants. The next send starts a new process and resumes the saved native conversation after the previous process exits.

The providers implement `IAgent`; session identity, chat membership, workspace preparation and protocol state remain owned by Agent Host. The native harness owns model execution, tools, native skills and native MCP configuration. No additional DSH runtime plugin is installed.

## Enable

Install the native applications or CLI executables, configure their model access, and add these user settings:

```json
{
  "chat.agentHost.dshAgent.enabled": true,
  "chat.agentHost.zcodeAgent.enabled": true
}
```

Run **Developer: Restart Local Agent Host** after changing native provider settings. The regular Chat session picker then discovers the providers from the local host. This requires a VS Code build containing this change; rebuilding the development checkout does not replace an installed VS Code application.

On macOS, executable discovery recognizes `/Applications/DeepSeek Harness.app` and `/Applications/ZCode.app`. Otherwise it uses `dsh` or `zcode` on the executing host's PATH. For ZCode on Linux, the first `zcode` on PATH is followed through its symlinks; when the directory it leads to holds `resources/glm/zcode.cjs` and `resources/config/provider/zcode-builtin.json` (the layout of the Linux package), the bundled CLI entry is run directly, the same way as the macOS application. Any other layout, such as a wrapper script, is launched as given. So are DSH arguments that do not select a profile server (`--profile`): the CLI is never extended, and it is never started just to read its inventory. Its permission modes, tools, agents and MCP status are then not available, because the process-local extension needs the CLI entry file to attach to. Each provider has an optional `.executable` and `.args` setting; arguments replace the default protocol-server arguments and are passed without a shell. An explicit `.executable` is never replaced. DSH's default arguments are `--profile sdk`; ZCode's are `app-server --stdio`.

The native process inherits the user's environment, cleaned the way VS Code cleans its terminals (no `VSCODE_*`, `ELECTRON_*` or `SNAP*` plumbing) and without `NODE_OPTIONS`. Its standard error is discarded on purpose, because it can carry credentials: a failed start shows only the exit status.

The optional `.home` setting supplies `DSH_HOME` or `ZCODE_DATA_BASE_DIR`. For ZCode, set the directory containing `.zcode`, including when its data was moved in the desktop application. For example, `/path/to/ZCode` means `/path/to/ZCode/.zcode/v2/provider_config.json`. Empty preserves the inherited environment and the native default. ZCode's bundled provider definitions are copied into a temporary runtime directory; the adapter does not write the installed application's configuration.

## Models

DSH reads the selected SDK profile with the native CLI's boot-free `--dump-config` command. It preserves configured provider/model routes, display names, context limits, reasoning choices and the native default selection. YAML code tags are never evaluated by VS Code, and configuration output is never logged. Built-in model names are read from the installed SDK's schema when needed.

ZCode resolves its catalog before the first user turn in a short-lived native process with an isolated home. Provider definitions are copied privately for inspection, so discovery creates no conversation in the user's history and cannot rewrite the original provider files. The model list and default thinking levels come from the native registry; runtime snapshots refresh that metadata. Account/subscription routes are omitted until the desktop authentication-header bridge is supported.

Discovery starts the whole native runtime, so it is bounded: at most two inspections run at once, each is abandoned after 30 seconds, and a failure is logged by its class only (never by the native output). A failed catalog is read again by the first request after 30 seconds, so a repaired configuration needs no restart. The result of inspecting a workspace is reused for five minutes, which keeps a finished turn from starting the runtime again for every other chat of the agent.

To override discovery with an explicit model list, use model IDs in `provider/model` form:

```json
{
  "chat.agentHost.dshAgent.models": [
    { "id": "deepseek-official/deepseek-flash", "name": "DeepSeek Flash" },
    { "id": "my-provider/my-model", "name": "My DSH Model" }
  ],
  "chat.agentHost.zcodeAgent.models": [
    { "id": "my-provider/my-model", "name": "My ZCode Model" }
  ]
}
```

A listed model is always offered, whether or not the runtime knows it. For ZCode, the runtime only adds what it knows about a listed model, such as its thinking levels. Model IDs may themselves contain slashes; only the first slash separates the provider. API-key providers use the native provider configuration. Changing the selected model restarts that chat's process and resumes the native conversation with the new route.

## Persistence and cancellation

Opaque provider data stores the native conversation ID, model and workspace. A provider-owned rendering journal is stored in the exact persistence scope supplied by Agent Host. History reads never start a native process or claim its writer lock. The journal preserves text, reasoning, tools, errors and cancellation already observed by VS Code; native context is restored with the original SDK session ID. It does not import unrelated historical conversations from the desktop application's catalog.

Quick chats without an open workspace use Agent Host's stable scratch folder under `<userHome>/.copilot/chats/<sessionId>`, like the existing Claude provider. Missing scratch folders are recreated on resume, and scratch folders are not published as workspace projects.

A native session may not be saved until it has been used. If the runtime no longer knows the session of a chat that never completed a turn, ZCode and DSH alike start a new native session for it; a chat with completed turns reports the loss instead of silently starting over. A message sent right after Stop waits until the old process has exited, rather than being refused or cancelled by that exit.

Cancellation closes stdin so the runtime can cancel work and flush its native store. Shutdown waits for process exit before escalation or another launch. Startup cancellation is generation-checked so an abandoned launch cannot admit a late prompt. Unexpected process exit rejects pending requests and releases the dead connection for a subsequent resume.

## Capability boundaries

The current adapters support text prompts, independent chats, native tools, rendering history, model selection and stop/resume. They do not advertise fork, side-chat, multi-root or image support. Native skills and MCP servers remain configured in the native harness; VS Code client tools and shared customization catalogs are not forwarded.

The Permissions picker is populated from the native runtime and applies to the next turn of the exact chat. DSH exposes its configured permission presets (sandbox plus approval policy); the process-local extension switches them with the SDK service and relays native approval requests to VS Code. ZCode exposes its own mode enum and applies permission and plan state to that runtime without writing workspace-wide preferences. Selections are retained across native process restarts. A chat that was given a mode is not started under the runtime's own default when the catalog could not be read in time; the message fails and can be sent again. DSH's approval request names the tool call and why it needs a decision, but carries no tool input, so the approval shows that reason together with the input the call itself already showed. The Full Access modes (DSH `danger-full-access`, ZCode `yolo`) are plain choices of the native catalog: unlike the shared auto-approve levels they are neither confirmed in a dialog nor withheld by the organization's auto-approve policy. Older runtimes that cannot expose their permission catalog do not advertise unsupported choices. ZCode uses `interaction/requestPermission`, `interaction/requestUserInput` and `session/requestRuntimePreferences`; unsupported server requests fail rather than being automatically approved.

DSH emits committed SDK session events; its native SDK does not currently expose token deltas through this interface. ZCode asks the host for its runtime preferences, and the adapter answers them itself: native search enhancements on, tool search off, memory off, ask-user auto-resolution off and the `preflight-v1` context budget. These take the place of the corresponding settings of the ZCode application for chats run from VS Code. ZCode's model stream is rendered incrementally and reconciled with committed parts without adding its completion summary twice.

DSH native plugins can handle slash commands locally. Their `command/done` feedback is rendered and saved even when no assistant message or model request is produced. Native command autocomplete is not currently forwarded to VS Code.

## Customization inventory

The native inventory is merged with the existing VS Code shared catalog. Origin does not establish whether a resource is loaded: native registries and runtime observations supply that evidence. Shared customization enablement and client tools are still not forwarded to the native CLIs.

DSH uses a temporary observation-only profile overlay to read `skills.snapshot`, the tool registry and Cordis module states. The overlay is removed with its process and never installed in the SDK profile. It also reports baseline instruction candidates through the enabled instruction plugin's own discovery function. Files encountered later while visiting nested directories are not an exhaustive baseline catalog.

ZCode reads its public skill and plugin catalogs. For the bundled CommonJS SDK, a process-local extension reads the selected model's tool registry, active agents, instruction source paths and MCP status, and exposes an exact-chat permission operation using the native execution-state service. The extension leaves installed SDK files unchanged, preserves their module resolution and disables itself when the supported dispatcher cannot be identified. Custom CLIs can implement the same metadata method themselves. A workspace preview uses a disposable session and private provider files in an isolated data directory; it never provisions a chat backing, writes the user's conversation history or invokes a model. A live observation uses only the exact chat's existing native session.

The Tools page reuses the shared searchable tree and groups only tools reported by the owning runtime, including MCP tools after connection. Workspace previews distinguish tools available to load from tools loaded in a live chat. Deferred and code-callable tools have separate labels; absent or unsupported observations are not presented as authoritative empty registries. DSH registry changes and ZCode MCP revisions refresh live observations. File-backed resources retain their real URIs, while pathless built-ins and passive native plugin/MCP inventories are read-only.

| Section | Native CLI integration |
| --- | --- |
| Skills | Native DSH and ZCode registries, with native precedence and invocation flags. |
| Instructions | DSH baseline candidates and ZCode's initialized instruction source paths; no instruction bodies cross the metadata boundary. |
| Agents | ZCode active definitions, including built-ins and plugin agents. Native agent invocation remains owned by the native tool; VS Code custom-agent selection is not supported. |
| Hooks | Runnable hook definition files from enabled ZCode plugin manifests. Other native hook sources and lifecycle management are not connected. |
| MCP Servers | ZCode native connection status, without VS Code lifecycle or enablement controls. DSH MCP tools appear in its tool registry; separate DSH server status is not exposed. |
| Plugins | Passive Cordis module states and ZCode native plugin manifests. Neither implies support for Open Plugins management. |
| Tools | Model-facing native tool names, descriptions, source and loading mode; no substitution from unrelated installed client tools. |
| Models | Independent native model catalog described above. |

Restart the local agent host after changing native profile configuration or installing native customizations; filesystem-driven catalog refresh is not yet connected. An empty section outside the connected inventory above does not establish that the native harness has no such customization.

## Validation

```sh
npm run build-fast -- --client-only
npm run typecheck-client
npm run eslint -- 'src/vs/platform/agentHost/node/nativeCli/*.ts' 'src/vs/platform/agentHost/test/node/nativeCli*.test.ts'
npm run valid-layers-check
npm run test-build-scripts
VSCODE_SKIP_PRELAUNCH=1 ./scripts/test.sh \
  --run src/vs/platform/agentHost/test/node/nativeCliAgent.test.ts \
  --run src/vs/platform/agentHost/test/node/nativeCliAgentDiscovery.test.ts \
  --run src/vs/platform/agentHost/test/node/nativeCliModelCatalog.test.ts \
  --run src/vs/platform/agentHost/test/node/nativeCliCustomizations.test.ts \
  --run src/vs/platform/agentHost/test/node/nativeCliPermissions.test.ts \
  --run src/vs/platform/agentHost/test/node/nativeCliRuntime.test.ts
```

`test-build-scripts` includes the check that every package the agent host loads is part of the remote server's `package.json`. The tests use actual child processes and an in-memory session database. They cover process reuse, per-chat cancellation, a message sent right after Stop, startup cancellation, native resume, saved-history restoration, approval decisions, response reconciliation, connection failure, bounded and shared discovery, and the observation extensions of both runtimes against two shapes of the ZCode dispatcher. Native runtime acceptance should additionally use isolated DSH/ZCode homes and a loopback model endpoint to exercise the installed protocol versions without changing application credentials. The ZCode extension finds its injection point by pattern in the installed `zcode.cjs`; after a ZCode update, check that the permission picker and the Tools page are still populated.
