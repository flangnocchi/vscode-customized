/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { resolve } from '../../../../base/common/path.js';
import { IInstantiationService } from '../../../instantiation/common/instantiation.js';
import { ILogService } from '../../../log/common/log.js';
import type { NativeCliAgentId } from '../../common/nativeCliAgentConfig.js';
import type { ToolResultFileEditContent } from '../../common/state/sessionState.js';
import { FileEditTracker } from '../shared/fileEditTracker.js';
import { record } from './nativeCliTransport.js';

/**
 * The native tools that write a file, by provider. Only these report which file they change. A file changed by
 * a shell command is not seen: nothing says which files that command will touch.
 */
const editTools: Readonly<Record<NativeCliAgentId, ReadonlySet<string>>> = {
	dsh: new Set(['write', 'edit']),
	zcode: new Set(['Write', 'Edit']),
};

/** The absolute path of the file a native edit tool call writes, or `undefined` for any other call. */
export function nativeCliEditedFile(id: NativeCliAgentId, toolName: string, input: unknown, cwd: string): string | undefined {
	if (!editTools[id].has(toolName)) {
		return undefined;
	}
	let value = input;
	if (typeof value === 'string') {
		// DSH reports a call's arguments as JSON text.
		try { value = JSON.parse(value); } catch { return undefined; }
	}
	const fields = record(value);
	const path = fields.file_path ?? fields.path;
	return typeof path === 'string' && path ? resolve(cwd, path) : undefined;
}

export interface INativeCliToolStart {
	readonly callId: string;
	readonly name: string;
	readonly input: unknown;
}

export interface INativeCliToolEnd {
	readonly callId: string;
	readonly success: boolean;
}

/** The tool calls a native notification announces, with the input they were given. */
export function nativeCliToolStarts(id: NativeCliAgentId, method: string, params: Record<string, unknown>): readonly INativeCliToolStart[] {
	if (id === 'dsh') {
		const event = record(params.event);
		if (method !== 'session.event' || event.type !== 'assistant/message') {
			return [];
		}
		const content = record(record(event.data).message).content;
		return (Array.isArray(content) ? content : []).flatMap(raw => {
			const block = record(raw);
			return block.type === 'tool-call' && typeof block.id === 'string'
				? [{ callId: block.id, name: String(block.name ?? block.toolName ?? ''), input: block.input ?? block.arguments }]
				: [];
		});
	}
	const data = record(params.payload ?? params.data);
	if (method !== 'session/event' || typeof data.toolCallId !== 'string') {
		return [];
	}
	// The scheduled event omits the input of most calls. The model stream is where it is first known.
	const announced = (params.type === 'model.streaming' && data.kind === 'tool_call') || (params.type === 'tool.updated' && data.kind === 'scheduled' && data.input !== undefined);
	return announced ? [{ callId: data.toolCallId, name: String(data.toolName ?? ''), input: data.input }] : [];
}

/** The tool call a native notification reports as finished, and whether it succeeded. */
export function nativeCliToolEnd(id: NativeCliAgentId, method: string, params: Record<string, unknown>): INativeCliToolEnd | undefined {
	if (id === 'dsh') {
		const event = record(params.event);
		if (method !== 'session.event' || event.type !== 'tool/result') {
			return undefined;
		}
		const message = record(record(event.data).message);
		const callId = record(message.source).callId;
		return typeof callId === 'string' ? { callId, success: message.isError !== true && record(message.error).message === undefined } : undefined;
	}
	const data = record(params.payload ?? params.data);
	if (method !== 'session/event') {
		return undefined;
	}
	if (params.type === 'tool.updated' && typeof data.toolCallId === 'string') {
		if (data.kind === 'result') {
			const result = record(data.result);
			return { callId: data.toolCallId, success: result.isError !== true && result.success !== false };
		}
		return data.kind === 'error' ? { callId: data.toolCallId, success: false } : undefined;
	}
	if (params.type === 'part.started' || params.type === 'part.upserted') {
		const part = record(data.part);
		const state = record(part.state);
		return part.type === 'tool' && typeof part.callId === 'string' && (state.status === 'completed' || state.status === 'error')
			? { callId: part.callId, success: state.status === 'completed' }
			: undefined;
	}
	return undefined;
}

/**
 * Records the files that a chat's native edit tools write, as the Claude and Copilot providers do, so that they
 * count as the session's changes: the review bar, its Keep and Undo, and the changes of each response.
 */
export class NativeCliFileEdits extends Disposable {

	private readonly tracker: FileEditTracker;
	private readonly calls = new Map<string, { readonly path: string; readonly name: string; readonly input: unknown; readonly started: Promise<boolean> }>();

	constructor(
		id: NativeCliAgentId,
		/** The chat the edits belong to. */
		private readonly chat: string,
		/** The persistence scope of the chat, which holds its recorded edits. */
		storage: string,
		/** The session that owns the chat when an edit lands. */
		owner: () => string,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.tracker = this._register(instantiationService.createInstance(FileEditTracker, storage, owner, id));
	}

	/** Reads a file as it is before the native tool writes it. Call it as soon as the call is announced. */
	begin(id: NativeCliAgentId, call: INativeCliToolStart, cwd: string, mode: string | undefined): void {
		const path = this.calls.has(call.callId) ? undefined : nativeCliEditedFile(id, call.name, call.input, cwd);
		if (!path) {
			return;
		}
		const started = this.tracker.trackEditStart(path, mode).then(() => true, error => {
			this.logService.warn(`[NativeCliFileEdits] Could not read ${path} before it was edited: ${error}`);
			return false;
		});
		this.calls.set(call.callId, { path, name: call.name, input: call.input, started });
	}

	/** Records the edit of a finished call, or `undefined` when the call edits no file, failed, or could not be read. */
	async complete(callId: string, turnId: string, success: boolean, modelId: string): Promise<ToolResultFileEditContent | undefined> {
		const call = this.calls.get(callId);
		if (!call) {
			return undefined;
		}
		this.calls.delete(callId);
		try {
			if (!await call.started) {
				return undefined;
			}
			if (success) {
				await this.tracker.completeEdit(call.path);
			}
			// A failed call changed nothing: taking it without completing it only lets go of the file.
			return await this.tracker.takeCompletedEdit(turnId, callId, call.path, call.name, call.input, modelId, false, undefined, this.chat);
		} catch (error) {
			this.logService.warn(`[NativeCliFileEdits] Could not record the edit of ${call.path}: ${error}`);
			return undefined;
		}
	}

	/** Lets go of the files of calls that never finished, because the turn ended or its process stopped. */
	async discardPending(turnId: string, modelId: string): Promise<void> {
		await Promise.all([...this.calls.keys()].map(callId => this.complete(callId, turnId, false, modelId)));
	}
}
