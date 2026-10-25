/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IConfigurationService } from '../../configuration/common/configuration.js';

export const nativeCliAgentIds = ['dsh', 'zcode'] as const;
export type NativeCliAgentId = typeof nativeCliAgentIds[number];
export const nativeCliAgentEnv = 'VSCODE_AGENT_HOST_NATIVE_CLI_AGENTS';

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
