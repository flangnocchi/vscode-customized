/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { URI } from '../../../../base/common/uri.js';
import type { AgentSignal, IAgentActionSignal } from '../../common/agent.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { MessageKind, ResponsePartKind, ToolCallConfirmationReason, ToolCallStatus, ToolResultContentType, TurnState, createErrorResponsePart, type MarkdownResponsePart, type ReasoningResponsePart, type ModelSelection, type ToolCallResponsePart, type ToolCallResult, type Turn } from '../../common/state/sessionState.js';
import { record, type NativeRecord } from './nativeCliTransport.js';

/** Extracts readable content from native content blocks, without printing protocol envelopes. */
export function nativeText(value: unknown): string {
	if (typeof value === 'string') { return value; }
	if (Array.isArray(value)) { return value.map(nativeText).filter(Boolean).join('\n'); }
	const object = record(value);
	return typeof object.text === 'string' ? object.text : typeof object.content === 'string' ? object.content : '';
}

/** Converts one native turn into the shared live actions and the identical saved transcript. */
export class NativeCliTurn {
	readonly turn: Turn;
	private readonly started = Date.now();
	private readonly parts = new Map<string, MarkdownResponsePart | ReasoningResponsePart>();
	private readonly tools = new Map<string, ToolCallResponsePart>();
	private readonly events = new Set<string>();
	private readonly streamedParts = new Map<string, string>();
	private ended = false;

	constructor(readonly chat: URI, id: string, prompt: string, model: ModelSelection | undefined, private readonly emit: (signal: AgentSignal) => void) {
		this.turn = { id, startedAt: new Date().toISOString(), message: { text: prompt, origin: { kind: MessageKind.User }, model }, responseParts: [], usage: undefined, state: TurnState.Cancelled };
	}

	get isEnded(): boolean { return this.ended; }
	get hasText(): boolean { return this.turn.responseParts.some(part => part.kind === ResponsePartKind.Markdown && part.content.length > 0); }
	toolId(id: string): string { return `${this.chat.toString()}#${id}`; }

	action(action: IAgentActionSignal['action']): void {
		this.emit({ kind: 'action', resource: this.chat, action });
	}

	text(id: string, text: string, reasoning = false, snapshot = false): void {
		if (!text || this.ended) { return; }
		const existing = this.parts.get(id);
		const part: MarkdownResponsePart | ReasoningResponsePart = existing ?? (reasoning ? { kind: ResponsePartKind.Reasoning, id, content: '' } : { kind: ResponsePartKind.Markdown, id, content: '' });
		if (!existing) {
			this.parts.set(id, part);
			this.turn.responseParts.push(part);
			this.action({ type: ActionType.ChatResponsePart, turnId: this.turn.id, part: { ...part } });
		}
		const delta = snapshot ? (text.startsWith(part.content) ? text.slice(part.content.length) : '') : text;
		if (!delta) { return; }
		part.content += delta;
		this.action({ type: reasoning ? ActionType.ChatReasoning : ActionType.ChatDelta, turnId: this.turn.id, partId: part.id, content: delta });
	}

	tool(id: string, name: string, input?: unknown, confirmation = false): void {
		if (this.ended) { return; }
		const toolCallId = this.toolId(id);
		if (!this.tools.has(id)) {
			const part: ToolCallResponsePart = { kind: ResponsePartKind.ToolCall, toolCall: { toolCallId, toolName: name, displayName: name, status: ToolCallStatus.Running, invocationMessage: name, confirmed: ToolCallConfirmationReason.NotNeeded } };
			this.tools.set(id, part);
			this.turn.responseParts.push(part);
			this.action({ type: ActionType.ChatToolCallStart, turnId: this.turn.id, toolCallId, toolName: name, displayName: name });
		}
		this.action({ type: ActionType.ChatToolCallReady, turnId: this.turn.id, toolCallId, invocationMessage: name, toolInput: input === undefined ? undefined : JSON.stringify(input), ...(confirmation ? {} : { confirmed: ToolCallConfirmationReason.NotNeeded }) });
	}

	toolResult(id: string, output: unknown, success: boolean): void {
		if (this.ended) { return; }
		if (!this.tools.has(id)) { this.tool(id, id); }
		const part = this.tools.get(id)!;
		const text = nativeText(output) || (output === undefined ? '' : JSON.stringify(output));
		const result: ToolCallResult = { success, pastTenseMessage: part.toolCall.displayName, content: [{ type: ToolResultContentType.Text, text }] };
		part.toolCall = { toolCallId: this.toolId(id), toolName: part.toolCall.toolName, displayName: part.toolCall.displayName, status: ToolCallStatus.Completed, invocationMessage: part.toolCall.displayName, confirmed: ToolCallConfirmationReason.NotNeeded, ...result };
		this.action({ type: ActionType.ChatToolCallComplete, turnId: this.turn.id, toolCallId: this.toolId(id), result });
	}

