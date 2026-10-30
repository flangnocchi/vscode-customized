/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { language } from '../../../../base/common/platform.js';
import { join } from '../../../../base/common/path.js';
import { toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { NativeCliAgentId } from '../../common/nativeCliAgentConfig.js';
import type { INativeCliLaunch } from './nativeCliTransport.js';

/** SDK extensions stay inside the owning child process, never in installed SDK files. */
export const dshRuntimeObserver = String.raw`
import { writeFile } from 'node:fs/promises';
export const name = 'vscode-runtime-observer';
export async function snapshot(ctx, cwd, agent) {
	const skillRegistry = ctx.get('skills');
	const skills = skillRegistry ? await skillRegistry.snapshot({ cwd, scope: agent }) : { skills: [], complete: true };
	const instructions = [], plugins = [];
	for (const entry of ctx.loader.entries()) {
		if (entry.options.group || entry.moduleNamespace?.name === name) continue;
		const enabled = !entry.disabled;
		plugins.push({ id: entry.id, name: entry.options.name, enabled, status: !enabled ? 'disabled' : entry.fiber?.state === 2 ? 'loaded' : entry.fiber?.state === 3 ? 'error' : 'loading' });
		if (entry.disabled || !entry.fiber || entry.options.name !== '@deepseek-ai/dsh-agent-instructions') continue;
		const discover = entry.moduleNamespace?.discoverBaselineInstructionFiles;
		if (typeof discover !== 'function') continue;
		const config = entry.options.config ?? {};
		instructions.push(...await discover({ cwd, projectRootMarkers: config.projectRootMarkers,
			instructionFileCandidates: config.instructionFileCandidates, localInstructionFileCandidates: config.localInstructionFileCandidates }));
	}
	const registry = ctx.get('tools'), mode = registry?.modeFor(agent);
	const tools = (registry?.schemas(agent) ?? []).map(tool => ({ name: tool.name, description: tool.description,
		loading: mode === 'ptc' && tool.name !== 'run_code' ? 'binding' : tool.deferLoading ? 'deferred' : 'eager',
		source: tool.name.startsWith('mcp__') ? 'mcp' : 'builtin' }));
	const presets = ctx.get('permissionPresets'), catalog = presets?.catalog();
	const permissions = catalog ? { options: catalog.options.map(p => ({ id: p.value, name: p.name, description: p.description })), defaultMode: catalog.defaultPreset } : undefined;
	return { ...skills, instructions, tools, plugins, permissions, scope: agent ? 'chat' : 'workspace' };
}
export function apply(ctx) {
	setImmediate(async () => {
		await ctx.get('loader')?.await();
		if (process.env.VSCODE_NATIVE_INVENTORY_RESULT) {
			try { await writeFile(process.env.VSCODE_NATIVE_INVENTORY_RESULT, JSON.stringify(await snapshot(ctx, process.env.VSCODE_NATIVE_INVENTORY_CWD)), { mode: 0o600 }); }
			catch { await writeFile(process.env.VSCODE_NATIVE_INVENTORY_RESULT, JSON.stringify({ complete: false }), { mode: 0o600 }); }
			process.stderr.write('VSCODE_NATIVE_INVENTORY_READY\n');
			return;
		}
		const entry = [...ctx.loader.entries()].find(e => e.options.name === '@deepseek-ai/dsh-sdk-jsonrpc-server');
		const Server = entry?.moduleNamespace?.HarnessSdkJsonRpcServer;
		if (!Server || typeof Server.prototype.handleRequest !== 'function') return;
		const original = Server.prototype.handleRequest;
		Server.prototype.handleRequest = async function(method, params) {
			if (!this.vscodeInventoryObserver) {
				this.vscodeInventoryObserver = true;
				try {
					this.disposers.push(ctx.on('tools/change', () => {
						for (const sessionId of this.sessions.keys()) this.transport.notify('vscode/runtimeInventoryChanged', { sessionId });
					}));
					// The SDK's approval request names the tool call and why it needs a decision. It carries no tool input: the
					// client already has that from the call's own event, and must not have it replaced.
					this.disposers.push(ctx.on('approval/request', async req => {
						if (this.sessions.size !== 1 || typeof req.callId !== 'string') return 'unavailable';
						const sessionId = this.sessions.keys().next().value;
						const display = req.displayReason;
						const reason = typeof display === 'string' ? display : display?.[(process.env.VSCODE_NATIVE_UI_LANGUAGE ?? 'en').startsWith('zh') ? 'zh' : 'en'] ?? req.reason;
						const result = await this.transport.request('approval/request', { sessionId, toolCallId: req.callId, toolName: req.toolName, reason }, req.signal);
						return ['allowed-once', 'rejected', 'cancelled', 'unavailable'].includes(result?.outcome) ? result.outcome : 'unavailable';
					}));
				} catch { /* A changed SDK keeps working without live inventory and relayed approvals; the SDK then refuses what needs approval. */ }
			}
			if (method !== 'vscode/runtimeInventory' && method !== 'vscode/setPermissionMode') return original.call(this, method, params);
			const session = this.sessions.get(params.sessionId);
			if (!session) throw new Error('Unknown native session');
			const agent = session.handle.agent;
			if (method === 'vscode/setPermissionMode') {
				const presets = ctx.get('permissionPresets');
				if (!presets) throw new Error('Native permission presets are unavailable');
				presets.set(agent.session, params.mode);
				return { mode: presets.current(agent.session) };
			}
			return snapshot(ctx, this.cwd, agent);
		};
		ctx.effect(() => () => { Server.prototype.handleRequest = original; });
	});
}
`;

// ZCode does not expose its model-facing tool registry over stdio. This bounded
// CommonJS extension adds inventory and exact-chat permission methods to supported dispatchers.
// It retains the original filename/resolution and fails closed on changed SDKs.
const zcodeRuntimeObserver = String.raw`
const Module = require('node:module');
const original = Module.prototype._compile;
Module.prototype._compile = function(source, filename) {
	if (filename === process.env.VSCODE_ZCODE_OBSERVER_TARGET) {
		// The dispatcher is the one method that switches on request.method and answers runtime/capabilities. Newer
		// builds answer it inline; older ones parse its params first, which is where the request name was read from.
		const dispatchers = [...source.matchAll(/async dispatchRequest\(([\w$]+)\)\{switch\(\1\.method\)\{/g)]
			.filter(candidate => { const capability = source.indexOf('.runtimeCapabilities:', candidate.index); return capability !== -1 && capability - candidate.index < 65536; });
		const legacy = [...source.matchAll(/case ([\w$]+)\.runtimeCapabilities:\{let [\w$]+=[\w$]+\.parse\(([\w$]+)\.params\?\?\{\}\);/g)];
		const found = dispatchers.length ? dispatchers : legacy;
		if (found.length !== 1) { Module.prototype._compile = original; return original.call(this, source, filename); }
		const insertAt = dispatchers.length ? found[0].index + found[0][0].length : found[0].index;
		const request = dispatchers.length ? found[0][1] : found[0][2];
		const modeSchemas = [...source.matchAll(/\b[\w$]+=[\w$]+\.object\(\{sessionId:[\w$]+,mode:(?<mode>[\w$]+),expectedRevision:/g)];
		const permissionModes = modeSchemas.length === 1 ? modeSchemas[0].groups.mode + '.options' : '[]';
		const extension = "case 'vscode/setPermissionMode': {const params=" + request + ".params;" +
			"const session=this.context.sessions.get(params.sessionId);if(!session)throw new Error('Unknown native session');" +
			"if(!" + permissionModes + ".includes(params.mode))throw new Error('Unknown native permission mode');" +
			"const runtime=session.app.runtime;await runtime.setExecutionState({mode:params.mode,planEnabled:params.mode==='plan'},runtime.rootTraceContext);return {mode:runtime.getPlanEnabled?.()?'plan':runtime.getMode()};}" +
			"case 'vscode/runtimeInventory': {" +
			"const params=" + request + ".params; const session=this.context.sessions.get(params.sessionId);" +
			"if(!session)throw new Error('Unknown native session');" +
			"const skills=await session.app.getSkillCatalog(); const runtime=session.app.runtime;" +
			"if(runtime.mcpStartupPromise)await Promise.race([Promise.resolve(runtime.mcpStartupPromise).catch(()=>{}),new Promise(r=>setTimeout(r,params.waitForTools?5000:350))]);" +
			"await runtime.refreshMcpToolsIfChanged?.();" +
			"if(!runtime.vscodeInventoryObserver){const context=this.context;let revision=runtime.mcpPort?.toolListRevision?.();" +
			"const timer=setInterval(()=>{const next=runtime.mcpPort?.toolListRevision?.();if(next!==revision){revision=next;context.notify({method:'vscode/runtimeInventoryChanged',params:{sessionId:params.sessionId}})}},1000);timer.unref();runtime.vscodeInventoryObserver=timer;}" +
			"const selection=params.modelSelection??runtime.getSessionModelSelection()??runtime.config.modelSelection;" +
			"const model=selection?runtime.modelFactory({selection}):undefined;" +
			"const mcpNames=new Set(runtime.registeredMcpToolNames??[]);" +
			"const mcpTools=runtime.mcpPort?await runtime.mcpPort.listTools():[];const mcpSources=new Map(mcpTools.map(t=>[t.name,t.serverName]));" +
			"const tools=runtime.getTools(model).map(t=>({name:t.name,description:t.description," +
			"loading:t.deferLoading?'deferred':'eager',source:mcpNames.has(t.name)?'mcp':'builtin',...(mcpSources.has(t.name)?{sourceName:mcpSources.get(t.name)}:{})}));" +
			"const agents=runtime.getAgentDefinitions?.().activeAgents??[];" +
			"const mcpServers=runtime.mcpPort?await runtime.mcpPort.status():{};" +
			"const userInstructions=runtime.contextSourceSnapshot?.userInstructions;" +
			"const instructions=[...(userInstructions?.sources??[]),userInstructions].filter(s=>typeof s?.filePath==='string').map(s=>({absolutePath:s.filePath}));" +
			"return {complete:true,scope:'chat',skills:skills.skills,tools,agents,mcpServers,instructions,permissions:{options:" + permissionModes + ".map(id=>({id,name:id})),defaultMode:runtime.getPlanEnabled?.()?'plan':runtime.getMode()}}; }";
		source = source.slice(0, insertAt) + extension + source.slice(insertAt);
		Module.prototype._compile = original;
	}
	return original.call(this, source, filename);
};
`;

export interface INativeCliObservedLaunch extends IDisposable {
	readonly launch: INativeCliLaunch;
}

const dshProfile = /^--profile(?:=|$)/;
const zcodeEntry = /(?:^|[/\\])zcode\.cjs$/;

/** Only the DSH profile server and ZCode's CommonJS entry can be extended; any other CLI is launched untouched. */
export function canObserveNativeCliRuntime(launch: INativeCliLaunch): boolean {
	return launch.args.some(arg => dshProfile.test(arg) || zcodeEntry.test(arg));
}

/** Owns an observation extension for exactly as long as its native child. */
export async function observeNativeCliRuntime(id: NativeCliAgentId, launch: INativeCliLaunch): Promise<INativeCliObservedLaunch> {
	const temporary = await fs.mkdtemp(join(tmpdir(), 'vscode-native-runtime-'));
	try {
		const script = join(temporary, id === 'dsh' ? 'observer.mjs' : 'observer.cjs');
		await fs.writeFile(script, id === 'dsh' ? dshRuntimeObserver : zcodeRuntimeObserver, { mode: 0o600 });
		let observed: INativeCliLaunch;
		if (id === 'dsh') {
			const patch = join(temporary, 'observer.yml');
			const entries = [{ id: 'vscode-runtime-observer', name: script }];
			await fs.writeFile(patch, `- insert: ${JSON.stringify(entries)}\n`, { mode: 0o600 });
			observed = { ...launch, args: [...launch.args, '--patch', patch], env: { ...launch.env, VSCODE_NATIVE_UI_LANGUAGE: language } };
		} else {
			const target = launch.args.find(arg => zcodeEntry.test(arg));
			// Custom executables may implement the extension themselves. Do not
			// rewrite arbitrary scripts or add unsupported flags to other CLIs.
			observed = target ? { ...launch, args: ['--require', script, ...launch.args], env: { ...launch.env, VSCODE_ZCODE_OBSERVER_TARGET: await fs.realpath(target) } } : launch;
		}
		const cleanup = toDisposable(() => { void fs.rm(temporary, { recursive: true, force: true }); });
		return { launch: observed, dispose: () => cleanup.dispose() };
	} catch (error) {
		await fs.rm(temporary, { recursive: true, force: true });
		throw error;
	}
}
