/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { rewriteMarkdownLinks } from '../../../../../base/common/markdownLinks.js';
import { URI } from '../../../../../base/common/uri.js';

/** One path segment: letters, digits and the punctuation file names commonly use. No spaces, globs, quotes or brackets. */
const segment = String.raw`[\p{L}\p{N}_.@+~%,=-]+`;

/**
 * An absolute file path with an extension, optionally followed by a line and column. Windows drive paths use either
 * kind of separator. A path without an extension is not matched: `/api/users` is as likely a route as a file.
 */
const filePath = new RegExp(String.raw`^(?<root>/|[A-Za-z]:[\\/])(?<dirs>(?:${segment}[\\/])*)(?<name>${segment}\.[\p{L}][\p{L}\p{N}_-]*)(?::(?<line>[1-9]\d*)(?::(?<column>[1-9]\d*))?)?$`, 'u');

/**
 * The file link for an inline code span that is nothing but an absolute file path, or `undefined`. The link has no
 * text, so the chat renders it as the file widget that a reference to the file gets.
 */
export function inlineCodeFileLink(code: string): string | undefined {
	const match = filePath.exec(code);
	if (!match?.groups) {
		return undefined;
	}
	const { root, dirs, name, line, column } = match.groups;
	// `.` and `..` segments mean the path is relative to something else.
	if (dirs.split(/[\\/]/).some(directory => /^\.+$/.test(directory))) {
		return undefined;
	}
	const path = `${root}${dirs}${name}`.replaceAll('\\', '/');
	const fragment = line ? `L${line}${column && column !== '1' ? `,${column}` : ''}` : '';
	return `[](${URI.file(path).with({ fragment }).toString()})`;
}

/**
 * Turns the inline code spans of a markdown text that name an absolute file path into links to the file, so that an
 * agent that writes `/home/me/app/main.ts` in backticks gets the same file widget as one that writes a link. Links,
 * code blocks and everything else are left as written.
 */
export function linkifyInlineCodeFilePaths(markdown: string): string {
	if (!markdown.includes('`')) {
		return markdown;
	}
	return rewriteMarkdownLinks(markdown, {
		rewriteLink: () => undefined,
		rewriteCodeSpan: token => inlineCodeFileLink(token.text),
	});
}
