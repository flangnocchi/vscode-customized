/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const key = 'vscode.runtimeToolInventory';
const pluginsKey = 'vscode.runtimePluginInventory';
const managedKey = 'vscode.runtimeManagedCustomization';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An observed model-facing tool, rather than a tool installed in another runtime. */
export interface IRuntimeTool {
	readonly name: string;
	readonly description?: string;
	readonly loading: 'eager' | 'deferred' | 'binding' | 'unavailable';
	readonly source: 'builtin' | 'mcp' | 'vscode';
	readonly sourceName?: string;
}

/** A provider-owned observation; an absent inventory is distinct from an empty one. */
export interface IRuntimeToolInventory {
	readonly provider: string;
	readonly label: string;
	readonly scope: 'workspace' | 'chat';
	readonly state: 'ready' | 'unavailable';
	readonly tools: readonly IRuntimeTool[];
}

/** Native plugin metadata without implying support for Open Plugins mutations. */
export interface IRuntimePlugin {
	readonly id: string;
	readonly name: string;
	readonly version?: string;
	readonly enabled: boolean;
	readonly status: 'loaded' | 'loading' | 'error' | 'disabled';
}

export function readRuntimePlugins(resources: readonly { readonly _meta?: Record<string, unknown> }[]): readonly IRuntimePlugin[] {
	const plugins: IRuntimePlugin[] = [];
	for (const resource of resources) {
		const values = resource._meta?.[pluginsKey];
		if (!Array.isArray(values)) { continue; }
		for (const value of values) {
			if (isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string' && typeof value.enabled === 'boolean' && (value.status === 'loaded' || value.status === 'loading' || value.status === 'error' || value.status === 'disabled')) {
				plugins.push({ id: value.id, name: value.name, enabled: value.enabled, status: value.status, ...(typeof value.version === 'string' ? { version: value.version } : {}) });
			}
		}
	}
	return plugins;
}

export function withRuntimePlugins(meta: Record<string, unknown> | undefined, plugins: readonly IRuntimePlugin[]): Record<string, unknown> {
	return { ...meta, [pluginsKey]: plugins };
}

export function isRuntimeManagedCustomization(resource: { readonly _meta?: Record<string, unknown> }): boolean {
	return resource._meta?.[managedKey] === true;
}

export function withRuntimeManagedCustomization(meta: Record<string, unknown> | undefined): Record<string, unknown> {
	return { ...meta, [managedKey]: true };
}

/** Validates metadata received over the Agent Host connection. */
export function readRuntimeToolInventory(resources: readonly { readonly _meta?: Record<string, unknown> }[]): IRuntimeToolInventory | undefined {
	for (const resource of resources) {
		const value = resource._meta?.[key];
		if (!isRecord(value) || typeof value.provider !== 'string' || typeof value.label !== 'string' || (value.scope !== 'workspace' && value.scope !== 'chat') || (value.state !== 'ready' && value.state !== 'unavailable') || !Array.isArray(value.tools)) { continue; }
		const tools: IRuntimeTool[] = [];
		let valid = true;
		for (const tool of value.tools) {
			if (!isRecord(tool) || typeof tool.name !== 'string' || !tool.name || (tool.loading !== 'eager' && tool.loading !== 'deferred' && tool.loading !== 'binding' && tool.loading !== 'unavailable') || (tool.source !== 'builtin' && tool.source !== 'mcp' && tool.source !== 'vscode') || (tool.description !== undefined && typeof tool.description !== 'string') || (tool.sourceName !== undefined && typeof tool.sourceName !== 'string')) { valid = false; break; }
			tools.push({ name: tool.name, loading: tool.loading, source: tool.source, ...(typeof tool.description === 'string' ? { description: tool.description } : {}), ...(typeof tool.sourceName === 'string' ? { sourceName: tool.sourceName } : {}) });
		}
		if (valid) { return { provider: value.provider, label: value.label, scope: value.scope, state: value.state, tools }; }
	}
	return undefined;
}

export function withRuntimeToolInventory(meta: Record<string, unknown> | undefined, inventory: IRuntimeToolInventory): Record<string, unknown> {
	return { ...meta, [key]: inventory };
}
