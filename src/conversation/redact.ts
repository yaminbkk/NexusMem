/**
 * Best-effort secret redaction for collected text before it is ever written
 * to the FTS index.
 *
 * This is a safety net, not a guarantee -- pattern-based redaction cannot
 * catch every shape a secret can take. It exists because conversation text
 * is the collector most likely to contain something sensitive (a pasted
 * credential, a key a user asked for help debugging), but a committed `.env`
 * or a hard-coded key makes the code-diff collector a real second candidate,
 * which is what the `high-confidence` profile below is for.
 */

interface Rule {
  name: string;
  pattern: RegExp;
  /**
   * The match is a secret by its own shape, with no reliance on the
   * surrounding text. Only these rules are safe to run over source code:
   * the shape rules match strings nothing else produces, while the
   * key/value rule matches ordinary code such as
   * `const apiKey = process.env.API_KEY` and would corrupt the very lines
   * a diff is indexed for.
   */
  highConfidence: boolean;
  /** Replacement built from the capture groups; without it the whole match becomes the marker. */
  render?: (groups: readonly string[]) => string;
}

export const REDACTION_MARK = '[redacted]';
const MARK = REDACTION_MARK;
// Every rule refuses to re-match its own marker, so redacting twice changes nothing.
const NOT_MARK = String.raw`(?!\[redacted\])`;
const keepPrefix = (groups: readonly string[]): string => `${groups[0]}${MARK}`;

// The keyword may sit anywhere inside an identifier (DB_PASSWORD, OPENAI_API_KEY, dbPassword, --api-key).
// `token` is singular only: plural keys (max_tokens, rawTokens) are LLM token counts, not credentials.
const SECRET_KEYWORD = String.raw`(?:(?:pass(?:word|wd|phrase)|secret|credential|api[_-]?key|(?:access|private|secret|client|signing|encryption|master)[_-]?key)s?|token)`;
// Bare `pass` needs a prefix component or dashes (DB_PASS, --pass), so prose like "first pass: x" and `bypass` never match.
// Bounded so a long identifier run full of keywords stays linear, not quadratic.
const SECRET_KEY = String.raw`(?:[A-Za-z0-9_.-]{0,100}?${SECRET_KEYWORD}|(?:-{1,2}|(?:[A-Za-z0-9]{1,40}[_.-]){1,8})pass)(?:[_.-][A-Za-z0-9]{1,40}){0,8}`;
// Type annotations (`password: string`) are not values; everything else is hidden, however short.
const TYPE_WORD = String.raw`(?:string|number|boolean|bool|int|str|null|undefined|none|nil|true|false|any|unknown|object)(?=[\s;,)|\]}>]|$)`;
// A quoted value runs to its *closing* quote: an escaped quote inside it (--password "pa\"ss")
// must not end the match, or the tail after it survives redaction. Bounded so an ordinary value
// stops at its own quote; one the bound cannot close (over 500 chars, or never closed) fails
// closed and takes the rest of the line rather than none of it.
const SECRET_VALUE = String.raw`(?:"(?:\\.|[^"\\\r\n]){1,500}"|'(?:\\.|[^'\\\r\n]){1,500}'|\x60(?:\\.|[^\x60\\\r\n]){1,500}\x60|"(?!")[^\r\n]+|'(?!')[^\r\n]+|\x60(?!\x60)[^\r\n]+|[^\s'"\x60]+)`;
// The rest of one shell command: stops at a pipe, `;`, `&` or newline so a tool name never reaches into the next command.
const SAME_COMMAND = String.raw`[^\n|;&]{0,500}?`;
// A next argument that is a flag or a redirection is not a value.
const NOT_FLAG_OR_REDIRECT = String.raw`(?![-<>|&;])`;
const AUTH_SCHEME = String.raw`(?:bearer|basic|token|digest|negotiate|ntlm)`;
/** Everything up to and including curl's credential flag, shared by that rule's quoted and bare branches. */
const CURL_USER = String.raw`\bcurl(?=[ \t])${SAME_COMMAND}[ \t](?:-u|--user)(?:[ \t]+|=)?`;

