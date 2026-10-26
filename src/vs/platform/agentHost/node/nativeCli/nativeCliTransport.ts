/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { killTree } from '../../../../base/node/processes.js';

export type NativeRecord = Record<string, unknown>;

/** Validates untrusted protocol objects at the subprocess boundary. */
export function record(value: unknown): NativeRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as NativeRecord : {};
}

export interface INativeCliLaunch {
	readonly executable: string;
	readonly args: readonly string[];
	readonly env: NodeJS.ProcessEnv;
	readonly cwd: string;
	readonly jsonrpc: boolean;
	/** The provider definitions inside an installed application. The runtime gets a private copy, never the original. */
	readonly installedProviderConfig?: string;
}

/** One duplex NDJSON connection, exclusively owned by one chat. */
export class NativeCliTransport extends Disposable {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly exited = new DeferredPromise<void>();
	private readonly pending = new Map<number, DeferredPromise<unknown>>();
	private readonly notifications = this._register(new Emitter<{ method: string; params: NativeRecord }>());
	readonly onNotification = this.notifications.event;
	private readonly exitEmitter = this._register(new Emitter<Error>());
	readonly onExit = this.exitEmitter.event;
	private nextId = 0;
	private stopped = false;
	private shutdownTask: Promise<void> | undefined;
	onRequest: ((method: string, params: NativeRecord) => Promise<unknown>) | undefined;

	constructor(private readonly launch: INativeCliLaunch) {
		super();
		this.child = spawn(launch.executable, [...launch.args], { cwd: launch.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
		// Drain diagnostics without recording native configuration, tokens, or startup URLs.
		this.child.stderr.resume();
		const decoder = new StringDecoder('utf8');
		let buffer = '';
		this.child.stdout.on('data', (chunk: Buffer) => {
			buffer += decoder.write(chunk);
			if (buffer.length > 16 * 1024 * 1024) {
				this.fail(new Error(localize('nativeCli.frameLimit', "Native agent exceeded the protocol frame limit.")));
				void this.shutdown();
				return;
			}
			let newline: number;
			while ((newline = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				// Runtimes may print blank lines around banners. They are not protocol frames.
				if (!line.trim()) { continue; }
				try {
					this.accept(record(JSON.parse(line)));
				} catch {
					this.fail(new Error(localize('nativeCli.invalidJson', "Native agent wrote invalid JSON to its protocol stream.")));
					void this.shutdown();
				}
			}
		});
		this.child.stdin.on('error', error => this.fail(error));
		this.child.on('error', error => this.fail(error));
		this.child.once('close', (code, signal) => {
			this.fail(new Error(localize('nativeCli.exited', "Native agent exited ({0}).", signal ?? code ?? 'unknown')));
			void this.exited.complete();
		});
	}

	private write(message: NativeRecord): void {
		if (this.stopped || !this.child.stdin.writable) {
			throw new Error(localize('nativeCli.disconnected', "Native agent is disconnected."));
		}
		this.child.stdin.write(JSON.stringify(this.launch.jsonrpc ? { jsonrpc: '2.0', ...message } : message) + '\n');
	}

	async request(method: string, params: NativeRecord = {}, timeoutMs = 60_000): Promise<unknown> {
		const id = ++this.nextId;
		const deferred = new DeferredPromise<unknown>();
		this.pending.set(id, deferred);
		const timer = timeoutMs > 0 ? setTimeout(() => void deferred.error(new Error(localize('nativeCli.timeout', "Native agent request timed out: {0}", method))), timeoutMs) : undefined;
		try {
			this.write({ id, method, params });
			return await deferred.p;
		} finally {
			clearTimeout(timer);
			this.pending.delete(id);
		}
	}

	private accept(message: NativeRecord): void {
		if (this.stopped) { return; }
		if (typeof message.method === 'string') {
			const method = message.method;
			if (typeof message.id === 'number' || typeof message.id === 'string') {
				const id = message.id;
				void Promise.resolve().then(() => {
					if (!this.onRequest) {
						throw new Error(`Unsupported native request: ${method}`);
					}
					return this.onRequest(method, record(message.params));
				}).then(result => {
					if (!this.stopped) { this.write({ id, result }); }
				}, () => {
					if (!this.stopped) { this.write({ id, error: { code: -32603, message: 'Host request failed or was cancelled.' } }); }
				}).catch(() => { /* The child may exit between settlement and write. */ });
			} else {
				this.notifications.fire({ method, params: record(message.params) });
			}
			return;
		}
		if (typeof message.id !== 'number') { return; }
		const pending = this.pending.get(message.id);
		if (pending) {
			if (message.error) {
				void pending.error(new Error(String(record(message.error).message ?? 'Native request failed.')));
			} else {
				void pending.complete(message.result);
			}
		}
	}

	private fail(error: Error): void {
		if (this.stopped) { return; }
		this.stopped = true;
		for (const pending of this.pending.values()) { void pending.error(error); }
		this.pending.clear();
		this.exitEmitter.fire(error);
	}

	/** EOF lets the native runtime cancel descendants and flush persistence before escalation. */
	private waitForExit(milliseconds: number): Promise<void> {
		return new Promise(resolve => {
			const timer = setTimeout(resolve, milliseconds);
			void this.exited.p.then(() => { clearTimeout(timer); resolve(); });
		});
	}

	shutdown(): Promise<void> {
		return this.shutdownTask ??= (async () => {
			this.child.stdin.end();
			// A process that never started has nothing to wait for.
			if (this.child.pid === undefined) { return; }
			await this.waitForExit(3000);
			if (!this.exited.isSettled) {
				await this.terminate(false);
				await this.waitForExit(2000);
			}
			if (!this.exited.isSettled) {
				await this.terminate(true);
				// A process that survives a forced kill must not hold the shutdown of the whole host.
				await this.waitForExit(5000);
			}
		})();
	}

	private async terminate(forceful: boolean): Promise<void> {
		if (this.child.pid === undefined) { return; }
		try {
			await killTree(this.child.pid, forceful || process.platform === 'win32', () => { });
		} catch {
			this.child.kill(forceful ? 'SIGKILL' : 'SIGTERM');
		}
	}

	override dispose(): void {
		void this.shutdown();
		super.dispose();
	}
}
