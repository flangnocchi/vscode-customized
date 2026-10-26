/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { CancellationError } from '../../../../base/common/errors.js';
import { basename, dirname, isAbsolute, join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import type { NativeCliAgentId } from '../../common/nativeCliAgentConfig.js';
import { AGENT_BUILTIN_CUSTOMIZATION_SCHEME } from '../../common/agentHostCustomizationUri.js';
import { withRuntimeManagedCustomization, withRuntimePlugins, withRuntimeToolInventory, type IRuntimePlugin, type IRuntimeTool } from '../../common/meta/runtimeToolInventory.js';
import { withMcpServerSourceMeta } from '../../common/meta/mcpCustomizationMeta.js';
import { CustomizationEnablementKind, McpServerStatus } from '../../common/state/protocol/state.js';
import { CustomizationLoadStatus, CustomizationType, customizationId, type AgentCustomization, type Customization, type DirectoryCustomization, type HookCustomization, type McpServerCustomization, type RuleCustomization, type SkillCustomization } from '../../common/state/sessionState.js';
import { NativeCliTransport, record, type INativeCliLaunch, type NativeRecord } from './nativeCliTransport.js';
import { canObserveNativeCliRuntime, dshRuntimeObserver, observeNativeCliRuntime } from './nativeCliRuntime.js';
import { isolatedZcodeEnvironment, zcodeRuntimePreferences } from './nativeCliModelCatalog.js';

/** Maps native metadata only. No foreign harness directories or file contents are scanned. */
export function nativeCliCustomizations(id: NativeCliAgentId, snapshot: NativeRecord): readonly Customization[] {
	if (snapshot.complete === false) { throw new Error(localize('nativeCli.incompleteCustomizations', "Native customization discovery is incomplete.")); }
	const directories = new Map<string, DirectoryCustomization>();
	const seen = new Set<string>();
	const add = (child: SkillCustomization | RuleCustomization | AgentCustomization | HookCustomization, parent: URI): void => {
		if (seen.has(child.id)) { return; }
		seen.add(child.id);
		const key = `${child.type}:${parent.toString()}`;
		let directory = directories.get(key);
		if (!directory) {
			directory = { type: CustomizationType.Directory, id: customizationId(key), uri: parent.toString(), name: basename(parent.path), contents: child.type, enabled: true, writable: false, load: { kind: CustomizationLoadStatus.Loaded }, children: [] };
			directories.set(key, directory);
		}
		directory.children!.push(child);
	};
	for (const raw of Array.isArray(snapshot.skills) ? snapshot.skills : []) {
		const skill = record(raw);
		if (typeof skill.name !== 'string' || !skill.name || skill.enabled === false) { continue; }
		const uri = typeof skill.path === 'string' && isAbsolute(skill.path) ? URI.file(skill.path) : URI.from({ scheme: AGENT_BUILTIN_CUSTOMIZATION_SCHEME, authority: id, path: `/skills/${encodeURIComponent(skill.name)}` });
		const invocation = record(skill.invocation);
		add({ type: CustomizationType.Skill, id: customizationId(uri.toString()), uri: uri.toString(), name: skill.name, description: typeof skill.description === 'string' ? skill.description : undefined, disableModelInvocation: invocation.modelInvocable === false, disableUserInvocation: invocation.userInvocable === false }, uri.with({ path: dirname(uri.path) }));
	}
	for (const raw of Array.isArray(snapshot.instructions) ? snapshot.instructions : []) {
		const instruction = record(raw);
		if (typeof instruction.absolutePath !== 'string' || !isAbsolute(instruction.absolutePath)) { continue; }
		const uri = URI.file(instruction.absolutePath);
		add({ type: CustomizationType.Rule, id: customizationId(uri.toString()), uri: uri.toString(), name: basename(uri.path), alwaysApply: true }, URI.file(dirname(instruction.absolutePath)));
	}
	for (const raw of Array.isArray(snapshot.agents) ? snapshot.agents : []) {
		const agent = record(raw);
		if (typeof agent.name !== 'string') { continue; }
		const uri = typeof agent.path === 'string' && isAbsolute(agent.path) ? URI.file(agent.path) : URI.from({ scheme: AGENT_BUILTIN_CUSTOMIZATION_SCHEME, authority: id, path: `/agents/${encodeURIComponent(agent.name)}` });
		add({ type: CustomizationType.Agent, id: customizationId(uri.toString()), uri: uri.toString(), name: agent.name, description: typeof agent.description === 'string' ? agent.description : undefined, disableUserInvocation: true }, uri.with({ path: dirname(uri.path) }));
	}
	const hooks: NativeRecord[] = (Array.isArray(snapshot.hooks) ? snapshot.hooks : []).map(record);
	for (const raw of Array.isArray(snapshot.plugins) ? snapshot.plugins : []) {
		const plugin = record(raw);
		if (plugin.enabled === false) { continue; }
		for (const value of Array.isArray(plugin.hookDetails) ? plugin.hookDetails : []) {
			const hook = record(value);
			if (hook.runnable === true) { hooks.push({ path: hook.sourcePath }); }
		}
	}
	for (const raw of hooks) {
		const hook = record(raw);
		if (typeof hook.path !== 'string' || !isAbsolute(hook.path)) { continue; }
		const uri = URI.file(hook.path);
		add({ type: CustomizationType.Hook, id: customizationId(uri.toString()), uri: uri.toString(), name: typeof hook.name === 'string' ? hook.name : basename(hook.path) }, URI.file(dirname(hook.path)));
	}
	if (Array.isArray(snapshot.tools)) {
		const tools: IRuntimeTool[] = [];
		for (const value of snapshot.tools) {
			const tool = record(value);
			if (typeof tool.name !== 'string' || !tool.name) { continue; }
			tools.push({ name: tool.name, description: typeof tool.description === 'string' ? tool.description : undefined, loading: tool.loading === 'deferred' || tool.loading === 'binding' || tool.loading === 'unavailable' ? tool.loading : 'eager', source: tool.source === 'mcp' || tool.source === 'vscode' ? tool.source : 'builtin', sourceName: typeof tool.sourceName === 'string' ? tool.sourceName : undefined });
		}
		const uri = URI.from({ scheme: AGENT_BUILTIN_CUSTOMIZATION_SCHEME, authority: id, path: '/runtime-tools' }).toString();
		directories.set('runtime-tools', { type: CustomizationType.Directory, id: customizationId(uri), uri, name: 'runtime-tools', enabled: true, writable: false, contents: CustomizationType.Skill, children: [], load: { kind: CustomizationLoadStatus.Loaded }, _meta: withRuntimeToolInventory(undefined, { provider: id, label: id === 'dsh' ? localize('nativeCli.dshLabel', "DeepSeek Harness") : localize('nativeCli.zcodeLabel', "ZCode"), scope: snapshot.scope === 'chat' ? 'chat' : 'workspace', state: snapshot.toolsState === 'unavailable' ? 'unavailable' : 'ready', tools }) });
	}
	if (Array.isArray(snapshot.plugins)) {
		const plugins: IRuntimePlugin[] = [];
		for (const raw of snapshot.plugins) {
			const plugin = record(raw);
			if (typeof plugin.name !== 'string') { continue; }
			plugins.push({ id: `${id}:${String(plugin.id ?? plugin.name)}`, name: plugin.name, version: typeof plugin.version === 'string' ? plugin.version : undefined, enabled: plugin.enabled !== false, status: plugin.enabled === false ? 'disabled' : plugin.status === 'error' || plugin.status === 'loading' ? plugin.status : 'loaded' });
		}
		const uri = URI.from({ scheme: AGENT_BUILTIN_CUSTOMIZATION_SCHEME, authority: id, path: '/runtime-plugins' }).toString();
		directories.set('runtime-plugins', { type: CustomizationType.Directory, id: customizationId(uri), uri, name: 'runtime-plugins', enabled: true, writable: false, contents: CustomizationType.Skill, children: [], load: { kind: CustomizationLoadStatus.Loaded }, _meta: withRuntimePlugins(undefined, plugins) });
	}
	const servers: McpServerCustomization[] = [];
	for (const [name, raw] of Object.entries(record(snapshot.mcpServers))) {
		const server = record(raw);
		const uri = URI.from({ scheme: AGENT_BUILTIN_CUSTOMIZATION_SCHEME, authority: id, path: `/mcp/${encodeURIComponent(name)}` }).toString();
		servers.push({ type: CustomizationType.McpServer, id: customizationId(uri), uri, name,
			...(server.status === 'disabled' ? { enablement: [{ kind: CustomizationEnablementKind.Global, enabled: false }] } : {}),
			state: server.status === 'connected' ? { kind: McpServerStatus.Ready } : server.status === 'connecting' ? { kind: McpServerStatus.Starting } : server.status === 'error' ? { kind: McpServerStatus.Error, error: { errorType: 'nativeMcpUnavailable', message: localize('nativeCli.mcpUnavailable', "The native runtime has not connected this server.") } } : { kind: McpServerStatus.Stopped },
			_meta: withMcpServerSourceMeta(withRuntimeManagedCustomization(undefined), 'managed'),
		});
	}
	return [...directories.values(), ...servers];
}

async function readDshCustomizations(launch: INativeCliLaunch, signal: AbortSignal): Promise<NativeRecord> {
	if (signal.aborted) { throw new CancellationError(); }
	// Any other launch is the user's own command line, which is never extended with the observer.
	if (!canObserveNativeCliRuntime(launch)) { return { complete: true, scope: 'workspace', tools: [], toolsState: 'unavailable' }; }
	const temporary = await fs.mkdtemp(join(tmpdir(), 'vscode-dsh-customizations-'));
	try {
		const plugin = join(temporary, 'inventory.mjs');
		const patch = join(temporary, 'inventory.yml');
		const result = join(temporary, 'result.json');
		await fs.writeFile(plugin, dshRuntimeObserver, { mode: 0o600 });
		await fs.writeFile(patch, `- insert:\n    - id: vscode-customization-inventory\n      name: ${JSON.stringify(plugin)}\n`, { mode: 0o600 });
		await new Promise<void>((resolve, reject) => {
			const child = execFile(launch.executable, [...launch.args, '--patch', patch], { cwd: launch.cwd, env: { ...launch.env, VSCODE_NATIVE_INVENTORY_CWD: launch.cwd, VSCODE_NATIVE_INVENTORY_RESULT: result }, signal, windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, error => error ? reject(Object.assign(new Error(localize('nativeCli.customizationsUnavailable', "Could not read native customizations.")), { code: error.code, signal: error.signal, killed: error.killed })) : resolve());
			// Drain diagnostics without logging config, credentials or native parser errors.
			let marker = '';
			child.stderr?.on('data', (chunk: Buffer) => {
				marker = (marker + chunk.toString()).slice(-256);
				if (marker.includes('VSCODE_NATIVE_INVENTORY_READY')) { child.stdin?.end(); }
			});
			child.stdin?.on('error', () => { /* Process exit is handled by execFile. */ });
		});
		if (signal.aborted) { throw new CancellationError(); }
		if ((await fs.stat(result)).size > 4 * 1024 * 1024) { throw new Error('Native customization inventory exceeded its size limit'); }
		return record(JSON.parse(await fs.readFile(result, 'utf8')));
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
}

/** Inspects a disposable ZCode session in an isolated home, without model requests. */
async function readZcodeCustomizations(launch: INativeCliLaunch, signal: AbortSignal, modelSelection?: NativeRecord): Promise<NativeRecord> {
	if (signal.aborted) { throw new CancellationError(); }
	const temporary = await fs.mkdtemp(join(tmpdir(), 'vscode-zcode-inventory-'));
	let connection: NativeCliTransport | undefined;
	let observer: Awaited<ReturnType<typeof observeNativeCliRuntime>> | undefined;
	try {
		const env = await isolatedZcodeEnvironment(launch, temporary);
		observer = await observeNativeCliRuntime('zcode', { ...launch, env });
		connection = new NativeCliTransport(observer.launch);
		const transport = connection;
		transport.onRequest = async method => {
			if (method === 'session/requestRuntimePreferences') { return zcodeRuntimePreferences(); }
			if (method === 'interaction/requestProviderRuntimeHeaders') { return { headersApplied: false }; }
			throw new Error('Unsupported native inventory request');
		};
		const abort = () => { void transport.shutdown(); };
		signal.addEventListener('abort', abort, { once: true });
		try {
			if (signal.aborted) { throw new CancellationError(); }
			await transport.request('runtime/capabilities', {}, 15_000);
			const workspace = { workspacePath: launch.cwd, workspaceKey: launch.cwd };
			const skills = record(await transport.request('skills/referenceCatalog', { workspace }, 15_000));
			// A custom CLI can supply workspace metadata without the bundled observer.
			if (!observer.launch.env.VSCODE_ZCODE_OBSERVER_TARGET) { return skills; }
			const sessionId = `sess_${generateUuid()}`;
			await transport.request('session/create', { sessionId, workspace, mode: 'build' }, 15_000);
			let snapshot: NativeRecord;
			try { snapshot = record(await transport.request('vscode/runtimeInventory', { sessionId, waitForTools: true, ...(modelSelection ? { modelSelection } : {}) }, 15_000)); }
			catch { snapshot = { ...skills, tools: [], toolsState: 'unavailable' }; }
			const plugins = record(await transport.request('plugins/list', { workspace }, 15_000));
			return { ...snapshot, scope: 'workspace', plugins: plugins.plugins };
		} finally {
			signal.removeEventListener('abort', abort);
		}
	} finally {
		await connection?.shutdown();
		connection?.dispose();
		observer?.dispose();
		await fs.rm(temporary, { recursive: true, force: true });
	}
}

export async function discoverNativeCliCustomizations(id: NativeCliAgentId, launch: INativeCliLaunch, signal: AbortSignal, modelSelection?: NativeRecord): Promise<readonly Customization[]> {
	return nativeCliCustomizations(id, await discoverNativeCliRuntimeSnapshot(id, launch, signal, modelSelection));
}

/** Reads metadata in a disposable runtime, without claiming a chat backing. */
export async function discoverNativeCliRuntimeSnapshot(id: NativeCliAgentId, launch: INativeCliLaunch, signal: AbortSignal, modelSelection?: NativeRecord): Promise<NativeRecord> {
	return id === 'dsh' ? readDshCustomizations(launch, signal) : readZcodeCustomizations(launch, signal, modelSelection);
}
