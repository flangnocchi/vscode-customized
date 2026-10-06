/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import type { JsonValue } from './protocol/generated/serde_json/JsonValue.js';
import type { Config } from './protocol/generated/v2/Config.js';
import type { SkillsListResponse } from './protocol/generated/v2/SkillsListResponse.js';
import type { ICodexMcpServerConfigJson } from './codexMcpServers.js';

function jsonObject(value: JsonValue | undefined): { [key: string]: JsonValue | undefined } {
	return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export interface ICodexUnifiedUserCustomizationProjection {
	readonly overrides: Record<string, JsonValue>;
	readonly mcpServerAliases: ReadonlyMap<string, string>;
}

/** A bounded SDK name keeps shared transport fields out of native configuration tables. */
export function codexSharedMcpServerName(name: string): string {
	return `vscode_shared_${createHash('sha256').update(name).digest('hex').slice(0, 20)}`;
}

/** Thread overrides retain private MCP and reserve shared names, including disabled shared servers. */
export function codexUnifiedUserCustomizationOverrides(config: Config, skills: SkillsListResponse, mcpServers: Readonly<Record<string, ICodexMcpServerConfigJson>>, managedMcpServers: Readonly<Record<string, ICodexMcpServerConfigJson>> = mcpServers): ICodexUnifiedUserCustomizationProjection {
	const nativeMcp = jsonObject(config.mcp_servers);
	const servers: Record<string, JsonValue> = {};
	const aliases = new Map<string, string>();
	const reserved = new Set([...Object.keys(nativeMcp), ...Object.keys(managedMcpServers), ...Object.keys(mcpServers)]);
	for (const [name, server] of Object.entries({ ...managedMcpServers, ...mcpServers })) {
		const base = codexSharedMcpServerName(name);
		let alias = base;
		for (let suffix = 1; reserved.has(alias); suffix++) {
			alias = `${base}_${suffix}`;
		}
		reserved.add(alias);
		aliases.set(name, alias);
		if (Object.hasOwn(nativeMcp, name)) {
			servers[name] = { enabled: false };
		}
		const { args, ...transport } = server;
		servers[alias] = { ...transport, ...(args ? { args: [...args] } : {}), enabled: Object.hasOwn(mcpServers, name) };
	}
	const skillConfig = jsonObject(config.skills);
	const nativeUserPaths = new Set(skills.data.flatMap(entry => entry.skills.filter(skill => skill.scope === 'user').map(skill => skill.path)));
	const retained = Array.isArray(skillConfig.config) ? skillConfig.config.filter(entry => !nativeUserPaths.has(String(jsonObject(entry).path))) : [];
	return {
		overrides: {
			mcp_servers: servers,
			skills: { ...skillConfig, config: [...retained, ...[...nativeUserPaths].map(path => ({ path, enabled: false }))] },
		},
		mcpServerAliases: aliases,
	};
}
