# Shared user customizations

`chat.agentHost.unifiedUserCustomizations` is an opt-in, false-by-default supplement to each harness's native discovery. The source is the **agent host's** `~/.agents`, independent of the VS Code profile or the selected project. Project sessions and workspaceless quick chats use the same user source.

```text
~/.agents/
  skills/<name>/SKILL.md
  agents/<name>.agent.md
  instructions/<name>.instructions.md
  rules/<name>.mdc
  mcp.json
  plugins/<name>/
    .claude-plugin/plugin.json   # or .plugin/plugin.json / plugin.json
    skills/<name>/SKILL.md
    agents/<name>.md
    .mcp.json
```

Plugins must have a manifest supported by the existing [plugin parser](../agentPlugins/common/pluginParsers.ts). The plugins directory contains extracted plugin packages; marketplace indexes, ordinary directories, and harness-specific installation registries are not plugin packages. Sharing does not install plugins, connect apps, or copy credentials between harnesses. Provider-specific plugin features retain the provider's existing support limits.

Loose MCP definitions use the common `mcpServers` map:

```json
{
  "mcpServers": {
    "research": { "command": "research-mcp", "args": [] },
    "remote": { "type": "http", "url": "https://example.com/mcp" }
  }
}
```

An omitted stdio `cwd` inherits the session's working directory, including the managed directory of a quick chat. An explicit relative `cwd` is relative to `~/.agents`; plugin MCP definitions retain their package-relative working directory. Definitions and resources keep their original source URIs for editing and persistent enablement.

## Provider handoff

| Harness | Standalone shared skills | Supplemental resources |
| --- | --- | --- |
| Copilot | Native discovery | Loose instructions → `instructionDirectories`; loose agents → `customAgents`; loose MCP → `mcpServers`; packages → `pluginDirectories`, or explicit surviving components when a package has a native name conflict |
| Claude | Shared skill/agent view passed as a local `Options.plugins` entry | Always-on instructions → preset `systemPrompt.append`; packages → local plugin entries; selected shared agent → plugin-qualified `Options.agent`; enabled MCP → `Options.mcpServers` with plugin MCP rediscovery suppressed |
| Codex | Native `skills/list`; same-named shared skills get per-thread path exclusions while existing native skill selectors are preserved | Always-on instructions → thread `developerInstructions`; agents → thread `config.agents` role files; MCP → thread `config.mcp_servers`; package skills → existing per-turn `additionalContext` catalog and read grants |

Claude's stdio MCP options cannot represent `cwd`. Shared servers needing another working directory use a Node wrapper with literal argv, inherited stdio, and signal forwarding; commands never go through a shell.

Native/private skills, agents, MCP servers and plugins take precedence over shared resources of the same name. A native declaration reserves its name even when disabled; the shared version cannot silently reactivate it. The harness's own project-versus-user precedence is preserved. Plugins are matched by package name; Claude's distinct plugin namespaces remain distinct names.

Codex merges thread MCP overrides recursively with native configuration. Only nonconflicting supplemental MCP servers receive bounded, stable `agents_<name>_<digest>` names, retaining their original customization IDs. This leaves private MCP tables intact and prevents mixing HTTP and stdio fields. Codex reads native configuration through `config/read` rather than parsing or editing private TOML files.

Claude's SDK reloads plugin directories independently of the published catalog. A session-owned plugin view contains only the surviving loose skills and agents, including skill support files, so the native SDK cannot also load loose shared hooks. The view is passed to the SDK; the catalog retains original source URIs. Native private directories and shared sources are not rewritten.

Different names can provide equivalent capabilities. Both remain available; sharing adds no skill-selection instruction to outgoing turns.

## Instructions

Standalone instructions use `instructions/*.instructions.md` or `rules/*.mdc`. Copilot receives `instructionDirectories` and applies its native rule matching. Claude appends always-on rule bodies to its preset `systemPrompt` when building the native session. Codex includes always-on rule bodies in thread `developerInstructions`, preserving native inline developer instructions. Claude and Codex do not promote scoped rules to global instructions. This is launch configuration, not a new instruction appended to each user message.

Loose hooks are not shared. Configure hooks through each harness's native configuration; event names, matching, input JSON and output JSON remain provider-specific. Installed plugin packages retain their existing native hook behavior. Instructions are additive, following each harness's own instruction precedence.

Native private skills, MCP, agents, plugins, and project configuration remain enabled. The flag only controls the supplement: turning it off does not disable standalone skills that the SDK already discovers in `~/.agents/skills`.

## Lifecycle and ownership

[SharedUserCustomizationDiscovery](node/shared/sharedUserCustomizations.ts) reads only the shared source and watches its resource directories. Opt-in and file changes replace the snapshot, rather than appending to it. Discovery errors remove the failed snapshot. Enablement resolution is required at publication and SDK handoff, including pending decisions and parent/child MCP decisions.

Copilot uses its existing session plugin reconciliation; Claude rebuilds startup wiring; Codex reapplies thread-bound customizations on start/resume. Existing turns and persisted conversation history are not rewritten when the supplement changes.

The workbench forwards the boolean to the local host. It does not forward the desktop's home path or customization files. A remote host needs its own `unifiedUserCustomizations` root opt-in and uses its own home directory.
