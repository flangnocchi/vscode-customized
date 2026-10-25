/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import type { NativeCliAgentId } from '../../common/nativeCliAgentConfig.js';
import type { ResolveSessionConfigResult } from '../../common/state/protocol/commands.js';
import { record, type NativeRecord } from './nativeCliTransport.js';

export const nativeCliPermissionModeKey = 'nativeCli.permissionMode';

export interface INativeCliPermissions {
	readonly options: readonly { readonly id: string; readonly name: string; readonly description?: string }[];
	readonly defaultMode: string;
}

/** Only modes reported by the owning SDK become selectable. */
export function readNativeCliPermissions(value: NativeRecord): INativeCliPermissions | undefined {
	const catalog = record(value.permissions);
	if (!Array.isArray(catalog.options) || typeof catalog.defaultMode !== 'string') { return undefined; }
	const options: { id: string; name: string; description?: string }[] = [];
	for (const raw of catalog.options) {
		const option = record(raw);
		if (typeof option.id !== 'string' || !option.id || typeof option.name !== 'string') { return undefined; }
		options.push({ id: option.id, name: option.name, ...(typeof option.description === 'string' ? { description: option.description } : {}) });
	}
	return options.some(option => option.id === catalog.defaultMode) ? { options, defaultMode: catalog.defaultMode } : undefined;
}

function modeLabel(id: NativeCliAgentId, mode: string, fallback: string): string {
	switch (`${id}:${mode}`) {
		case 'dsh:read-only': return localize('nativeCli.permissions.readOnly', "Read Only");
		case 'dsh:workspace-write': return localize('nativeCli.permissions.workspace', "Workspace Access");
		case 'dsh:danger-full-access':
		case 'zcode:yolo': return localize('nativeCli.permissions.full', "Full Access");
		case 'zcode:build': return localize('nativeCli.permissions.default', "Default Permissions");
		case 'zcode:edit': return localize('nativeCli.permissions.edit', "Edit Automatically");
		case 'zcode:plan': return localize('nativeCli.permissions.plan', "Plan Mode");
		case 'zcode:guarded': return localize('nativeCli.permissions.guarded', "Guarded Mode");
		case 'zcode:auto': return localize('nativeCli.permissions.auto', "Auto Mode");
		default: return fallback;
	}
}

export function resolveNativeCliPermissionConfig(id: NativeCliAgentId, permissions: INativeCliPermissions | undefined, config?: NativeRecord): ResolveSessionConfigResult {
	if (!permissions) { return { schema: { type: 'object', properties: {} }, values: {} }; }
	const selected = config?.[nativeCliPermissionModeKey] ?? permissions.defaultMode;
	if (!permissions.options.some(option => option.id === selected)) { throw new Error(localize('nativeCli.permissions.invalid', "The native runtime does not offer this permission mode.")); }
	return {
		schema: { type: 'object', properties: { [nativeCliPermissionModeKey]: {
			type: 'string', title: localize('nativeCli.permissions.title', "Permissions"),
			description: localize('nativeCli.permissions.description', "Native permissions for this chat. Changes apply to the next turn."),
			enum: permissions.options.map(option => option.id), enumLabels: permissions.options.map(option => modeLabel(id, option.id, option.name)),
			enumDescriptions: permissions.options.map(option => option.description ?? modeLabel(id, option.id, option.name)),
			default: permissions.defaultMode, sessionMutable: true, chatMutable: true,
		} } }, values: { [nativeCliPermissionModeKey]: selected },
	};
}
