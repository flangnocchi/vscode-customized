/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { sharedUserInstructionText } from '../../../node/shared/sharedUserInstructions.js';
import { INativeEnvironmentService } from '../../../../environment/common/environment.js';
import { FileService } from '../../../../files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../log/common/log.js';
import { AgentHostConfigKey } from '../../../common/agentHostCustomizationConfig.js';
import { AgentConfigurationService } from '../../../node/agentConfigurationService.js';
import { AgentHostStateManager } from '../../../node/agentHostStateManager.js';
import { discoverSharedUserCustomizations, filterSharedUserCustomizations, SharedUserCustomizationDiscovery, type IPrivateCustomizationNames } from '../../../node/shared/sharedUserCustomizations.js';

suite('SharedUserCustomizations', () => {
	const store = new DisposableStore();
	const userHome = URI.from({ scheme: Schemas.inMemory, path: '/home' });
	const root = URI.joinPath(userHome, '.agents');
	const logService = new NullLogService();
	let fileService: FileService;

	setup(() => {
		fileService = store.add(new FileService(logService));
		store.add(fileService.registerProvider(Schemas.inMemory, store.add(new InMemoryFileSystemProvider())));
	});
	teardown(() => store.clear());
	ensureNoDisposablesAreLeakedInTestSuite();

	async function write(path: string, content: string): Promise<void> {
		await fileService.writeFile(URI.joinPath(userHome, path), VSBuffer.fromString(content));
	}

	async function seed(): Promise<void> {
		await write('.agents/skills/research/SKILL.md', '---\nname: research\ndescription: Shared research skill\n---\nResearch instructions.');
		await write('.agents/agents/research.agent.md', '---\nname: researcher\ndescription: Shared research agent\n---\nAgent instructions.');
		await write('.agents/mcp.json', JSON.stringify({ mcpServers: { shared: { command: 'shared-command', args: ['literal argument'] } } }));
	}

	test('shared instructions retain source identities and only always-on rules enter global context', async () => {
		await write('.agents/instructions/common.instructions.md', '---\napplyTo: "**"\n---\nShared always-on instruction.');
		await write('.agents/rules/scoped.mdc', '---\nglobs: "src/**"\n---\nScoped instruction.');
		await write('.agents/rules/disabled.mdc', '---\nalwaysApply: false\n---\nDisabled instruction.');
		const plugins = await discoverSharedUserCustomizations(userHome, true, fileService, logService);
		assert.deepStrictEqual({
			instructions: plugins[0].parsed.instructions.map(rule => rule.uri.toString()),
			text: await sharedUserInstructionText(plugins.map(plugin => plugin.parsed), fileService),
		}, {
			instructions: [URI.joinPath(root, 'instructions/common.instructions.md').toString(), URI.joinPath(root, 'rules/disabled.mdc').toString(), URI.joinPath(root, 'rules/scoped.mdc').toString()],
			text: 'Shared always-on instruction.',
		});
	});

	test('loose hook files are not shared', async () => {
		await write('.agents/hooks/hooks.json', '{"hooks":{"SessionStart":[{"type":"command","command":"echo nested"}]}}');
		await write('.agents/hooks.json', '{"hooks":{"SessionStart":[{"type":"command","command":"echo flat"}]}}');
		assert.deepStrictEqual(await discoverSharedUserCustomizations(userHome, false, fileService, logService), []);
	});

	test('instruction changes replace the snapshot and disabling removes the supplement', async () => {
		await write('.agents/instructions/common.instructions.md', 'Original instruction.');
		const manager = store.add(new AgentHostStateManager(logService));
		const configuration = store.add(new AgentConfigurationService(manager, logService));
		configuration.updateRootConfig({ [AgentHostConfigKey.UnifiedUserCustomizations]: true });
		const discovery = store.add(new SharedUserCustomizationDiscovery(true, { userHome } as INativeEnvironmentService, configuration, fileService, logService));
		await discovery.whenSettled();
		await write('.agents/instructions/common.instructions.md', 'Updated instruction.');
		await discovery.refresh();
		const text = await sharedUserInstructionText(discovery.plugins.map(plugin => plugin.parsed), fileService);
		configuration.updateRootConfig({ [AgentHostConfigKey.UnifiedUserCustomizations]: false });
		await discovery.whenSettled();
		assert.deepStrictEqual({ text, after: discovery.plugins }, { text: 'Updated instruction.', after: [] });
	});

	test('missing shared directory does not discover private harness files', async () => {
		await write('.claude/skills/private/SKILL.md', '---\nname: private\ndescription: Private\n---\nPrivate instructions.');
		assert.deepStrictEqual(await discoverSharedUserCustomizations(userHome, false, fileService, logService), []);
	});

	test('supplements all loose resource types with original source paths', async () => {
		await seed();
		const plugins = await discoverSharedUserCustomizations(userHome, false, fileService, logService);
		assert.deepStrictEqual(plugins.map(plugin => ({
			uri: plugin.customization.uri,
			loose: plugin.loose,
			skills: plugin.parsed.skills.map(skill => [skill.name, skill.uri.toString()]),
			agents: plugin.parsed.agents.map(agent => [agent.name, agent.uri.toString()]),
			mcp: plugin.parsed.mcpServers.map(server => [server.name, server.uri.toString(), server.defaultCwd]),
		})), [{
			uri: root.toString(), loose: true,
			skills: [['research', URI.joinPath(root, 'skills/research/SKILL.md').toString()]],
			agents: [['researcher', URI.joinPath(root, 'agents/research.agent.md').toString()]],
			mcp: [['shared', URI.joinPath(root, 'mcp.json').toString(), undefined]],
		}]);
	});

	test('native skill support leaves standalone skills to the SDK', async () => {
		await seed();
		const plugins = await discoverSharedUserCustomizations(userHome, true, fileService, logService);
		assert.deepStrictEqual(plugins.map(plugin => ({ skills: plugin.parsed.skills.length, agents: plugin.parsed.agents.length, mcp: plugin.parsed.mcpServers.length })), [{ skills: 0, agents: 1, mcp: 1 }]);
	});

	test('native names reserve skills, agents and MCP without mutating the shared source', async () => {
		await seed();
		const shared = await discoverSharedUserCustomizations(userHome, false, fileService, logService);
		const native: IPrivateCustomizationNames = { skills: new Set(['research']), agents: new Set(['researcher']), mcpServers: new Set(['shared']), plugins: new Set() };
		assert.deepStrictEqual(filterSharedUserCustomizations(shared, native), []);
		assert.strictEqual(shared[0].parsed.skills.length, 1);
		assert.strictEqual(shared[0].parsed.agents.length, 1);
		assert.strictEqual(shared[0].parsed.mcpServers.length, 1);
		assert.strictEqual(shared[0].customization.children?.length, 3);
	});

	test('keeps nonconflicting components and their original customization identities', async () => {
		await seed();
		const shared = await discoverSharedUserCustomizations(userHome, false, fileService, logService);
		const native: IPrivateCustomizationNames = { skills: new Set(), agents: new Set(['researcher']), mcpServers: new Set(['shared']), plugins: new Set() };
		const [filtered] = filterSharedUserCustomizations(shared, native);
		assert.deepStrictEqual(filtered.customization.children, [shared[0].parsed.skills[0].customization]);
		assert.strictEqual(filtered.customization.id, shared[0].customization.id);
		assert.strictEqual(filtered.parsed.skills[0].uri.toString(), URI.joinPath(root, 'skills/research/SKILL.md').toString());
	});

	test('a same-named native plugin reserves the whole package, including disabled native plugins', async () => {
		await write('.agents/plugins/sample/.plugin/plugin.json', '{"name":"sample"}');
		await write('.agents/plugins/sample/skills/research/SKILL.md', '---\nname: research\ndescription: Shared research\n---\nInstructions.');
		const shared = await discoverSharedUserCustomizations(userHome, false, fileService, logService);
		assert.deepStrictEqual(filterSharedUserCustomizations(shared, { skills: new Set(), agents: new Set(), mcpServers: new Set(), plugins: new Set(['sample']) }), []);
	});

	test('different names remain available even when their descriptions describe the same capability', async () => {
		await write('.agents/skills/shared-image/SKILL.md', '---\nname: shared-image\ndescription: Generate images\n---\nInstructions.');
		const shared = await discoverSharedUserCustomizations(userHome, false, fileService, logService);
		const filtered = filterSharedUserCustomizations(shared, { skills: new Set(['imagegen']), agents: new Set(), mcpServers: new Set(), plugins: new Set() });
		assert.deepStrictEqual(filtered.flatMap(plugin => plugin.parsed.skills.map(skill => skill.name)), ['shared-image']);
	});

	test('an explicit relative MCP cwd remains relative to the shared directory', async () => {
		await write('.agents/mcp.json', '{"mcpServers":{"shared":{"command":"shared-command","cwd":"tools"}}}');
		const [plugin] = await discoverSharedUserCustomizations(userHome, true, fileService, logService);
		assert.strictEqual(plugin.parsed.mcpServers[0].defaultCwd?.toString(), root.toString());
	});

	test('native skill support adds nothing for a skills-only shared directory', async () => {
		await write('.agents/skills/research/SKILL.md', '---\nname: research\ndescription: Shared\n---\nInstructions.');
		assert.deepStrictEqual(await discoverSharedUserCustomizations(userHome, true, fileService, logService), []);
	});

	test('loads declared plugins once and ignores marketplace metadata and ordinary directories', async () => {
		await write('.agents/plugins/marketplace.json', '{}');
		await write('.agents/plugins/ordinary/README.md', 'Not a plugin.');
		await write('.agents/plugins/sample/.plugin/plugin.json', '{"name":"sample"}');
		await write('.agents/plugins/sample/skills/example/SKILL.md', '---\nname: example\ndescription: Plugin skill\n---\nPlugin instructions.');
		const plugins = await discoverSharedUserCustomizations(userHome, true, fileService, logService);
		assert.deepStrictEqual(plugins.map(plugin => ({ uri: plugin.pluginDir.toString(), name: plugin.customization.name, loose: plugin.loose, skills: plugin.parsed.skills.map(skill => skill.name) })), [{ uri: URI.joinPath(root, 'plugins/sample').toString(), name: 'sample', loose: false, skills: ['example'] }]);
	});

	test('the opt-in can be enabled and removed without modifying private files', async () => {
		await seed();
		const manager = store.add(new AgentHostStateManager(logService));
		const configuration = store.add(new AgentConfigurationService(manager, logService));
		const discovery = store.add(new SharedUserCustomizationDiscovery(true, { userHome } as INativeEnvironmentService, configuration, fileService, logService));
		await discovery.whenSettled();
		const before = discovery.plugins.length;
		configuration.updateRootConfig({ [AgentHostConfigKey.UnifiedUserCustomizations]: true });
		await discovery.whenSettled();
		const enabled = discovery.plugins.length;
		configuration.updateRootConfig({ [AgentHostConfigKey.UnifiedUserCustomizations]: false });
		await discovery.whenSettled();
		assert.deepStrictEqual({ before, enabled, after: discovery.plugins.length }, { before: 0, enabled: 1, after: 0 });
	});

	test('refresh removes stale shared MCP definitions after changes', async () => {
		await seed();
		const manager = store.add(new AgentHostStateManager(logService));
		const configuration = store.add(new AgentConfigurationService(manager, logService));
		configuration.updateRootConfig({ [AgentHostConfigKey.UnifiedUserCustomizations]: true });
		const discovery = store.add(new SharedUserCustomizationDiscovery(true, { userHome } as INativeEnvironmentService, configuration, fileService, logService));
		await discovery.whenSettled();
		await write('.agents/mcp.json', '{"mcpServers":{"replacement":{"command":"replacement-command"}}}');
		await discovery.refresh();
		assert.deepStrictEqual(discovery.plugins.flatMap(plugin => plugin.parsed.mcpServers.map(server => server.name)), ['replacement']);
	});
});
