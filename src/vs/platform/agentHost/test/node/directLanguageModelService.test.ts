/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { getByokDirectModelSelectionId, IByokLmBridgeConnection, IByokLmDirectConnection, IByokLmModelInfo } from '../../common/agentHostByokLm.js';
import type { ConfigPropertySchema } from '../../common/state/protocol/state.js';
import { IAgentConfigurationService } from '../../node/agentConfigurationService.js';
import { ByokLmBridgeRegistry } from '../../node/byokLmBridgeRegistry.js';
import { DirectLanguageModelService, validateDirectLanguageModelConnection } from '../../node/directLanguageModelService.js';

suite('DirectLanguageModelService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const model: IByokLmModelInfo = {
		vendor: '9router', id: 'cp/model:1', modelIdentifier: '9router/Group 1/cp/model:1',
		name: 'Gateway model', supportsToolCalling: true, supportsVision: true,
		directConnectionProtocols: ['messages', 'responses'],
	};

	function setup(models: IByokLmModelInfo[] = [model], resolver: NonNullable<IByokLmBridgeConnection['resolveDirectConnection']> = async () => ({ baseUrl: 'http://localhost:20128/v1', modelId: model.id, headers: { Authorization: 'Bearer test-only' } })) {
		let enabled = true;
		const registry = new ByokLmBridgeRegistry();
		const emitter = store.add(new Emitter<IByokLmModelInfo[]>());
		const connection: IByokLmBridgeConnection = { chat: async () => ({ output: [] }), onDidChangeModels: emitter.event, resolveDirectConnection: resolver };
		const registration = store.add(registry.register('window', connection));
		emitter.fire(models);
		const configuration = new class extends mock<IAgentConfigurationService>() {
			override getRootValue<T>(): T { return enabled as T; }
		};
		return { service: new DirectLanguageModelService(registry, configuration), push: (models: IByokLmModelInfo[]) => emitter.fire(models), disable: () => { enabled = false; }, registration, connection };
	}

	test('publishes only opted-in tool-capable models for the requested protocol and never credentials', () => {
		const { service, disable } = setup([model, { ...model, modelIdentifier: 'no-tools', supportsToolCalling: false }, { ...model, modelIdentifier: 'no-opt-in', directConnectionProtocols: undefined }, { ...model, modelIdentifier: 'messages-only', directConnectionProtocols: ['messages'] }]);
		assert.strictEqual(service.getModels('messages', 'claude').length, 2);
		const published = service.getModels('responses', 'codex');
		assert.strictEqual(published.length, 1);
		assert.strictEqual(published[0].supportsVision, true);
		assert.ok(!JSON.stringify(published).includes('test-only'));
		disable();
		assert.deepStrictEqual(service.getModels('messages', 'claude'), []);
	});

	test('does not publish models on a reverse bridge without a direct resolver', async () => {
		const { service, connection } = setup();
		delete connection.resolveDirectConnection;
		assert.deepStrictEqual(service.getModels('messages', 'claude'), []);
		await assert.rejects(service.resolve(getByokDirectModelSelectionId(model), 'messages'), /no longer available/);
	});

	test('publishes advertised Responses efforts and their default as thinking levels', () => {
		const { service } = setup([{ ...model, supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'high' }]);
		const thinkingLevel = service.getModels('responses', 'codex')[0].configSchema?.properties.thinkingLevel;
		assert.deepStrictEqual({
			type: thinkingLevel?.type,
			enum: thinkingLevel?.enum,
			default: thinkingLevel?.default,
			labels: thinkingLevel?.enumLabels,
			messagesDefault: service.getModels('messages', 'claude')[0].configSchema?.properties.thinkingLevel.default,
		}, {
			type: 'string',
			enum: ['low', 'medium', 'high', 'xhigh', 'max'],
			default: 'high',
			labels: ['Low', 'Medium', 'High', 'Extra High', 'Max'],
			messagesDefault: 'high',
		});
	});

	test('Messages efforts honor the provider default and otherwise prefer Claude high', () => {
		const { service } = setup([
			{ ...model, supportedReasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'unsupported'], defaultReasoningEffort: 'medium' },
			{ ...model, supportedReasoningEfforts: ['low', 'medium', 'high'] },
			{ ...model, supportedReasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'ultra' },
			{ ...model, supportedReasoningEfforts: ['low'] },
			{ ...model, supportedReasoningEfforts: ['none', 'minimal', 'ultra'] },
		]);
		assert.deepStrictEqual(service.getModels('messages', 'claude').map(model => ({
			enum: model.configSchema?.properties.thinkingLevel.enum,
			default: model.configSchema?.properties.thinkingLevel.default,
		})), [
			{ enum: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' },
			{ enum: ['low', 'medium', 'high'], default: 'high' },
			{ enum: ['low', 'medium', 'high'], default: 'high' },
			{ enum: ['low'], default: 'low' },
			{ enum: undefined, default: undefined },
		]);
	});

	test('offers only recognized efforts and resolves a supported default', () => {
		const { service } = setup([
			{ ...model, supportedReasoningEfforts: ['unsupported', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultReasoningEffort: 'unsupported' },
			{ ...model, id: 'limited', supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'medium' },
		]);
		assert.deepStrictEqual(service.getModels('responses', 'codex').map(model => ({
			enum: model.configSchema?.properties.thinkingLevel.enum,
			default: model.configSchema?.properties.thinkingLevel.default,
		})), [
			{ enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'], default: 'medium' },
			{ enum: ['low', 'high'], default: 'low' },
		]);
	});

	test('omits the effort picker when no recognized efforts are advertised', () => {
		const { service } = setup([
			model,
			{ ...model, supportedReasoningEfforts: [], defaultReasoningEffort: 'high' },
			{ ...model, supportedReasoningEfforts: ['unsupported'] },
		]);
		assert.deepStrictEqual(service.getModels('responses', 'codex').map(model => model.configSchema), [undefined, undefined, undefined]);
		assert.deepStrictEqual(service.getModels('messages', 'claude').map(model => model.configSchema), [undefined, undefined, undefined]);
	});

	test('republishes effort and default changes without changing model identity', () => {
		const { service, push } = setup([{ ...model, supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' }]);
		const initialId = service.getModels('responses', 'codex')[0].id;
		const snapshots: Pick<ConfigPropertySchema, 'enum' | 'default'>[] = [];
		store.add(service.onDidChangeModels(() => {
			const thinkingLevel = service.getModels('responses', 'codex')[0]?.configSchema?.properties.thinkingLevel;
			snapshots.push({ enum: thinkingLevel?.enum, default: thinkingLevel?.default });
		}));
		push([{ ...model, supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' }]);
		push([{ ...model, supportedReasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'high' }]);
		push([model]);
		assert.deepStrictEqual({ id: service.getModels('responses', 'codex')[0].id, snapshots }, {
			id: initialId,
			snapshots: [
				{ enum: ['low', 'high'], default: 'high' },
				{ enum: ['low', 'medium', 'high'], default: 'high' },
				{ enum: undefined, default: undefined },
			],
		});
	});

	test('identical model ids in different configuration groups remain distinct', () => {
		assert.notStrictEqual(getByokDirectModelSelectionId(model), getByokDirectModelSelectionId({ ...model, modelIdentifier: '9router/Group 2/cp/model:1' }));
	});

	test('resolves the exact registered identifier and protocol on demand', async () => {
		const calls: unknown[] = [];
		const { service } = setup([model], async request => {
			calls.push(request);
			return { baseUrl: 'http://localhost:20128/', modelId: model.id };
		});
		assert.deepStrictEqual(await service.resolve(getByokDirectModelSelectionId(model), 'messages'), { baseUrl: 'http://localhost:20128', modelId: model.id });
		assert.deepStrictEqual(calls, [{ modelIdentifier: model.modelIdentifier, protocol: 'messages' }]);
	});

	test('rejects a removed model and mismatched returned model without falling back', async () => {
		const { service, push } = setup([model], async () => ({ baseUrl: 'http://localhost', modelId: 'other-model' }));
		await assert.rejects(service.resolve(getByokDirectModelSelectionId(model), 'messages'), /changed/);
		push([]);
		await assert.rejects(service.resolve(getByokDirectModelSelectionId(model), 'messages'), /no longer available/);
	});

	for (const change of ['remove', 'disable', 'disconnect', 'protocol'] as const) {
		test(`rejects ${change} while credentials are being resolved`, async () => {
			const deferred = new DeferredPromise<IByokLmDirectConnection>();
			const { service, push, disable, registration } = setup([model], () => deferred.p);
			const pending = service.resolve(getByokDirectModelSelectionId(model), 'messages');
			if (change === 'remove') { push([]); }
			if (change === 'disable') { disable(); }
			if (change === 'disconnect') { registration.dispose(); }
			if (change === 'protocol') { push([{ ...model, directConnectionProtocols: ['responses'] }]); }
			deferred.complete({ baseUrl: 'http://localhost', modelId: model.id });
			await assert.rejects(pending, /changed/);
		});
	}

	test('rejects endpoints with embedded credentials and malformed HTTP headers', () => {
		for (const baseUrl of ['file:///tmp/model', 'http://user:pass@localhost', 'http://localhost?key=secret', 'http://localhost#secret', 'invalid']) {
			assert.throws(() => validateDirectLanguageModelConnection({ baseUrl, modelId: model.id }), /Invalid/);
		}
		assert.throws(() => validateDirectLanguageModelConnection({ baseUrl: 'https://gateway.test', modelId: model.id, headers: { Authorization: 'Bearer fake\r\nInjected: true' } }), /Invalid/);
	});

	test('republishes protocol and Copilot visibility changes', () => {
		const { service, push } = setup();
		let changes = 0;
		store.add(service.onDidChangeModels(() => changes++));
		push([{ ...model, directConnectionProtocols: ['messages'] }]);
		push([{ ...model, directConnectionProtocols: ['messages'], hiddenForCopilot: true }]);
		assert.strictEqual(changes, 2);
		assert.strictEqual(service.getModels('messages', 'claude').length, 1);
	});
});
