/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { patch9RouterDirectConnection, resolve9RouterDirectConnection } from './patch-9router-direct-connection.mjs';

const provider = {
	configService: { load: () => ({ serverUrl: 'http://localhost:20128/openai/v1/' }) },
	secretsManager: { getCache: () => ({ apiKey: 'legacy-test-key', customHeaders: { 'X-Route': 'test' } }) },
	frameworkOverride: { apiKey: 'stale-group-key' },
};

test('selects the exact configuration group and preserves model namespace for both protocols', () => {
	assert.deepEqual(resolve9RouterDirectConnection(provider, { modelId: 'cx/gpt-6.1-sol', protocol: 'messages', configuration: { apiKey: 'group-b' } }), {
		baseUrl: 'http://localhost:20128', modelId: 'cx/gpt-6.1-sol', headers: { Authorization: 'Bearer group-b', 'X-Route': 'test' },
	});
	assert.deepEqual(resolve9RouterDirectConnection(provider, { modelId: 'cx/gpt-6.1-sol', protocol: 'responses' }), {
		baseUrl: 'http://localhost:20128/v1', modelId: 'cx/gpt-6.1-sol', headers: { Authorization: 'Bearer legacy-test-key', 'X-Route': 'test' },
	});
});

test('explicit empty group credentials never reuse another group or legacy key', () => {
	const resolved = resolve9RouterDirectConnection(provider, { modelId: 'model', protocol: 'messages', configuration: { apiKey: '' } });
	assert.deepEqual(resolved.headers, { 'X-Route': 'test' });
});

test('custom authorization wins case-insensitively, matching the plugin header override', () => {
	const customProvider = { ...provider, secretsManager: { getCache: () => ({ apiKey: 'legacy', customHeaders: { authorization: 'Bearer custom' } }) } };
	assert.deepEqual(resolve9RouterDirectConnection(customProvider, { modelId: 'model', protocol: 'responses' }).headers, { authorization: 'Bearer custom' });
});

test('unsupported protocol is rejected', () => {
	assert.throws(() => resolve9RouterDirectConnection(provider, { modelId: 'model', protocol: 'chat' }), /Invalid/);
});

test('patch is idempotent and preserves original files', () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), '9router-patch-test-'));
	try {
		fs.mkdirSync(path.join(directory, 'out'));
		const manifest = { publisher: 'hotrungnhan', name: '9router-for-github-copilot', version: '1.8.3', contributes: { languageModelChatProviders: [{ vendor: '9router-github-copilot' }] } };
		const bundle = 'this.secretsManager=new me(context);await e.loadSecrets(),t.subscriptions.push(existing);';
		fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest));
		fs.writeFileSync(path.join(directory, 'out/extension.js'), bundle);
		patch9RouterDirectConnection(directory);
		const patched = fs.readFileSync(path.join(directory, 'out/extension.js'), 'utf8');
		patch9RouterDirectConnection(directory);
		assert.deepEqual({ unchanged: patched === fs.readFileSync(path.join(directory, 'out/extension.js'), 'utf8'), original: fs.readFileSync(path.join(directory, 'out/extension.js.before-direct-connection'), 'utf8') }, { unchanged: true, original: bundle });
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test('an unsupported extension version fails before changing any files', () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), '9router-patch-version-'));
	try {
		const manifestPath = path.join(directory, 'package.json');
		const original = JSON.stringify({ publisher: 'hotrungnhan', name: '9router-for-github-copilot', version: '2.0.0' });
		fs.writeFileSync(manifestPath, original);
		assert.throws(() => patch9RouterDirectConnection(directory), /1.8.3 only/);
		assert.equal(fs.readFileSync(manifestPath, 'utf8'), original);
		assert.equal(fs.existsSync(manifestPath + '.before-direct-connection'), false);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
