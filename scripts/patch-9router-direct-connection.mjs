/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs inside 9Router's extension host. Never exports credentials in the model catalogue.
export function resolve9RouterDirectConnection(provider, request) {
	if (!request || !['messages', 'responses'].includes(request.protocol) || typeof request.modelId !== 'string' || !request.modelId) {
		throw new Error('Invalid 9Router direct connection request');
	}
	const config = provider.configService.load();
	const cache = provider.secretsManager.getCache();
	// Use the selected VS Code configuration group, never the last group's frameworkOverride.
	const apiKey = typeof request.configuration?.apiKey === 'string' ? request.configuration.apiKey : cache.apiKey;
	const headers = {};
	const key = apiKey?.trim().replace(/^Bearer\s+/i, '');
	if (key) { headers.Authorization = `Bearer ${key}`; }
	for (const [name, value] of Object.entries(cache.customHeaders ?? {})) {
		if (typeof value !== 'string') { continue; }
		const previous = Object.keys(headers).find(existing => existing.toLowerCase() === name.toLowerCase());
		if (previous) { delete headers[previous]; }
		headers[name] = value;
	}
	const root = config.serverUrl.trim().replace(/\/+$/, '').replace(/\/(openai\/)?v1$/i, '');
	return { baseUrl: request.protocol === 'responses' ? `${root}/v1` : root, modelId: request.modelId, headers };
}

export function patch9RouterDirectConnection(extensionDirectory) {
	const manifestPath = path.join(extensionDirectory, 'package.json');
	const bundlePath = path.join(extensionDirectory, 'out/extension.js');
	const manifestSource = fs.readFileSync(manifestPath, 'utf8');
	const manifest = JSON.parse(manifestSource);
	if (manifest.publisher !== 'hotrungnhan' || manifest.name !== '9router-for-github-copilot' || manifest.version !== '1.8.3') {
		throw new Error('This patch supports hotrungnhan.9router-for-github-copilot 1.8.3 only');
	}
	let bundle = fs.readFileSync(bundlePath, 'utf8');
	const command = '9router-for-github-copilot.resolveDirectConnection';
	const anchor = 'await e.loadSecrets(),t.subscriptions.push(';
	if (!bundle.includes(command)) {
		if (bundle.split(anchor).length !== 2 || !bundle.includes('this.secretsManager=new me(')) {
			throw new Error('Unsupported 9Router bundle layout; no files changed');
		}
		bundle = bundle.replace(anchor, `${anchor}x.commands.registerCommand(${JSON.stringify(command)},request=>(${resolve9RouterDirectConnection.toString()})(e,request)),`);
	}
	const contribution = manifest.contributes?.languageModelChatProviders?.find(provider => provider.vendor === '9router-github-copilot');
	if (!contribution) { throw new Error('9Router language model provider contribution is missing'); }
	contribution.directConnection = { command, protocols: ['messages', 'responses'] };
	// Preserve the originals once, including any earlier local repairs.
	for (const [file, source] of [[manifestPath, manifestSource], [bundlePath, fs.readFileSync(bundlePath, 'utf8')]]) {
		const backup = `${file}.before-direct-connection`;
		if (!fs.existsSync(backup)) { fs.writeFileSync(backup, source); }
	}
	fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	fs.writeFileSync(bundlePath, bundle);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (!process.argv[2]) { throw new Error('Usage: node scripts/patch-9router-direct-connection.mjs <extension-directory>'); }
	patch9RouterDirectConnection(path.resolve(process.argv[2]));
	console.log('9Router direct connection command installed; restart the development VS Code window.');
}
