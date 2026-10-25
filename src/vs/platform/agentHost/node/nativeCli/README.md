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

On macOS, executable discovery recognizes `/Applications/DeepSeek Harness.app` and `/Applications/ZCode.app`. Otherwise it uses `dsh` or `zcode` on the executing host's PATH. Each provider has an optional `.executable` and `.args` setting; arguments replace the default protocol-server arguments and are passed without a shell. DSH's default arguments are `--profile sdk`; ZCode's are `app-server --stdio`.

The optional `.home` setting supplies `DSH_HOME` or `ZCODE_DATA_BASE_DIR`. For ZCode, set the directory containing `.zcode`, including when its data was moved in the desktop application. For example, `/path/to/ZCode` means `/path/to/ZCode/.zcode/v2/provider_config.json`. Empty preserves the inherited environment and the native default. ZCode's bundled provider definitions are copied into a temporary runtime directory; the adapter does not write the installed application's configuration.

## Models

DSH reads the selected SDK profile with the native CLI's boot-free `--dump-config` command. It preserves configured provider/model routes, display names, context limits, reasoning choices and the native default selection. YAML code tags are never evaluated by VS Code, and configuration output is never logged. Built-in model names are read from the installed SDK's schema when needed.

ZCode resolves its catalog before the first user turn in a short-lived native process with an isolated home. Provider definitions are copied privately for inspection, so discovery creates no conversation in the user's history and cannot rewrite the original provider files. The model list and default thinking levels come from the native registry; runtime snapshots refresh that metadata. Account/subscription routes are omitted until the desktop authentication-header bridge is supported.

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

Model IDs may themselves contain slashes; only the first slash separates the provider. API-key providers use the native provider configuration. Changing the selected model restarts that chat's process and resumes the native conversation with the new route.

## Persistence and cancellation

Opaque provider data stores the native conversation ID, model and workspace. A provider-owned rendering journal is stored in the exact persistence scope supplied by Agent Host. History reads never start a native process or claim its writer lock. The journal preserves text, reasoning, tools, errors and cancellation already observed by VS Code; native context is restored with the original SDK session ID. It does not import unrelated historical conversations from the desktop application's catalog.

Quick chats without an open workspace use Agent Host's stable scratch folder under `<userHome>/.copilot/chats/<sessionId>`, like the existing Claude provider. Missing scratch folders are recreated on resume, and scratch folders are not published as workspace projects.

Cancellation closes stdin so the runtime can cancel work and flush its native store. Shutdown waits for process exit before escalation or another launch. Startup cancellation is generation-checked so an abandoned launch cannot admit a late prompt. Unexpected process exit rejects pending requests and releases the dead connection for a subsequent resume.

## Capability boundaries

The current adapters support text prompts, independent chats, native tools, rendering history, model selection and stop/resume. They do not advertise fork, side-chat, multi-root or image support. Native skills and MCP servers remain configured in the native harness; VS Code client tools and shared customization catalogs are not forwarded.

DSH SDK versions that expose `approval/request` and `user-question/ask` use the shared VS Code confirmation and input UI. The locally examined `0.2.1-rc.2` SDK predates those callbacks; its native policies still apply. ZCode uses `interaction/requestPermission`, `interaction/requestUserInput` and `session/requestRuntimePreferences`. Unsupported server requests fail rather than being automatically approved.

DSH emits committed SDK session events; its native SDK does not currently expose token deltas through this interface. ZCode's model stream is rendered incrementally and reconciled with committed parts without adding its completion summary twice.

DSH native plugins can handle slash commands locally. Their `command/done` feedback is rendered and saved even when no assistant message or model request is produced. Native command autocomplete is not currently forwarded to VS Code.

## Customization inventory

Skills come from the owning native registry, rather than a scan of Claude's folders or the VS Code shared catalog. DSH uses a temporary observation-only profile overlay to call `skills.snapshot`; the overlay is removed after discovery and no bundle is installed. ZCode uses the workspace `skills/referenceCatalog` method. Neither path creates, resumes or prompts a native conversation. Native validation, precedence, custom roots and symbolic links therefore remain authoritative. File-backed entries retain their real file URIs; pathless DSH entries are read-only built-ins. Incomplete DSH observations fail discovery instead of publishing an authoritative empty inventory.

DSH also reports baseline instruction candidates through the installed instruction plugin's own discovery function, respecting whether that plugin is enabled and its configured filenames. Instructions encountered later while visiting nested directories are not an exhaustive baseline catalog. These native directories are not advertised as destinations for VS Code creation or enablement management. Restart the local agent host after changing native profile configuration or installing native customizations; filesystem-driven live catalog refresh is not yet connected.

The remaining customization sections have separate integration boundaries:

| Section | Native CLI integration |
| --- | --- |
| Skills | Native DSH and ZCode inventories are displayed. |
| Instructions | DSH baseline discovery is displayed. ZCode instruction inventory is not connected. |
| Agents | Native agent selection and native plugin agent inventories are not connected. |
| Hooks | Native hook manifests and lifecycle management are not connected. |
| MCP Servers | Native harness configuration still governs execution; native status inventory and VS Code server controls are not connected. VS Code collections are not proof that the native harness loaded those servers. |
| Plugins | DSH Cordis modules are not Open Plugins. ZCode has a native `plugins/list` API, but its inventory and management are not connected to this view. |
| Models | Uses the independent native model catalog described above. |

An empty section outside the connected inventory above does not establish that the native harness has no such customization. VS Code shared customization enablement is not forwarded to either native CLI.

## Validation

```sh
npm run build-fast -- --client-only
VSCODE_SKIP_PRELAUNCH=1 ./scripts/test.sh --run src/vs/platform/agentHost/test/node/nativeCliAgent.test.ts --run src/vs/platform/agentHost/test/node/nativeCliModelCatalog.test.ts --run src/vs/platform/agentHost/test/node/nativeCliCustomizations.test.ts
```

The tests use actual child processes and an in-memory session database. They cover process reuse, per-chat cancellation, startup cancellation, native resume, saved-history restoration, approval decisions, response reconciliation and connection failure. Native runtime acceptance should additionally use isolated DSH/ZCode homes and a loopback model endpoint to exercise the installed protocol versions without changing application credentials.