	dsh(event: NativeRecord): void {
		const data = record(event.data);
		const key = typeof event.seq === 'number' ? String(event.seq) : undefined;
		if (key && this.events.has(key)) { return; }
		if (key) { this.events.add(key); }
		if (event.type === 'assistant/message') {
			const message = record(data.message);
			for (const [index, raw] of (Array.isArray(message.content) ? message.content : []).entries()) {
				const block = record(raw);
				if (block.type === 'text' || block.type === 'reasoning') { this.text(`dsh-${event.seq}-${index}`, nativeText(block), block.type === 'reasoning'); }
				if (block.type === 'tool-call' && typeof block.id === 'string') { this.tool(block.id, String(block.name ?? block.toolName ?? 'tool'), block.input ?? block.arguments); }
			}
		} else if (event.type === 'command/done') {
			this.text(`dsh-command-${event.seq}`, nativeText(data));
		} else if (event.type === 'tool/result') {
			const message = record(data.message);
			const source = record(message.source);
			if (typeof source.callId === 'string') { this.toolResult(source.callId, message.content, message.isError !== true && record(message.error).message === undefined); }
		}
	}

	zcode(event: NativeRecord): { finished?: boolean; error?: string; cancelled?: boolean } {
		const data = record(event.payload ?? event.data);
		const key = typeof event.eventId === 'string' ? event.eventId : undefined;
		if (key && this.events.has(key)) { return {}; }
		if (key) { this.events.add(key); }
		if (event.type === 'model.streaming') {
			if (data.kind === 'text_delta' || data.kind === 'reasoning_delta') {
				const reasoning = data.kind === 'reasoning_delta';
				const key = `${data.assistantMessageId ?? 'assistant'}:${reasoning ? 'reasoning' : 'text'}`;
				const id = String(data.partId ?? key);
				this.streamedParts.set(key, id);
				this.text(id, String(data.delta ?? ''), reasoning);
			}
		} else if (event.type === 'part.delta') {
			if (!this.streamedParts.size && (data.field === 'text' || data.field === 'reasoning')) { this.text(String(data.partId), String(data.delta ?? ''), data.field === 'reasoning'); }
		} else if (event.type === 'part.started' || event.type === 'part.upserted') {
			const part = record(data.part);
			const streamed = this.streamedParts.get(`${part.messageId ?? 'assistant'}:${part.type}`);
			if (streamed && this.parts.has(streamed)) { this.parts.set(String(part.partId), this.parts.get(streamed)!); }
			if (part.type === 'text' || part.type === 'reasoning') { this.text(String(part.partId), String(part.text ?? ''), part.type === 'reasoning', true); }
			if (part.type === 'tool') {
				const state = record(part.state);
				const id = String(part.callId);
				this.tool(id, String(part.tool), state.input);
				if (state.status === 'completed' || state.status === 'error') { this.toolResult(id, state.output ?? state.error, state.status === 'completed'); }
			}
		} else if (event.type === 'tool.updated') {
			const id = String(data.toolCallId);
			if (data.kind === 'scheduled') { this.tool(id, String(data.toolName ?? id), data.input); }
			if (data.kind === 'result') {
				const result = record(data.result);
				this.toolResult(id, result.content ?? result.output ?? data.result, result.isError !== true && result.success !== false);
			}
			if (data.kind === 'error') { this.toolResult(id, record(data.error).message ?? data.error, false); }
		} else if (event.type === 'turn.completed') {
			if (!this.hasText && typeof data.response === 'string') { this.text('final', data.response); }
			return { finished: true, cancelled: data.resultType === 'cancelled', error: data.resultType !== 'success' && data.resultType !== 'cancelled' ? String(data.resultType) : undefined };
		} else if (event.type === 'turn.failed') {
			return { finished: true, error: String(record(data.error).message ?? 'ZCode turn failed.') };
		}
		return {};
	}

	finish(state: TurnState, error?: string): void {
		if (this.ended) { return; }
		for (const [id, part] of this.tools) {
			if (part.toolCall.status !== ToolCallStatus.Completed) { this.toolResult(id, error ?? (state === TurnState.Cancelled ? 'Cancelled' : ''), false); }
		}
		this.ended = true;
		this.turn.state = state;
		this.turn.duration = Date.now() - this.started;
		if (error) {
			const part = createErrorResponsePart({ errorType: 'nativeAgentError', message: error });
			this.turn.responseParts.push(part);
			this.action({ type: ActionType.ChatError, turnId: this.turn.id, duration: this.turn.duration, part });
		} else {
			this.action({ type: state === TurnState.Cancelled ? ActionType.ChatTurnCancelled : ActionType.ChatTurnComplete, turnId: this.turn.id, duration: this.turn.duration });
		}
	}
}
