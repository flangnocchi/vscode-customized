/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { formatTokenCount } from '../../../base/common/numbers.js';
import { localize } from '../../../nls.js';
import { hasLongContextSurcharge, type ICAPIModelBilling } from './agentModelPricing.js';
import { getReasoningEffortDescription, getReasoningEffortLabel, resolveDefaultReasoningEffort } from './reasoningEffort.js';
import type { ConfigPropertySchema, ModelSelection } from './state/protocol/state.js';

/** Model-configuration key for the selected context-window size, in tokens. */
export const ContextSizeConfigKey = 'contextSize';

/** Builds a thinking-level picker from the efforts advertised by a model. */
export function createThinkingLevelConfigSchemaProperty(
	supportedEfforts: readonly { readonly reasoningEffort: string; readonly description?: string }[] | undefined,
	declaredDefault?: string,
	modelId?: string,
): ConfigPropertySchema | undefined {
	if (!supportedEfforts?.length) {
		return undefined;
	}
	const efforts = supportedEfforts.map(option => option.reasoningEffort);
	return {
		type: 'string',
		title: localize('agent.modelThinkingLevel.title', "Thinking Level"),
		description: localize('agent.modelThinkingLevel.description', "Controls how much reasoning effort the model uses."),
		default: resolveDefaultReasoningEffort(efforts, declaredDefault, modelId),
		enum: efforts,
		enumLabels: efforts.map(getReasoningEffortLabel),
		enumDescriptions: supportedEfforts.map(option => option.description || getReasoningEffortDescription(option.reasoningEffort) || ''),
	};
}

/**
 * Synthesizes the shared context-size picker property for a CAPI model with a
 * distinct long-context tier.
 */
export function createContextSizeConfigSchemaProperty(billing: ICAPIModelBilling | undefined): ConfigPropertySchema | undefined {
	const tokenPrices = billing?.tokenPrices;
	const defaultMax = tokenPrices?.contextMax;
	const longContextMax = tokenPrices?.longContext?.contextMax;
	return createContextSizeConfigSchemaPropertyFromLimits(
		defaultMax,
		longContextMax,
		hasLongContextSurcharge(billing) ? defaultMax : longContextMax,
	);
}

/**
 * Synthesizes the shared context-size picker property from provider-owned limits.
 */
export function createContextSizeConfigSchemaPropertyFromLimits(defaultMax: number | undefined, longContextMax: number | undefined, selectedDefault = defaultMax): ConfigPropertySchema | undefined {
	if (!defaultMax || !longContextMax || defaultMax >= longContextMax) {
		return undefined;
	}

	return {
		type: 'number',
		title: localize('copilot.modelContextSize.title', "Context Size"),
		description: localize('copilot.modelContextSize.description', "Selects the context window size for this model."),
		default: selectedDefault === longContextMax ? longContextMax : defaultMax,
		enum: [defaultMax, longContextMax],
		enumLabels: [formatTokenCount(defaultMax), formatTokenCount(longContextMax)],
		enumDescriptions: [
			localize('copilot.modelContextSize.default', "Default"),
			localize('copilot.modelContextSize.longerSessions', "Longer sessions"),
		],
	};
}

/** Reads a finite, positive context-window selection from a model config. */
export function getModelContextSize(model: ModelSelection | undefined): number | undefined {
	const value = Number(model?.config?.[ContextSizeConfigKey]);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}
