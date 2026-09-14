import { describe, expect, it } from 'vitest';
import { repoRelative, toNativePath } from '../eval/ambient/paths.js';

/**
 * Harness-only scoring. The Phase-5 eval recorded one ambient run as having
 * never edited the fix file when it demonstrably had: Claude Code reported
 * the edit as `/c/Users/.../app/src/parse.js` while the harness held the
 * native `C:\Users\...\app`, and `path.relative` on win32 relates those two
 * by prefixing the current drive instead of failing loudly.
 *
 * `platform` is passed explicitly throughout so the win32 rules are exercised
 * wherever this suite runs.
 */

const WIN_REPO = 'C:\\Users\\dev\\AppData\\Local\\Temp\\workspace-AH0HSV\\app';

describe('toNativePath', () => {
  it('leaves a native Windows path alone', () => {
    expect(toNativePath(`${WIN_REPO}\\src\\parse.js`, 'win32')).toBe(`${WIN_REPO}\\src\\parse.js`);
  });

  it('converts a Git Bash drive path to its native spelling', () => {
    expect(toNativePath('/c/Users/dev/app/src/parse.js', 'win32')).toBe('C:\\Users\\dev\\app\\src\\parse.js');
  });

  it('converts a WSL mount path to its native spelling', () => {
    expect(toNativePath('/mnt/c/Users/dev/app/src/parse.js', 'win32')).toBe('C:\\Users\\dev\\app\\src\\parse.js');
  });

  it('uppercases the drive letter, since the native side is spelled that way', () => {
    expect(toNativePath('/d/projects/app/check.js', 'win32')).toBe('D:\\projects\\app\\check.js');
  });

  it('never rewrites drive-shaped directories on a POSIX host', () => {
    // `/c/tools` and `/mnt/c/data` are ordinary directories there.
    expect(toNativePath('/c/tools/app/src/parse.js', 'linux')).toBe('/c/tools/app/src/parse.js');
    expect(toNativePath('/mnt/c/data/app/src/parse.js', 'linux')).toBe('/mnt/c/data/app/src/parse.js');
  });
});

describe('repoRelative', () => {
  it('scores the real Phase-5 case that was lost: a Git Bash edit path against a native repo dir', () => {
    // Verbatim from retry-regression/ambient/#3, the run this bug mis-scored.
    const reported = '/c/Users/user-0118012023/AppData/Local/Temp/workspace-AH0HSV/app/src/parse.js';
    const repo = 'C:\\Users\\user-0118012023\\AppData\\Local\\Temp\\workspace-AH0HSV\\app';
    expect(repoRelative(repo, reported, 'win32')).toBe('src/parse.js');
  });

  it('scores a native Windows edit path', () => {
    expect(repoRelative(WIN_REPO, `${WIN_REPO}\\src\\parse.js`, 'win32')).toBe('src/parse.js');
  });

  it('scores a WSL edit path', () => {
    const repo = 'C:\\Users\\dev\\app';
    expect(repoRelative(repo, '/mnt/c/Users/dev/app/src/writer.js', 'win32')).toBe('src/writer.js');
  });

  it('scores a POSIX edit path on a POSIX host', () => {
    expect(repoRelative('/home/dev/app', '/home/dev/app/src/writer.js', 'linux')).toBe('src/writer.js');
  });

  it('handles a repository path containing spaces', () => {
    const repo = 'C:\\Users\\dev\\my repo\\app';
    expect(repoRelative(repo, '/c/Users/dev/my repo/app/src/parse.js', 'win32')).toBe('src/parse.js');
    expect(repoRelative(repo, `${repo}\\src\\parse.js`, 'win32')).toBe('src/parse.js');
  });

  it('does not collide two files that share a basename in different directories', () => {
    const repo = 'C:\\Users\\dev\\app';
    const reader = repoRelative(repo, '/c/Users/dev/app/src/read/buffer.js', 'win32');
    const writer = repoRelative(repo, '/c/Users/dev/app/src/write/buffer.js', 'win32');
    expect(reader).toBe('src/read/buffer.js');
    expect(writer).toBe('src/write/buffer.js');
    expect(reader).not.toBe(writer);
  });

  it('agrees across spellings: the same file reported three ways scores as one path', () => {
    const repo = 'C:\\Users\\dev\\app';
    const scored = new Set([
      repoRelative(repo, `${repo}\\src\\parse.js`, 'win32'),
      repoRelative(repo, '/c/Users/dev/app/src/parse.js', 'win32'),
      repoRelative(repo, '/mnt/c/Users/dev/app/src/parse.js', 'win32'),
    ]);
    expect([...scored]).toEqual(['src/parse.js']);
  });

  it('a file genuinely outside the repository does not become a repo-relative path', () => {
    const repo = 'C:\\Users\\dev\\app';
    expect(repoRelative(repo, '/c/Users/dev/other/src/parse.js', 'win32')).toBe('../other/src/parse.js');
  });
});
