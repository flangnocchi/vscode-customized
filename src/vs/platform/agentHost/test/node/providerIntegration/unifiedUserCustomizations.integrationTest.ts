/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { createServer } from 'http';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { AgentHostConfigKey } from '../../../common/agentHostCustomizationConfig.js';
import { AgentHostGitHubMcpServerEnabledConfigKey } from '../../../common/agentHostSchema.js';
import { toClientPluginMcpDefaultCwdsMeta } from '../../../common/meta/clientPluginCustomizationMeta.js';
import { ActionType } from '../../../common/state/sessionActions.js';
import { CustomizationEnablementKind, type RootState } from '../../../common/state/protocol/state.js';
import { customizationId, CustomizationType, ROOT_STATE_URI, type ClientPluginCustomization } from '../../../common/state/sessionState.js';
import { type SubscribeResult } from '../../../common/state/protocol/commands.js';
import { codexSharedMcpServerName } from '../../../node/codex/codexUnifiedUserCustomizations.js';
import { driveTurnToCompletion } from '../e2e/harness/agentHostE2ETestHarness.js';
import { createProviderSession } from '../providerIntegrationTestHelpers.js';
import { fetchSessionWithChat, type IServerHandle, startRealServer, stopServer, TestProtocolClient } from '../serverIntegrationTestHelpers.js';

const nodeRequire = createRequire(import.meta.url);
const SHARED_SKILL = 'UNIFIED_SHARED_USER_SKILL_DESCRIPTION';
const NATIVE_SKILL = 'UNIFIED_NATIVE_ONLY_USER_SKILL_DESCRIPTION';
const SHARED_MCP = 'UNIFIED_SHARED_MCP_TOOL_DESCRIPTION';
const NATIVE_MCP = 'UNIFIED_NATIVE_ONLY_MCP_TOOL_DESCRIPTION';
const SHADOWED_MCP = 'UNIFIED_SHADOWED_NATIVE_MCP_TOOL_DESCRIPTION';
const MCP_RESULT = 'UNIFIED_SHARED_MCP_TOOL_EXECUTED';
const PRIVATE_RESULT = 'UNIFIED_PRIVATE_MCP_TOOL_EXECUTED';

interface ICapturedRequest {
	readonly body: unknown;
}

