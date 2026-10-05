/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../../base/common/lifecycle.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { IAgentModelInfo, AgentProvider } from '../common/agent.js';
import { BYOK_DIRECT_PROVIDER_PREFIX, ByokLmDirectProtocol, getByokDirectModelSelectionId, IByokLmDirectConnection } from '../common/agentHostByokLm.js';
import { AgentHostByokModelsEnabledConfigKey, platformRootSchema } from '../common/agentHostSchema.js';
import { createAgentModelByokMeta } from '../common/agentModelByokMeta.js';
import { createAgentModelGroupMeta } from '../common/agentModelSource.js';
import { IAgentConfigurationService } from './agentConfigurationService.js';
import { IByokLmBridgeRegistry } from './byokLmBridgeRegistry.js';

export const IDirectLanguageModelService = createDecorator<IDirectLanguageModelService>('directLanguageModelService');

/** Direct connections retain the extension's model catalogue while leaving wire conversion to its gateway. */
export interface IDirectLanguageModelService {
	readonly _serviceBrand: undefined;
	onDidChangeModels(listener: () => void): IDisposable;
	getModels(protocol: ByokLmDirectProtocol, provider: AgentProvider): readonly IAgentModelInfo[];
	resolve(selectionId: string, protocol: ByokLmDirectProtocol): Promise<IByokLmDirectConnection>;
}

export function isDirectLanguageModelSelection(id: string): boolean {
	return id.startsWith(`@provider=${BYOK_DIRECT_PROVIDER_PREFIX}`);
}

export function validateDirectLanguageModelConnection(connection: IByokLmDirectConnection): IByokLmDirectConnection {
	let url: URL;
	try {
		url = new URL(connection.baseUrl);
	} catch {
		throw new Error('Invalid direct language model endpoint');
	}
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !connection.modelId || Object.entries(connection.headers ?? {}).some(([name, value]) => !/^[\w-]+$/.test(name) || typeof value !== 'string' || /[\r\n]/.test(value))) {
		throw new Error('Invalid direct language model connection');
	}
	return { ...connection, baseUrl: connection.baseUrl.replace(/\/+$/, '') };
}

export class DirectLanguageModelService implements IDirectLanguageModelService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IByokLmBridgeRegistry private readonly _registry: IByokLmBridgeRegistry,
		@IAgentConfigurationService private readonly _configuration: IAgentConfigurationService,
	) { }

	onDidChangeModels(listener: () => void): IDisposable {
		return this._registry.onDidChangeModels(listener);
	}

	private _enabled(): boolean {
		return this._configuration.getRootValue(platformRootSchema, AgentHostByokModelsEnabledConfigKey) === true;
	}

	getModels(protocol: ByokLmDirectProtocol, provider: AgentProvider): readonly IAgentModelInfo[] {
		return this._enabled() && this._registry.getServingConnection()?.resolveDirectConnection ? this._registry.getModels()
			.filter(model => model.modelIdentifier && model.directConnectionProtocols?.includes(protocol) && model.supportsToolCalling)
			.map(model => ({
				provider,
				id: getByokDirectModelSelectionId(model),
				name: model.name ?? model.id,
				maxContextWindow: model.maxContextWindowTokens,
				maxPromptTokens: model.maxPromptTokens,
				maxOutputTokens: model.maxOutputTokens,
				supportsVision: model.supportsVision ?? false,
				_meta: { ...createAgentModelGroupMeta(model.vendor), ...createAgentModelByokMeta(model.modelIdentifier) },
			})) : [];
	}

	async resolve(selectionId: string, protocol: ByokLmDirectProtocol): Promise<IByokLmDirectConnection> {
		const model = this._enabled() ? this._registry.getModels().find(model => getByokDirectModelSelectionId(model) === selectionId && model.directConnectionProtocols?.includes(protocol) && model.supportsToolCalling) : undefined;
		const connection = this._registry.getServingConnection();
		if (!model?.modelIdentifier || !connection?.resolveDirectConnection) {
			throw new Error('The selected direct language model is no longer available');
		}
		const resolved = validateDirectLanguageModelConnection(await connection.resolveDirectConnection({ modelIdentifier: model.modelIdentifier, protocol }));
		if (resolved.modelId !== model.id || !this._enabled() || connection !== this._registry.getServingConnection() || !this._registry.getModels().some(candidate => getByokDirectModelSelectionId(candidate) === selectionId && candidate.directConnectionProtocols?.includes(protocol) && candidate.supportsToolCalling)) {
			throw new Error('The selected direct language model changed while resolving its connection');
		}
		return resolved;
	}
}
