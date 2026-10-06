# Unified user skills and MCP

Enable this experimental local-build setting and reload the window:

```json
{
  "chat.agentHost.unifiedUserCustomizations": true
}
```

VS Code's existing user skill discovery and MCP configuration become the shared source for Copilot, Claude, and Codex. Each harness additionally loads its own native MCP configuration, without sharing it with the others. A directory such as `~/.claude/skills` still participates if VS Code already discovers it through its own skill locations; native-only user skills remain excluded.

Use the existing chat customization editor to add, edit, enable, or disable user skills. The catalog uses the original file URIs, VS Code's duplicate-name precedence, and profile-wide skill enablement. Disabled skills remain visible and editable. The same enabled catalog is sent through the active-client plugin bundle to every local harness.

Manage shared MCP through VS Code's existing MCP list and configuration files. The primary toggle writes profile enablement; client-bundled servers do not offer harness-specific Workspace/Session overrides in this mode. Old harness-specific decisions do not override the common toggle. Private MCP retains the harness's existing configuration and controls. External application MCP discovery does not turn private files into a shared source. Existing VS Code discovery and launch context for workspace servers continue to apply.

VS Code MCP definitions take priority over same-named private MCP entries. Disabling a shared server reserves its name and prevents the private definition from taking over. Other private MCP servers remain available.

The Agents window's bundled skills and the harness's built-in commands retain their existing behavior. Workspace customizations, agents, instructions, and hooks keep their existing discovery paths. Native user configuration files and Desktop applications are not modified.

## SDK behavior

- Copilot receives explicit skill directories and exclusions for native-only personal skills, retaining native MCP, built-ins and workspace discovery.
- Claude receives explicit shared MCP configuration alongside native MCP discovery, and its actual built-in command set plus workspace/client skill names. Native personal skills are disabled, and control-plane model/command enumeration cannot start native MCP servers. Open Plugin skill namespaces follow the SDK's directory basename.
- Codex retains native MCP at app-server startup. Shared MCP overrides (including disabled shared names) and native personal skill exclusions are supplied at thread start, resume, and fork. Shared servers use separate SDK registration names to prevent recursive configuration merging from mixing native stdio fields with HTTP fields. Inventory, authentication and MCP channel requests retain the original VS Code names.

A changed bundle follows the existing SDK rebuild/resume lifecycle before the next model turn. Turning a customization off does not cancel a tool call already in flight.

The installed configuration targets the local Agent Host. Remote hosts need their own compatible build and host-side opt-in; the local setting does not enable this mode on them automatically. The separate direct-gateway-model change still supports local hosts only.

## Validation

The provider integration test runs all three bundled SDKs against a local mock model endpoint and real stdio/HTTP MCP servers in isolated homes. It checks:

- The shared skill and MCP tool reach the model, and the MCP tool actually executes.
- Disabling and re-enabling the shared catalog changes the next turn and restores tool execution.
- Each harness's private MCP tool reaches its own model and executes while shared MCP is on, off and restored; other harnesses' private MCP tools are absent.
- Native-only user skills and conflicting private MCP entries with shared names do not leak into model requests or execute as a fallback.
- Codex MCP channels retain their original names and route tools/list and tools/call through SDK registration aliases, including HTTP/stdio name collisions.
- The built-in skill/command projection stays unchanged during the common toggle.

Targeted workbench and Agent Host regressions cover discovery, original editable URIs, disabled rows, profile MCP toggles, stale scoped decisions, SDK options, and authentication reconciliation.
