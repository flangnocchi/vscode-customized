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
import { localize } from '../../../../nls.js';
import type { NativeCliAgentId } from '../../common/nativeCliAgentConfig.js';
import { AGENT_BUILTIN_CUSTOMIZATION_SCHEME } from '../../common/agentHostCustomizationUri.js';
import { CustomizationLoadStatus, CustomizationType, customizationId, type Customization, type DirectoryCustomization, type RuleCustomization, type SkillCustomization } from '../../common/state/sessionState.js';
import { NativeCliTransport, record, type INativeCliLaunch, type NativeRecord } from './nativeCliTransport.js';

// This observation-only plugin lives in a private temporary directory. It neither
// installs a profile bundle nor initializes, resumes, or prompts a conversation.
// The native registry retains authority over validation, precedence and symlinks.
const dshInventoryPlugin = String.raw`
import { writeFile } from 'node:fs/promises';
export const name = 'vscode-customization-inventory';
export function apply(ctx) {
 setImmediate(async () => {
  try {
   await ctx.get('loader')?.await();
   const cwd = process.env.VSCODE_NATIVE_INVENTORY_CWD;
   const registry = ctx.get('skills');
   const snapshot = registry ? await registry.snapshot({ cwd }) : { skills: [], complete: true };
   const instructions = [];
   for (const entry of ctx.loader.entries()) {
    if (entry.disabled || !entry.fiber || entry.options.name !== '@deepseek-ai/dsh-agent-instructions') continue;
    const discover = entry.moduleNamespace?.discoverBaselineInstructionFiles;
    if (typeof discover !== 'function') throw new Error('Instruction discovery unavailable');
    const config = entry.options.config ?? {};
    instructions.push(...await discover({ cwd,
     projectRootMarkers: config.projectRootMarkers,
     instructionFileCandidates: config.instructionFileCandidates,
     localInstructionFileCandidates: config.localInstructionFileCandidates }));
   }
   await writeFile(process.env.VSCODE_NATIVE_INVENTORY_RESULT, JSON.stringify({ ...snapshot, instructions }), { mode: 0o600 });
  } catch {
   await writeFile(process.env.VSCODE_NATIVE_INVENTORY_RESULT, JSON.stringify({ complete: false }), { mode: 0o600 });
  }
  process.stderr.write('VSCODE_NATIVE_INVENTORY_READY\n');
 });
}
`;

/** Maps native metadata only. No foreign harness directories or file contents are scanned. */
export function nativeCliCustomizations(id: NativeCliAgentId, snapshot: NativeRecord): readonly Customization[] {
	if (snapshot.complete === false) { throw new Error(localize('nativeCli.incompleteCustomizations', "Native customization discovery is incomplete.")); }
	const directories = new Map<string, DirectoryCustomization>();
	const seen = new Set<string>();
	const add = (child: SkillCustomization | RuleCustomization, parent: URI): void => {
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
	return [...directories.values()];
}

async function readDshCustomizations(launch: INativeCliLaunch, signal: AbortSignal): Promise<NativeRecord> {
	if (signal.aborted) { throw new CancellationError(); }
	const temporary = await fs.mkdtemp(join(tmpdir(), 'vscode-dsh-customizations-'));
	try {
		const plugin = join(temporary, 'inventory.mjs');
		const patch = join(temporary, 'inventory.yml');
		const result = join(temporary, 'result.json');
		await fs.writeFile(plugin, dshInventoryPlugin, { mode: 0o600 });
		await fs.writeFile(patch, `- insert:\n    - id: vscode-customization-inventory\n      name: ${JSON.stringify(plugin)}\n`, { mode: 0o600 });
		await new Promise<void>((resolve, reject) => {
			const child = execFile(launch.executable, [...launch.args, '--patch', patch], { cwd: launch.cwd, env: { ...launch.env, VSCODE_NATIVE_INVENTORY_CWD: launch.cwd, VSCODE_NATIVE_INVENTORY_RESULT: result }, signal, windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, error => error ? reject(new Error(localize('nativeCli.customizationsUnavailable', "Could not read native customizations."))) : resolve());
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

/** Workspace discovery methods need no ZCode session, model call or temporary conversation. */
async function readZcodeCustomizations(launch: INativeCliLaunch, signal: AbortSignal): Promise<NativeRecord> {
	if (signal.aborted) { throw new CancellationError(); }
	const connection = new NativeCliTransport(launch);
	const abort = () => { void connection.shutdown(); };
	signal.addEventListener('abort', abort, { once: true });
	try {
		await connection.request('runtime/capabilities', {}, 15_000);
		return record(await connection.request('skills/referenceCatalog', { workspace: { workspacePath: launch.cwd, workspaceKey: launch.cwd } }, 15_000));
	} finally {
		signal.removeEventListener('abort', abort);
		await connection.shutdown();
		connection.dispose();
	}
}

export async function discoverNativeCliCustomizations(id: NativeCliAgentId, launch: INativeCliLaunch, signal: AbortSignal): Promise<readonly Customization[]> {
	return nativeCliCustomizations(id, await (id === 'dsh' ? readDshCustomizations(launch, signal) : readZcodeCustomizations(launch, signal)));
}