suite('Agent Host Provider Integration — Unified User Customizations', function () {
	const cases = ['copilotcli', 'claude', 'codex'].flatMap(provider => ['stdio', 'http'].map(sharedTransport => ({ provider, sharedTransport })));
	for (const { provider, sharedTransport } of cases) {
		test(`${provider}/${sharedTransport}: shared MCP toggles and private MCP remain isolated in the real SDK`, async function () {
			this.timeout(180_000);
			const testDirectory = await mkdtemp(join(tmpdir(), `unified-user-${provider}-`));
			const testHome = join(testDirectory, 'home');
			const userDataDir = join(testHome, 'user-data');
			const workspace = join(testDirectory, 'workspace');
			const pluginDir = join(testHome, 'shared-plugin');
			const skillFile = join(pluginDir, 'skills', 'shared-user-skill', 'SKILL.md');
			const nativeStarted = join(testHome, 'native-mcp-started');
			const callsFile = join(testHome, 'shared-mcp-calls');
			const mcpScript = join(testHome, 'mcp.cjs');
			const nativeOrigin = provider === 'copilotcli' ? 'copilot' : provider;
			const pluginUri = URI.file(pluginDir).toString();
			let server: IServerHandle | undefined;
			let client: TestProtocolClient | undefined;
			let httpMcp: ReturnType<typeof createServer> | undefined;
			const sessions: string[] = [];
			const serverOutput: string[] = [];
			const nativeStartupPhases: Record<string, string> = {};
			try {
				let sharedUrl: string | undefined;
				if (sharedTransport === 'http') {
					httpMcp = createServer(async (request, response) => {
						if (request.method !== 'POST') {
							response.writeHead(405).end();
							return;
						}
						const chunks: Buffer[] = [];
						for await (const chunk of request) {
							chunks.push(Buffer.from(chunk));
						}
						const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: string | number; method: string; params?: { protocolVersion?: string } };
						if (message.id === undefined) {
							response.writeHead(202).end();
							return;
						}
						if (message.method === 'tools/call') {
							await writeFile(callsFile, 'shared:http\n', { flag: 'a' });
						}
						const result = message.method === 'initialize'
							? { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'unified-http-test', version: '1.0.0' } }
							: message.method === 'tools/list'
								? { tools: [{ name: 'unified_probe', description: SHARED_MCP, inputSchema: { type: 'object', properties: {} } }] }
								: message.method === 'tools/call' ? { content: [{ type: 'text', text: MCP_RESULT }] } : {};
						response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
					});
					await new Promise<void>((resolve, reject) => httpMcp!.once('error', reject).listen(0, '127.0.0.1', resolve));
					const address = httpMcp.address();
					assert.ok(address && typeof address !== 'string');
					sharedUrl = `http://127.0.0.1:${address.port}/mcp`;
				}
				await Promise.all([
					workspace, join(pluginDir, '.plugin'), join(pluginDir, 'skills', 'shared-user-skill'),
					join(testHome, '.agents', 'skills', 'native-user-skill'), join(testHome, '.claude', 'skills', 'native-user-skill'),
					join(testHome, '.agents', 'skills', 'shared-user-skill'), join(testHome, '.claude', 'skills', 'shared-user-skill'),
					join(testHome, '.copilot'), join(testHome, '.codex'), join(userDataDir, 'User', 'globalStorage'),
				].map(directory => mkdir(directory, { recursive: true })));
				const nativeServer = { command: process.execPath, args: [mcpScript, 'private'], env: { ELECTRON_RUN_AS_NODE: '1' } };
				const sharedServer = sharedUrl ? { type: 'http', url: sharedUrl } : { command: process.execPath, args: [mcpScript, 'shared'], env: { ELECTRON_RUN_AS_NODE: '1' } };
				const nativeServers = (origin: string) => ({
					[`private_${origin}`]: { ...nativeServer, args: [...nativeServer.args, origin] },
					unified_shared: { ...nativeServer, args: [mcpScript, 'shadowed', origin] },
				});
				const skillText = `---\nname: shared-user-skill\ndescription: ${SHARED_SKILL}\n---\nUse the shared user skill.`;
				await Promise.all([
					writeFile(skillFile, skillText),
					writeFile(join(testHome, '.agents', 'skills', 'native-user-skill', 'SKILL.md'), `---\nname: native-user-skill\ndescription: ${NATIVE_SKILL}\n---\nNative user skill.`),
					writeFile(join(testHome, '.claude', 'skills', 'native-user-skill', 'SKILL.md'), `---\nname: native-user-skill\ndescription: ${NATIVE_SKILL}\n---\nNative user skill.`),
					writeFile(join(testHome, '.agents', 'skills', 'shared-user-skill', 'SKILL.md'), `---\nname: shared-user-skill\ndescription: ${NATIVE_SKILL}\n---\nShadowed native user skill.`),
					writeFile(join(testHome, '.claude', 'skills', 'shared-user-skill', 'SKILL.md'), `---\nname: shared-user-skill\ndescription: ${NATIVE_SKILL}\n---\nShadowed native user skill.`),
					writeFile(join(pluginDir, '.plugin', 'plugin.json'), JSON.stringify({ name: 'VS Code Synced Data' })),
					writeFile(join(pluginDir, '.mcp.json'), JSON.stringify({ mcpServers: { unified_shared: sharedServer } })),
					writeFile(join(testHome, '.copilot', 'mcp-config.json'), JSON.stringify({ mcpServers: nativeServers('copilot') })),
					writeFile(join(testHome, '.claude', 'settings.json'), JSON.stringify({ mcpServers: nativeServers('claude') })),
					writeFile(join(testHome, '.claude.json'), JSON.stringify({ mcpServers: nativeServers('claude') })),
					writeFile(join(testHome, '.codex', 'config.toml'), Object.entries(nativeServers('codex')).map(([name, config]) => `[mcp_servers.${name}]\ncommand = ${JSON.stringify(config.command)}\nargs = ${JSON.stringify(config.args)}\n[mcp_servers.${name}.env]\nELECTRON_RUN_AS_NODE = "1"\n`).join('\n')),
					writeFile(join(userDataDir, 'User', 'globalStorage', 'agent-host-config.json'), JSON.stringify({
						[AgentHostConfigKey.UnifiedUserCustomizations]: true,
						[AgentHostGitHubMcpServerEnabledConfigKey]: false,
					})),
					writeFile(mcpScript, [
						`const fs = require('fs');`,
						`const { Server } = require(${JSON.stringify(nodeRequire.resolve('@modelcontextprotocol/sdk/server/index.js'))});`,
						`const { StdioServerTransport } = require(${JSON.stringify(nodeRequire.resolve('@modelcontextprotocol/sdk/server/stdio.js'))});`,
						`const { CallToolRequestSchema, ListToolsRequestSchema } = require(${JSON.stringify(nodeRequire.resolve('@modelcontextprotocol/sdk/types.js'))});`,
						`const mode = process.argv[2]; const origin = process.argv[3]; const native = mode !== 'shared';`,
						`if (native) fs.appendFileSync(${JSON.stringify(nativeStarted)}, JSON.stringify({ parent: process.ppid, argv: process.argv, agent: process.env.AI_AGENT, copilotHome: process.env.COPILOT_HOME, codexHome: process.env.CODEX_HOME, claudeDir: process.env.CLAUDE_CONFIG_DIR }) + '\\n');`,
						`const server = new Server({ name: 'unified-test', version: '1.0.0' }, { capabilities: { tools: {} } });`,
						`server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: mode === 'private' ? origin + '_private_probe' : 'unified_probe', description: mode === 'private' ? ${JSON.stringify(NATIVE_MCP)} + '_' + origin : mode === 'shadowed' ? ${JSON.stringify(SHADOWED_MCP)} : ${JSON.stringify(SHARED_MCP)}, inputSchema: { type: 'object', properties: {} } }] }));`,
						`server.setRequestHandler(CallToolRequestSchema, async () => { fs.appendFileSync(${JSON.stringify(callsFile)}, mode + ':' + origin + '\\n'); return { content: [{ type: 'text', text: mode === 'shared' ? ${JSON.stringify(MCP_RESULT)} : ${JSON.stringify(PRIVATE_RESULT)} + '_' + origin }] }; });`,
						`void server.connect(new StdioServerTransport());`,
					].join('\n')),
				]);
				server = await startRealServer({
					homeDir: testHome, userDataDir, mockLlm: true, logLevel: 'trace',
					claudeSdkRoot: process.cwd(), codexSdkRoot: process.cwd(), codexHomeDir: join(testHome, '.codex'),
					mockScenarios: ['unified-user-mcp', 'unified-user-mcp-restored', 'unified-private-mcp'].map(id => ({
						id, definition: { type: 'multi-turn', turns: [
							{ kind: 'tool-calls', toolCalls: [
								...(id === 'unified-private-mcp' ? [] : [{ toolNamePattern: /unified_probe$/, arguments: {}, ...(provider === 'codex' ? { namespace: `mcp__${codexSharedMcpServerName('unified_shared')}` } : {}) }]),
								{ toolNamePattern: new RegExp(`${nativeOrigin}_private_probe$`), arguments: {}, ...(provider === 'codex' ? { namespace: `mcp__private_${nativeOrigin}` } : {}) },
							] },
							{ kind: 'content', chunks: [{ content: 'Shared MCP checked.', delayMs: 0 }] },
						] },
					})),
				});
				server.process.stdout?.on('data', data => serverOutput.push(String(data)));
				server.process.stderr?.on('data', data => serverOutput.push(String(data)));
				client = new TestProtocolClient(server.port);
				await client.connect();
				const clientId = `unified-user-${provider}`;
				const session = await createProviderSession(client, { provider, scheme: provider, githubToken: 'not-a-real-token' }, clientId, sessions, URI.file(workspace));
				const root = await client.call<SubscribeResult>('subscribe', { channel: ROOT_STATE_URI });
				assert.strictEqual((root.snapshot!.state as RootState).config?.values[AgentHostConfigKey.UnifiedUserCustomizations], true, 'the opt-in must be effective before any SDK starts');
				nativeStartupPhases.created = await readFile(nativeStarted, 'utf8').catch(() => '');
				let clientSeq = 1;
				const setShared = async (nonce: string, enabled: boolean) => {
					const plugin: ClientPluginCustomization = {
						type: CustomizationType.Plugin, id: customizationId(pluginUri), uri: pluginUri,
						name: 'VS Code Synced Data', nonce,
						_meta: toClientPluginMcpDefaultCwdsMeta({ unified_shared: null }),
						childEnablement: { unified_shared: [{ kind: CustomizationEnablementKind.Global, enabled }] },
					};
					client!.dispatch({ channel: session, clientSeq: clientSeq++, action: { type: ActionType.SessionActiveClientSet, activeClient: { clientId, tools: [], customizations: [plugin] } } });
					const deadline = Date.now() + 30_000;
					while (true) {
						const state = await fetchSessionWithChat(client!, session);
						if (state.customizations?.some(item => item.type === CustomizationType.Plugin && item.uri === pluginUri && (provider === 'claude' ? item.load?.kind === 'loaded' : item.children?.some(child => child.type === CustomizationType.McpServer)))) {
							break;
						}
						assert.ok(Date.now() < deadline, 'the shared plugin must settle before the turn');
						await new Promise<void>(resolve => setTimeout(resolve, 100));
					}
				};
				const send = async (turn: string, scenario: string) => {
					const offset = server!.mockLlm!.getRequests!().length;
					const turnSequence = clientSeq;
					clientSeq += 100;
					await driveTurnToCompletion(client!, session, turn, `[scenario:${scenario}] Validate shared customizations.`, turnSequence);
					nativeStartupPhases[turn] = await readFile(nativeStarted, 'utf8').catch(() => '');
					const requests = server!.mockLlm!.getRequests!().slice(offset) as readonly ICapturedRequest[];
					assert.ok(requests.length, 'a real SDK must make a model request');
					const bodies = requests.map(request => JSON.stringify(request.body));
					assert.ok(bodies.every(body => !body.includes(NATIVE_SKILL) && !body.includes(SHADOWED_MCP)), 'native skills and shadowed same-name MCP must stay excluded');
					for (const other of ['copilot', 'claude', 'codex'].filter(origin => origin !== nativeOrigin)) {
						assert.ok(bodies.every(body => !body.includes(`${NATIVE_MCP}_${other}`)), 'another harness private MCP must not be shared');
					}
					assert.ok(bodies.some(body => body.includes(`${NATIVE_MCP}_${nativeOrigin}`)), 'the harness must retain its own private MCP');
					return bodies;
				};
				await setShared('1', true);
				const on = await send('shared-on', 'unified-user-mcp');
				assert.ok(on.some(body => body.includes(SHARED_SKILL)), 'the VS Code user skill must reach the model');
				assert.ok(on.some(body => body.includes(SHARED_MCP)), 'the VS Code MCP tool must reach the model');
				assert.ok(on.some(body => body.includes(MCP_RESULT)), 'the shared MCP tool must execute');
				const before = await fetchSessionWithChat(client, session);
				const mcpItems = before.customizations?.flatMap(item => item.type === CustomizationType.McpServer ? [item] : item.type === CustomizationType.Plugin ? item.children?.filter(child => child.type === CustomizationType.McpServer) ?? [] : []) ?? [];
				assert.ok(mcpItems.every(item => !item.name.startsWith('vscode_shared_')), 'SDK aliases must not leak into the customization UI');
				if (provider === 'codex') {
					const shared = mcpItems.find(item => item.name === 'unified_shared');
					assert.ok(shared?.channel, 'the original shared name must retain its MCP channel');
					const listed = await client.call<{ tools: readonly { description?: string }[] }>('tools/list', { channel: shared.channel });
					assert.ok(listed.tools.some(tool => tool.description === SHARED_MCP), 'the original MCP channel must read the aliased SDK inventory');
					const result = await client.call('tools/call', { channel: shared.channel, name: 'unified_probe', arguments: {} });
					assert.ok(JSON.stringify(result).includes(MCP_RESULT), 'calls through the original MCP channel must reach the shared SDK server');
				}
				const builtins = before.customizations?.filter(item => item.uri.startsWith('agent-builtin:'));
				await rm(skillFile);
				await setShared('2', false);
				const off = await send('shared-off', 'unified-private-mcp');
				const latest = off[off.length - 1];
				assert.ok(!latest.includes(SHARED_MCP), 'disabling shared MCP must remove its tool definitions');
				// Earlier conversational history may mention a skill, so assert the fresh SDK catalog too.
				const disabled = await fetchSessionWithChat(client, session);
				assert.ok(!disabled.customizations?.some(item => item.type === CustomizationType.Plugin && item.children?.some(child => child.type === CustomizationType.Skill && child.name === 'shared-user-skill')));
				assert.deepStrictEqual(disabled.customizations?.filter(item => item.uri.startsWith('agent-builtin:')), builtins, 'bundled skills must stay unchanged');
				await writeFile(skillFile, skillText);
				await setShared('3', true);
				const restored = await send('shared-restored', 'unified-user-mcp-restored');
				assert.ok(restored.some(body => body.includes(SHARED_MCP) && body.includes(SHARED_SKILL)), 're-enabling the common catalog must reach the SDK again');
				const calls = (await readFile(callsFile, 'utf8')).trim().split('\n');
				assert.ok(calls.filter(call => call.startsWith('shared:')).length >= 2, 'shared MCP must execute before and after the toggle');
				assert.ok(calls.filter(call => call === `private:${nativeOrigin}`).length >= 3, 'private MCP must execute while shared MCP is on, off and restored');
				assert.ok(calls.every(call => !call.startsWith('shadowed:')), 'a disabled shared name must never fall back to native MCP');
			} catch (error) {
				const logPaths = (await readdir(testHome, { recursive: true })).filter(path => path.endsWith('agenthost-server.log'));
				await writeFile(join(process.cwd(), '.build', `unified-integration-${provider}-${sharedTransport}-failure.json`), JSON.stringify({
					requests: server?.mockLlm?.getRequests?.(), mockLog: server?.mockLlm?.logMessages,
					state: client && sessions[0] ? await fetchSessionWithChat(client, sessions[0]).catch(() => undefined) : undefined,
					serverOutput, nativeStartupPhases, hostLogs: await Promise.all(logPaths.map(path => readFile(join(testHome, path), 'utf8'))),
				}, undefined, 2));
				throw error;
			} finally {
				for (const session of sessions) {
					try { await client?.call('disposeSession', { session }, 5000); } catch { /* best-effort */ }
				}
				client?.close();
				if (server) {
					await stopServer(server);
				}
				httpMcp?.closeAllConnections();
				await new Promise<void>(resolve => httpMcp ? httpMcp.close(() => resolve()) : resolve());
				await rm(testDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
			}
		});
	}
});
