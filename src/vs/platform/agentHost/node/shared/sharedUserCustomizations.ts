/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ResourceSet } from '../../../../base/common/map.js';
import { basename, dirname } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { detectPluginFormat, parsePlugin, readAgentComponents, readInstructionComponents, readPluginManifest, readPluginMcpServers, readSkills, toParsedAgent, toParsedRule, toParsedSkill, type IParsedPlugin } from '../../../agentPlugins/common/pluginParsers.js';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { IFileService } from '../../../files/common/files.js';
import { ILogService } from '../../../log/common/log.js';
import { McpServerType } from '../../../mcp/common/mcpPlatformTypes.js';
import { AgentHostConfigKey, agentHostCustomizationConfigSchema } from '../../common/agentHostCustomizationConfig.js';
import { CustomizationLoadStatus, CustomizationType, customizationId, type PluginCustomization } from '../../common/state/sessionState.js';
import { IAgentConfigurationService } from '../agentConfigurationService.js';

export interface ISharedUserCustomization {
	readonly customization: PluginCustomization;
	readonly parsed: IParsedPlugin;
	readonly pluginDir: URI;
	/** Loose resources at ~/.agents, rather than an installed plugin. */
	readonly loose: boolean;
}

/** Names claimed by the harness, including native resources that it has disabled. */
export interface IPrivateCustomizationNames {
	readonly skills: ReadonlySet<string>;
	readonly agents: ReadonlySet<string>;
	readonly mcpServers: ReadonlySet<string>;
	readonly plugins: ReadonlySet<string>;
}

/** Shared resources supplement native configuration; they never replace a native name. */
export function filterSharedUserCustomizations(plugins: readonly ISharedUserCustomization[], native: IPrivateCustomizationNames, namespacedComponents = false): readonly ISharedUserCustomization[] {
	return plugins.flatMap(plugin => {
		if (!plugin.loose && native.plugins.has(plugin.customization.name)) {
			return [];
		}
		const componentName = (name: string) => namespacedComponents && !plugin.loose ? `${plugin.customization.name}:${name}` : name;
		const parsed: IParsedPlugin = {
			...plugin.parsed,
			skills: plugin.parsed.skills.filter(skill => !native.skills.has(componentName(skill.name))),
			agents: plugin.parsed.agents.filter(agent => !native.agents.has(componentName(agent.name))),
			mcpServers: plugin.parsed.mcpServers.filter(server => !native.mcpServers.has(server.name)),
		};
		const children = [...parsed.skills, ...parsed.agents, ...parsed.instructions, ...parsed.hooks, ...parsed.mcpServers].map(item => item.customization);
		if (plugin.loose && children.length === 0) {
			return [];
		}
		return [{ ...plugin, parsed, customization: { ...plugin.customization, children } }];
	});
}

/** Read only the common user directory; native and project configuration stays with its harness. */
export async function discoverSharedUserCustomizations(userHome: URI, nativeUserSkills: boolean, fileService: IFileService, logService: ILogService): Promise<readonly ISharedUserCustomization[]> {
	const root = URI.joinPath(userHome, '.agents');
	if (!await fileService.exists(root)) {
		return [];
	}
	const format = await detectPluginFormat(root, fileService);
	const skillsRoot = URI.joinPath(root, 'skills');
	const [agents, skills, mcpServers, instructions] = await Promise.all([
		readAgentComponents([URI.joinPath(root, 'agents')], fileService),
		nativeUserSkills ? [] : readSkills(skillsRoot, [skillsRoot], fileService),
		readPluginMcpServers(root, [URI.joinPath(root, 'mcp.json')], format, fileService),
		readInstructionComponents([URI.joinPath(root, 'instructions'), URI.joinPath(root, 'rules')], fileService),
	]);
	const result: ISharedUserCustomization[] = [];
	const add = (pluginDir: URI, parsed: IParsedPlugin, name: string, loose: boolean) => {
		result.push({
			pluginDir, parsed, loose,
			customization: {
				type: CustomizationType.Plugin,
				id: customizationId(pluginDir.toString()),
				uri: pluginDir.toString(),
				name,
				load: { kind: CustomizationLoadStatus.Loaded },
				children: [...parsed.skills, ...parsed.agents, ...parsed.instructions, ...parsed.hooks, ...parsed.mcpServers].map(item => item.customization),
			},
		});
	};
	if (agents.length || skills.length || mcpServers.length || instructions.length) {
		add(root, {
			format: format.format,
			agents: agents.map(toParsedAgent),
			skills: skills.map(toParsedSkill),
			// An omitted cwd inherits the session's working directory. Explicit
			// relative paths still resolve against the shared configuration file.
			mcpServers: mcpServers.map(definition => ({
				...definition,
				defaultCwd: definition.configuration.type === McpServerType.LOCAL && definition.configuration.cwd ? root : undefined,
			})),
			hooks: [], instructions: instructions.map(toParsedRule),
		}, localize('sharedUserCustomizations.name', "Shared User Customizations"), true);
	}
	const pluginsRoot = URI.joinPath(root, 'plugins');
	if (await fileService.exists(pluginsRoot)) {
		const entries = (await fileService.resolve(pluginsRoot)).children ?? [];
		for (const entry of entries.filter(entry => entry.isDirectory).sort((a, b) => a.name.localeCompare(b.name))) {
			try {
				const pluginFormat = await detectPluginFormat(entry.resource, fileService);
				const manifest = await readPluginManifest(entry.resource, pluginFormat, fileService);
				if (!manifest) {
					continue;
				}
				const parsed = await parsePlugin(entry.resource, fileService, undefined, userHome, entry.resource);
				add(entry.resource, parsed, typeof manifest.name === 'string' ? manifest.name : basename(entry.resource), false);
			} catch (error) {
				logService.warn(`[SharedUserCustomizations] Failed to read '${entry.resource.toString()}'`, error);
			}
		}
	}
	return result;
}

