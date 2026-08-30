import { describe, expect, it } from 'vitest';
import { buildContextPrompt, describeLanguageModelErrorCode, describeSearchError } from '../src/chatPrompt.js';
import { ServerNotFoundError } from '../src/mcpClient.js';

describe('buildContextPrompt', () => {
  it('wraps the context block with instructions scoping the model to it', () => {
    const prompt = buildContextPrompt('fix: handle the retry timeout correctly');
    expect(prompt).toContain('fix: handle the retry timeout correctly');
    expect(prompt).toContain('ONLY the memory context below');
    expect(prompt.toLowerCase()).toContain('nexusmem');
  });

  it('fences the context block clearly so it cannot be confused with the instruction text', () => {
    const prompt = buildContextPrompt('some context');
    expect(prompt).toContain('--- MEMORY CONTEXT ---');
    expect(prompt).toContain('--- END MEMORY CONTEXT ---');
  });
});

describe('describeSearchError', () => {
  it('points at the cliPath setting for a ServerNotFoundError', () => {
    const description = describeSearchError(new ServerNotFoundError('nexusmem', new Error('boom')));
    expect(description.showCliPathSetting).toBe(true);
    expect(description.message).toContain('nexusmem');
  });

  it('does not offer the cliPath setting for a generic error', () => {
    const description = describeSearchError(new Error('search_memory returned an error'));
    expect(description.showCliPathSetting).toBe(false);
    expect(description.message).toContain('search_memory returned an error');
  });

  it('stringifies a non-Error thrown value instead of crashing', () => {
    const description = describeSearchError('a plain string throw');
    expect(description.message).toContain('a plain string throw');
  });
});

describe('describeLanguageModelErrorCode', () => {
  it('maps every documented vscode.LanguageModelError code to a distinct, actionable message', () => {
    const codes = ['NoPermissions', 'Blocked', 'NotFound'];
    const messages = codes.map(describeLanguageModelErrorCode);
    expect(new Set(messages).size).toBe(messages.length); // discriminating: catches a copy-pasted duplicate mapping
  });

  it('falls back to a generic message for an unrecognized code', () => {
    const message = describeLanguageModelErrorCode('Unknown');
    expect(message.length).toBeGreaterThan(0);
  });
});
