import { ServerNotFoundError } from './mcpClient.js';

/**
 * Pure prompt/error-formatting logic for the `@nexusmem` chat participant,
 * kept free of the `vscode` import so it can be unit tested directly -- same
 * split `failureDetection.ts` already established. The `vscode.chat`
 * wiring that calls these lives in `extension.ts`, where it cannot be unit
 * tested outside a real extension host.
 */

/**
 * The instruction message sent to the chat model ahead of the user's own
 * prompt. Explicitly scopes the model to the retrieved context rather than
 * letting it fall back on general knowledge about the repository it was
 * never actually shown.
 */
export function buildContextPrompt(contextBlock: string): string {
  return [
    "You are NexusMem's chat assistant inside VS Code, answering questions about this repository's remembered history.",
    'Answer using ONLY the memory context below -- it was retrieved from this repository\'s own tracked git commits, diffs, shell commands, docs, conversations and (if enabled) github issues/PRs.',
    "If the context doesn't answer the question, say so plainly instead of guessing or relying on general knowledge.",
    '',
    '--- MEMORY CONTEXT ---',
    contextBlock,
    '--- END MEMORY CONTEXT ---',
  ].join('\n');
}

export interface SearchErrorDescription {
  message: string;
  /** Whether to offer a button opening the nexusmem.cliPath setting -- only makes sense for a ServerNotFoundError. */
  showCliPathSetting: boolean;
}

/** Same branch `reportServerError` in extension.ts draws for the other commands, reshaped as data instead of a side effect so it's testable here. */
export function describeSearchError(error: unknown): SearchErrorDescription {
  if (error instanceof ServerNotFoundError) {
    return { message: error.message, showCliPathSetting: true };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { message: `NexusMem search failed: ${message}`, showCliPathSetting: false };
}

/**
 * Maps a `vscode.LanguageModelError.code` to a message a chat user can act
 * on. Takes the string code rather than the class itself so this stays
 * import-free of `vscode` -- the `instanceof` check that produces the code
 * lives in `extension.ts`.
 */
export function describeLanguageModelErrorCode(code: string): string {
  switch (code) {
    case 'NoPermissions':
      return "This chat session doesn't have permission to use the selected language model yet -- try the request again and accept the consent prompt.";
    case 'Blocked':
      return "The selected language model blocked this request (e.g. a quota limit). NexusMem's raw retrieved context is shown below instead.";
    case 'NotFound':
      return 'The selected language model is no longer available. Pick a different model in the chat panel and try again.';
    default:
      return "Something went wrong asking the language model to answer from NexusMem's memory. The raw retrieved context is shown below instead.";
  }
}