/** Provider-local discovery avoids forwarding another machine's home or changing native discovery. */
export class SharedUserCustomizationDiscovery extends Disposable {
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	private readonly _watchers = this._register(new DisposableStore());
	private readonly _refreshScheduler = this._register(new RunOnceScheduler(() => { void this.refresh(); }, 200));
	private _plugins: readonly ISharedUserCustomization[] = [];
	private _pending: Promise<void> = Promise.resolve();
	private _revision = 0;
	private _settledRevision = 0;
	private _disposed = false;
	private _enabled: boolean | undefined;

	constructor(
		private readonly _nativeUserSkills: boolean,
		@INativeEnvironmentService private readonly _environmentService: INativeEnvironmentService,
		@IAgentConfigurationService private readonly _configurationService: IAgentConfigurationService,
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._register(this._configurationService.onDidRootConfigChange(() => {
			if (this._isEnabled() !== this._enabled) {
				void this.refresh();
			}
		}));
		void this.refresh();
	}

	get plugins(): readonly ISharedUserCustomization[] { return this._plugins; }
	get isSettled(): boolean { return this._settledRevision === this._revision && !this._refreshScheduler.isScheduled(); }

	async whenSettled(): Promise<void> {
		if (this._refreshScheduler.isScheduled()) {
			this._refreshScheduler.cancel();
			void this.refresh();
		}
		let pending: Promise<void>;
		do {
			pending = this._pending;
			await pending;
		} while (pending !== this._pending);
	}

	refresh(): Promise<void> {
		const revision = ++this._revision;
		this._pending = this._refresh(revision).catch(error => {
			this._logService.warn('[SharedUserCustomizations] Discovery failed', error);
			if (!this._disposed && revision === this._revision) {
				this._plugins = [];
				this._settledRevision = revision;
				this._onDidChange.fire();
			}
		});
		return this._pending;
	}

	private async _refresh(revision: number): Promise<void> {
		const enabled = this._isEnabled();
		this._enabled = enabled;
		const plugins = enabled ? await discoverSharedUserCustomizations(this._environmentService.userHome, this._nativeUserSkills, this._fileService, this._logService) : [];
		if (this._disposed || revision !== this._revision) {
			return;
		}
		this._plugins = plugins;
		this._watchers.clear();
		if (enabled) {
			const root = URI.joinPath(this._environmentService.userHome, '.agents');
			const directories = new ResourceSet([this._environmentService.userHome, root, ...['skills', 'agents', 'instructions', 'rules', 'plugins'].map(component => URI.joinPath(root, component))]);
			for (const plugin of plugins) {
				directories.add(plugin.pluginDir);
				for (const component of ['skills', 'agents', 'commands', 'rules', 'hooks', '.plugin', '.claude-plugin']) {
					directories.add(URI.joinPath(plugin.pluginDir, component));
				}
				for (const item of [...plugin.parsed.skills, ...plugin.parsed.agents, ...plugin.parsed.instructions, ...plugin.parsed.hooks, ...plugin.parsed.mcpServers]) {
					directories.add(dirname(item.uri));
				}
			}
			for (const directory of directories) {
				const watcher = this._watchers.add(this._fileService.createWatcher(directory, { recursive: false, excludes: [] }));
				this._watchers.add(watcher.onDidChange(event => {
					if (event.affects(root)) {
						this._refreshScheduler.schedule();
					}
				}));
			}
		}
		this._settledRevision = revision;
		this._onDidChange.fire();
	}

	private _isEnabled(): boolean {
		return this._configurationService.getRootValue(agentHostCustomizationConfigSchema, AgentHostConfigKey.UnifiedUserCustomizations) === true;
	}

	override dispose(): void {
		this._disposed = true;
		super.dispose();
	}
}