const RULES: Rule[] = [
  {
    name: 'private-key-block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    highConfidence: true,
  },
  { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g, highConfidence: true },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, highConfidence: true },
  { name: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, highConfidence: true },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    highConfidence: true,
  },
  // scheme://user:password@host -- the password may itself contain `@`, so the host starts after the last one.
  {
    name: 'uri-credentials',
    pattern: new RegExp(
      String.raw`(\b[a-z][a-z0-9+.-]{1,30}://[^\s/?#'"@:]*:)${NOT_MARK}[^\s/?#'"]+(?=@[^\s/?#'"@]*(?:[/?#\s'"]|$))`,
      'gi',
    ),
    highConfidence: true,
    render: keepPrefix,
  },
  // An option whose name ends in `bearer` (`--oauth2-bearer x`) always takes a credential, whatever
  // the token looks like. The prose-shaped rule below cannot cover it: it needs a digit, so an
  // all-alphabetic token would survive.
  {
    name: 'bearer-option-arg',
    pattern: new RegExp(
      String.raw`(?<=^|[\s'"(])(-{1,2}[A-Za-z0-9_.-]{0,40}bearer[ \t]+)${NOT_FLAG_OR_REDIRECT}${NOT_MARK}${SECRET_VALUE}`,
      'gi',
    ),
    highConfidence: true,
    render: keepPrefix,
  },
  // A bearer token outside a header (`Bearer x`); it must contain a digit so "bearer authentication" is left alone.
  {
    name: 'bearer-token',
    pattern: new RegExp(String.raw`(\bbearer[ \t]+)${NOT_MARK}(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{16,}=*`, 'gi'),
    highConfidence: true,
    render: keepPrefix,
  },
  // Tool-anchored password arguments: `-p` means port or parents almost everywhere else. Case-sensitive (`-P` is mysql's port).
  // mysql takes only the compact `-psecret` form; `-p secret` means "prompt, then use database secret".
  {
    name: 'mysql-password-arg',
    pattern: new RegExp(
      String.raw`(\b(?:mysql|mysqldump|mysqladmin|mysqlimport|mysqlsh|mariadb|mariadb-dump)(?=[ \t])${SAME_COMMAND}[ \t]-p)${NOT_MARK}(?=\S)${SECRET_VALUE}`,
      'g',
    ),
    highConfidence: true,
    render: keepPrefix,
  },
  // Only sshpass's own options may precede -p, so a wrapped `ssh -p 22` is never read as the password.
  {
    name: 'sshpass-password-arg',
    pattern: new RegExp(String.raw`(\bsshpass(?:[ \t]+-[^p\s]\S*)*[ \t]+-p[ \t]*)${NOT_MARK}(?=\S)${SECRET_VALUE}`, 'g'),
    highConfidence: true,
    render: keepPrefix,
  },
  {
    name: 'mongo-password-arg',
    pattern: new RegExp(
      String.raw`(\bmongo(?:sh|dump|restore|export|import|stat|top|files)?(?=[ \t])${SAME_COMMAND}[ \t]-p[ \t]+)${NOT_FLAG_OR_REDIRECT}${NOT_MARK}${SECRET_VALUE}`,
      'g',
    ),
    highConfidence: true,
    render: keepPrefix,
  },
  {
    name: 'redis-cli-password-arg',
    pattern: new RegExp(
      String.raw`(\bredis-cli(?=[ \t])${SAME_COMMAND}[ \t]-a[ \t]+)${NOT_FLAG_OR_REDIRECT}${NOT_MARK}${SECRET_VALUE}`,
      'g',
    ),
    highConfidence: true,
    render: keepPrefix,
  },
  // Quoted credentials get their own branches: `curl -u "user:pass word"` holds a space, which
  // the unquoted branch would stop at, leaving the rest of the password in the text. Like
  // SECRET_VALUE, they step over escaped characters so `"alice:pa\"ss"` is not cut at `\"`. Inside
  // quotes the user name may hold a space too (`"alice smith:pw"`); only the quote ends it.
  {
    name: 'curl-user-password',
    pattern: new RegExp(
      String.raw`(${CURL_USER}"(?:\\.|[^:"\\\r\n])*:)${NOT_MARK}(?:\\.|[^"\\\r\n])*|(${CURL_USER}'(?:\\.|[^:'\\\r\n])*:)${NOT_MARK}(?:\\.|[^'\\\r\n])*|(${CURL_USER}[^\s:'"]*:)${NOT_MARK}[^\s'"]+`,
      'g',
    ),
    highConfidence: true,
    render: (groups) => `${groups.find((g) => g.length > 0) ?? ''}${MARK}`,
  },
  // Authorization: Bearer x / Basic x / token x. The scheme word is kept; it must not be mistaken for the value.
  {
    name: 'authorization-header',
    pattern: new RegExp(
      String.raw`(\b(?:proxy-)?authorization["']?[ \t]*[:=][ \t]*["'\x60]?(?:${AUTH_SCHEME}[ \t]+)?)(?!${AUTH_SCHEME}[ \t])${NOT_MARK}[^\s'"\x60]+`,
      'gi',
    ),
    highConfidence: false,
    render: keepPrefix,
  },
  // `--password secret`: a secret-named option whose value is the next argument. The flag must start a
  // command-line word, so prose like "the `id`-token heuristic" is not read as a `-token` option.
  {
    name: 'secret-option-arg',
    pattern: new RegExp(
      String.raw`(?<=^|[\s'"(])(-{1,2}${SECRET_KEY}[ \t]+)${NOT_FLAG_OR_REDIRECT}${NOT_MARK}${SECRET_VALUE}`,
      'gi',
    ),
    highConfidence: false,
    render: keepPrefix,
  },
  // key/token/secret/password = "value" or : value, in code, JSON, env-file, shell or prose form.
  // The key start is an explicit non-identifier lookbehind, not `\b`: `_` is a word character, so
  // `\b` never fired inside DB_PASSWORD and the value leaked. Found live via `scan-shell`.
  {
    name: 'key-value-secret',
    pattern: new RegExp(
      String.raw`(?<![A-Za-z0-9_.-])(${SECRET_KEY})["']?[ \t]*[:=](?![=>])[ \t]*(?!${TYPE_WORD})${NOT_MARK}${SECRET_VALUE}`,
      'gi',
    ),
    highConfidence: false,
    // Keep the key name so the redaction is legible ("apiKey: [redacted]").
    render: (groups) => `${groups[0]}: ${MARK}`,
  },
];

export interface RedactResult {
  text: string;
  redactedCount: number;
}

/**
 * `all` runs every rule -- the right trade for prose, where a false positive
 * costs a mangled sentence. `high-confidence` runs only the shape rules, for
 * text that *is* code and must survive redaction intact.
 */
export type RedactProfile = 'all' | 'high-confidence';

export function redact(text: string, profile: RedactProfile = 'all'): RedactResult {
  let redactedCount = 0;
  let out = text;

  for (const rule of RULES) {
    if (profile === 'high-confidence' && !rule.highConfidence) continue;
    out = out.replace(rule.pattern, (...args: unknown[]) => {
      redactedCount += 1;
      // `replace` passes (match, ...groups, offset, wholeString): the groups end at the first
      // number. Slicing by type keeps a match offset from ever being mistaken for a group.
      const end = args.findIndex((arg, i) => i > 0 && typeof arg === 'number');
      const groups = args.slice(1, end).map((g) => (typeof g === 'string' ? g : ''));
      return rule.render ? rule.render(groups) : MARK;
    });
  }

  return { text: out, redactedCount };
}
