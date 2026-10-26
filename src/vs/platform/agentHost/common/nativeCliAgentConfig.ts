/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IConfigurationService } from '../../configuration/common/configuration.js';

export const nativeCliAgentIds = ['dsh', 'zcode'] as const;
export type NativeCliAgentId = typeof nativeCliAgentIds[number];
export const nativeCliAgentEnv = 'VSCODE_AGENT_HOST_NATIVE_CLI_AGENTS';

/** The config property that holds a chat's native permission mode. Each provider owns its own mode vocabulary, including while a draft switches harness. */
export function nativeCliPermissionModeKey(id: NativeCliAgentId): string {
	return `${id}.permissionMode`;
}

/** Whether `property` is the native permission mode of a provider. */
export function isNativeCliPermissionProperty(property: string): boolean {
	return nativeCliAgentIds.some(id => property === nativeCliPermissionModeKey(id));
}

/** The mode of each provider that approves every action without asking. */
const nativeCliFullAccessModes: Readonly<Record<NativeCliAgentId, string>> = { dsh: 'danger-full-access', zcode: 'yolo' };

/** Whether `value` selects, for the native permission property `property`, the mode that approves every action without asking. */
export function isNativeCliFullAccessMode(property: string, value: unknown): boolean {
	return nativeCliAgentIds.some(id => property === nativeCliPermissionModeKey(id) && value === nativeCliFullAccessModes[id]);
}

export interface INativeCliModel {
	readonly id: string;
	readonly name: string;
}

export interface INativeCliAgentConfig {
	readonly enabled: boolean;
	readonly executable: string;
	readonly args: readonly string[];
	readonly home: string;
	readonly models: readonly INativeCliModel[];
}

/** Settings are forwarded only to the executing local host, without shell interpolation. */
export function buildNativeCliAgentEnv(configuration: IConfigurationService, inherited: Readonly<Record<string, string | undefined>>): Record<string, string> {
	if (inherited[nativeCliAgentEnv] !== undefined) {
		return {};
	}
	const configs = Object.fromEntries(nativeCliAgentIds.map(id => {
		const prefix = `chat.agentHost.${id}Agent`;
		return [id, {
			enabled: configuration.getValue<boolean>(`${prefix}.enabled`) === true,
			executable: configuration.getValue<string>(`${prefix}.executable`) ?? '',
			args: configuration.getValue<string[]>(`${prefix}.args`) ?? [],
			home: configuration.getValue<string>(`${prefix}.home`) ?? '',
			models: configuration.getValue<INativeCliModel[]>(`${prefix}.models`) ?? [],
		} satisfies INativeCliAgentConfig];
	}));
	return { [nativeCliAgentEnv]: JSON.stringify(configs) };
}
