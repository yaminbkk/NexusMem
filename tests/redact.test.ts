import { describe, expect, it } from 'vitest';
import { redact } from '../src/conversation/redact.js';

/**
 * Security regression suite for the `key-value-secret` rule. Found live by a
 * user running `scan-shell` on real history: the rule's leading `\b` never
 * fires between `_` and a keyword, so `PASSWORD=x` redacted while
 * `DB_PASSWORD=x` printed the live value.
 */

const SECRET_KEYS = [
  'PASSWORD',
  'DB_PASSWORD',
  'MYSQL_PASSWORD',
  'PROD_PASSWORD',
  'DATABASE_PASSWORD',
  'PGPASSWORD',
  'API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'SECRET',
  'CLIENT_SECRET',
  'SECRET_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'TOKEN',
  'AUTH_TOKEN',
  'GITHUB_TOKEN',
  'DB_PASS',
  'DB_PASSWORD_PROD',
  'prod-api-key',
  'db_password',
  'openai_api_key',
  'Db_Password',
  'dbPassword',
  'spring.datasource.password',
];

describe('redact key-value-secret: prefixed key names', () => {
  it.each(SECRET_KEYS)('redacts %s=secret', (key) => {
    expect(redact(`${key}=secret`).text).toBe(`${key}: [redacted]`);
  });

  it.each(SECRET_KEYS)('redacts %s: secret', (key) => {
    expect(redact(`${key}: secret`).text).toBe(`${key}: [redacted]`);
  });
});

describe('redact key-value-secret: shell forms', () => {
  it.each([
    ['export DB_PASSWORD=secret', 'export DB_PASSWORD: [redacted]'],
    ['DB_PASSWORD="secret"', 'DB_PASSWORD: [redacted]'],
    ["DB_PASSWORD='secret'", 'DB_PASSWORD: [redacted]'],
    ['DB_PASSWORD = secret', 'DB_PASSWORD: [redacted]'],
    ['set DB_PASSWORD=secret', 'set DB_PASSWORD: [redacted]'],
    ['$env:DB_PASSWORD="secret"', '$env:DB_PASSWORD: [redacted]'],
    ["$env:DB_PASSWORD = 'secret'", '$env:DB_PASSWORD: [redacted]'],
    ['DB_PASSWORD=secret command', 'DB_PASSWORD: [redacted] command'],
    ['DB_USER=admin DB_PASSWORD=secret psql -h db', 'DB_USER=admin DB_PASSWORD: [redacted] psql -h db'],
    ['export PASSWORD=my-secret', 'export PASSWORD: [redacted]'],
    ['export DB_PASSWORD=my-secret', 'export DB_PASSWORD: [redacted]'],
    ['mytool --password=secret --verbose', 'mytool --password: [redacted] --verbose'],
    ['mytool --api-key=secret', 'mytool --api-key: [redacted]'],
    ['mytool --pass=secret', 'mytool --pass: [redacted]'],
  ])('%s', (input, expected) => {
    expect(redact(input).text).toBe(expected);
  });

  it('hides the whole value when it contains shell-special characters', () => {
    const result = redact('DB_PASSWORD=p@ss!w0rd#$%^&* psql');
    expect(result.text).toBe('DB_PASSWORD: [redacted] psql');
  });

  it('hides a quoted value that contains spaces', () => {
    expect(redact('DB_PASSWORD="correct horse battery staple" psql').text).toBe('DB_PASSWORD: [redacted] psql');
  });

  it('hides short values -- a real password is not guaranteed to be 8+ characters', () => {
    expect(redact('DB_PASSWORD=abc').text).toBe('DB_PASSWORD: [redacted]');
  });

  it('redacts a quoted JSON key', () => {
    const result = redact('{"db_password": "secret-value"}');
    expect(result.text).not.toContain('secret-value');
    expect(result.text).toContain('db_password: [redacted]');
  });

  it('counts each redacted assignment', () => {
    expect(redact('A_TOKEN=x B_PASSWORD=y').redactedCount).toBe(2);
  });
});

const URI_CASES: Array<[string, string]> = [
  ['psql postgres://app:s3cret@db.example.com:5432/app', 'psql postgres://app:[redacted]@db.example.com:5432/app'],
  ['postgresql://app:p@ss@db:5432/app', 'postgresql://app:[redacted]@db:5432/app'],
  ['mysql://root:pw@127.0.0.1/db', 'mysql://root:[redacted]@127.0.0.1/db'],
  ['mongodb+srv://u:pw@cluster0.x.mongodb.net/?retryWrites=true', 'mongodb+srv://u:[redacted]@cluster0.x.mongodb.net/?retryWrites=true'],
  ['redis://:hunter2@localhost:6379/0', 'redis://:[redacted]@localhost:6379/0'],
  ['git clone https://x-access-token:abc123@github.com/o/r.git', 'git clone https://x-access-token:[redacted]@github.com/o/r.git'],
  ['DATABASE_URL="postgres://u:pw@h/db" npm start', 'DATABASE_URL="postgres://u:[redacted]@h/db" npm start'],
  ['jdbc:postgresql://u:pw@h:5432/db', 'jdbc:postgresql://u:[redacted]@h:5432/db'],
];

const AUTH_CASES: Array<[string, string]> = [
  ['curl -H "Authorization: Bearer abc.def.ghi" https://api', 'curl -H "Authorization: Bearer [redacted]" https://api'],
  ["curl -H 'authorization: bearer sk-live-123' https://api", "curl -H 'authorization: bearer [redacted]' https://api"],
  ['Authorization: Basic dXNlcjpwYXNz', 'Authorization: Basic [redacted]'],
  ['Authorization: token ghp_short', 'Authorization: token [redacted]'],
  ['{"Authorization": "Bearer xyz789"}', '{"Authorization": "Bearer [redacted]"}'],
  ['Proxy-Authorization: Basic Zm9vOmJhcg==', 'Proxy-Authorization: Basic [redacted]'],
  ['Authorization: s3cr3t-raw-token', 'Authorization: [redacted]'],
  ['curl --oauth2-bearer 9f8e7d6c5b4a39281706 https://api', 'curl --oauth2-bearer [redacted] https://api'],
];

const ARG_CASES: Array<[string, string]> = [
  ['mytool --password secret --verbose', 'mytool --password [redacted] --verbose'],
  ["deploy --db-password 'correct horse' -y", 'deploy --db-password [redacted] -y'],
  ['keytool -password secret', 'keytool -password [redacted]'],
  ['gh auth login --token abc123', 'gh auth login --token [redacted]'],
  ['cli --api-key abc --client-secret def', 'cli --api-key [redacted] --client-secret [redacted]'],
  ['mysql -uroot -psecret app', 'mysql -uroot -p[redacted] app'],
  ["mysqldump -u root -p'se cret' app > dump.sql", 'mysqldump -u root -p[redacted] app > dump.sql'],
  ['/usr/bin/mariadb -h db -pS3cret!', '/usr/bin/mariadb -h db -p[redacted]'],
  ['sshpass -p secret ssh user@host', 'sshpass -p [redacted] ssh user@host'],
  ['sshpass -v -psecret scp f host:', 'sshpass -v -p[redacted] scp f host:'],
  ['mongosh -u admin -p secret --host db', 'mongosh -u admin -p [redacted] --host db'],
  ['redis-cli -h cache -a secret ping', 'redis-cli -h cache -a [redacted] ping'],
  ['curl -u admin:secret https://x', 'curl -u admin:[redacted] https://x'],
  ['curl --user=admin:secret https://x', 'curl --user=admin:[redacted] https://x'],
];

describe('redact: connection URI credentials', () => {
  it.each(URI_CASES)('%s', (input, expected) => {
    expect(redact(input).text).toBe(expected);
  });

  it.each([
    'curl http://localhost:8080/health',
    'open https://user@example.com/profile',
    'git clone git@github.com:o/r.git',
    'see http://example.com/a:b@c',
  ])('leaves a URI without a password alone: %s', (text) => {
    expect(redact(text)).toEqual({ text, redactedCount: 0 });
  });
});

describe('redact: Authorization headers and bearer tokens', () => {
  it.each(AUTH_CASES)('%s', (input, expected) => {
    expect(redact(input).text).toBe(expected);
  });

  it.each(['we use bearer authentication for the API', 'Bearer tokens expire hourly'])('leaves prose alone: %s', (text) => {
    expect(redact(text)).toEqual({ text, redactedCount: 0 });
  });
});

describe('redact: separated and tool-specific password arguments', () => {
  it.each(ARG_CASES)('%s', (input, expected) => {
    expect(redact(input).text).toBe(expected);
  });

  it.each([
    'mysql -h db -u root -p',
    'mysql -p app',
    'mysql -P 3306 -h db',
    'ssh -p 22 host',
    'mkdir -p src/lib',
    'docker run -p 8080:80 nginx',
    'sshpass -f pw.txt ssh -p 22 host',
    'mongo-express -p 8081',
    'echo "$PW" | docker login --username me --password-stdin',
    'docker login --password-stdin < pw.txt',
    'curl -u admin https://x',
    // Measured false positives on this repo's own conversation corpus.
    'the `id`-token boilerplate false positive',
    'fixed the `id`-token heuristic',
  ])('leaves a non-secret argument alone: %s', (text) => {
    expect(redact(text)).toEqual({ text, redactedCount: 0 });
  });
});

describe('redact: idempotence and profiles', () => {
  const ALL_POSITIVE = [...SECRET_KEYS.map((k) => `${k}=secret`), ...URI_CASES, ...AUTH_CASES, ...ARG_CASES].map((c) =>
    Array.isArray(c) ? c[0] : c,
  );

  it.each(ALL_POSITIVE)('redacting twice changes nothing: %s', (input) => {
    const once = redact(input);
    expect(redact(once.text)).toEqual({ text: once.text, redactedCount: 0 });
  });

  it('applies URI, bearer and tool-anchored rules to code (high-confidence), but not key/value or option rules', () => {
    expect(redact('+ const url = "postgres://u:pw@h/db"', 'high-confidence').text).toBe('+ const url = "postgres://u:[redacted]@h/db"');
    expect(redact('+mysql -uroot -psecret app', 'high-confidence').text).toBe('+mysql -uroot -p[redacted] app');
    expect(redact('+ const password = process.env.DB_PASSWORD', 'high-confidence').redactedCount).toBe(0);
    expect(redact('+ run("--password", pw)', 'high-confidence').redactedCount).toBe(0);
  });
});

/**
 * Three ways a secret used to survive redaction, all reported in review of the
 * v0.10.5 branch and all reproduced against that code before being fixed here:
 * a quoted value ending early at an escaped quote, an option-borne bearer token
 * with no digit in it, and a quoted curl credential containing a space.
 */
describe('redact: values that used to end the match early', () => {
  const BS = String.fromCharCode(92);

  it.each([
    ['double quotes', `export API_PASSWORD="pa${BS}"ss-TAIL"`],
    ['single quotes', `--password 'pa${BS}'ss-TAIL'`],
    ['backticks', `--password ${String.fromCharCode(96)}pa${BS}${String.fromCharCode(96)}ss-TAIL${String.fromCharCode(96)}`],
  ])('redacts through an escaped quote inside a %s value', (_label, input) => {
    const { text } = redact(input);

    expect(text).not.toContain('TAIL');
    expect(text).toContain('[redacted]');
  });

  it.each([
    ['alphabetic token', 'curl --oauth2-bearer abcdefghijklmnopqrstuvwx https://api.example.com', 'abcdefghijklmnopqrstuvwx'],
    ['short token', 'curl --oauth-bearer shortie https://api.example.com', 'shortie'],
    ['digit-bearing token', 'curl --oauth2-bearer abcdefghijklmnop1234 https://api.example.com', 'abcdefghijklmnop1234'],
  ])('redacts a bearer option argument regardless of its shape: %s', (_label, input, secret) => {
    const { text } = redact(input);

    expect(text).not.toContain(secret);
    expect(text).toContain('--oauth');
  });

  it.each([
    ['double-quoted', 'curl -u "alice:pass word-TAIL" https://api.example.com'],
    ['single-quoted', "curl -u 'alice:pass word-TAIL' https://api.example.com"],
    ['--user long form', 'curl --user "alice:pass word-TAIL" https://api.example.com'],
  ])('redacts a whole %s curl credential, spaces included', (_label, input) => {
    const { text } = redact(input);

    expect(text).not.toContain('TAIL');
    expect(text).not.toContain('pass word');
    // The user name is context, not a credential, and stays readable.
    expect(text).toContain('alice:');
  });

  it.each([
    ['double-quoted password', `curl -u "alice:pa${BS}"ss-TAIL" https://api.example.com`],
    ['single-quoted password', `curl -u 'alice:pa${BS}'ss-TAIL' https://api.example.com`],
    ['double-quoted user name', `curl -u "al${BS}"ice:pass-TAIL" https://api.example.com`],
  ])('redacts through an escaped quote in a %s of a curl credential', (_label, input) => {
    const { text } = redact(input);

    expect(text).not.toContain('TAIL');
    expect(text).toContain('[redacted]');
    expect(redact(text)).toEqual({ text, redactedCount: 0 });
  });

  it.each([
    ['-u, double-quoted, space in user name', 'curl -u "alice smith:pw-TAIL" https://api.example.com'],
    ['--user, double-quoted, space in user name', 'curl --user "alice smith:pw-TAIL" https://api.example.com'],
    ['-u, single-quoted, space in user name', "curl -u 'alice smith:pw-TAIL' https://api.example.com"],
    ['spaces in both user name and password', 'curl -u "alice smith:correct horse-TAIL" https://api.example.com'],
    ['escaped quote in user name, space in password', `curl -u "al${BS}"ice:pass word-TAIL" https://api.example.com`],
    ['escaped quote in password, space in user name', `curl -u "alice smith:pa${BS}"ss-TAIL" https://api.example.com`],
    ['unclosed quote, space in user name', 'curl -u "alice smith:pw-TAIL'],
    ['over-long quoted password', `curl -u "alice smith:${'Z'.repeat(600)}-TAIL" https://api.example.com`],
  ])('redacts a quoted curl credential whose user name may hold a space: %s', (_label, input) => {
    const { text } = redact(input);

    expect(text).not.toContain('TAIL');
    expect(text).toContain('[redacted]');
    expect(redact(text)).toEqual({ text, redactedCount: 0 });
  });

  it('keeps a quoted curl user name readable, and leaves a quoted user with no password alone', () => {
    expect(redact('curl -u "alice smith:pw-TAIL" https://api.example.com').text).toBe(
      'curl -u "alice smith:[redacted]" https://api.example.com',
    );
    for (const input of [
      'curl -u "alice smith" https://api.example.com:8443/v1',
      'Note: the curl docs say user: admin is only an example',
      'curl -u "alice smith:[redacted]" https://api.example.com',
    ]) {
      expect(redact(input)).toEqual({ text: input, redactedCount: 0 });
    }
  });

  const LONG = `${'Z'.repeat(600)}-TAIL`;
  const BT = String.fromCharCode(96);
  it.each([
    ['double-quoted key/value', `export DB_PASSWORD="${LONG}"`],
    ['single-quoted key/value', `DB_PASSWORD='${LONG}'`],
    ['backtick key/value', `DB_PASSWORD=${BT}${LONG}${BT}`],
    ['secret option', `app --password "${LONG}" --verbose`],
    ['bearer option', `curl --oauth2-bearer '${LONG}' https://api.example.com`],
    ['mysql', `mysql -uroot -p"${LONG}" app`],
    ['sshpass', `sshpass -p "${LONG}" ssh host`],
    ['mongo', `mongosh -p "${LONG}" admin`],
    ['redis-cli', `redis-cli -a '${LONG}' ping`],
    ['unterminated double quote', 'export DB_PASSWORD="pass-TAIL'],
    ['unterminated single quote', "app --password 'pass-TAIL"],
  ])('fails closed on a %s value its bounded quote cannot close', (_label, input) => {
    const { text } = redact(input);

    expect(text).not.toContain('TAIL');
    expect(text).toContain('[redacted]');
    expect(redact(text)).toEqual({ text, redactedCount: 0 });
  });

  it('keeps the bounded match for an ordinary quoted value, and leaves an empty one alone', () => {
    expect(redact('app --password "hunter2" --verbose').text).toBe('app --password [redacted] --verbose');
    expect(redact('DB_PASSWORD="" npm start')).toEqual({ text: 'DB_PASSWORD="" npm start', redactedCount: 0 });
  });

  it('still redacts the unquoted curl form, and leaves an ordinary curl alone', () => {
    expect(redact('curl -u alice:passwordvalue https://api.example.com').text).not.toContain('passwordvalue');
    expect(redact('curl -X POST https://api.example.com/v1/items')).toEqual({
      text: 'curl -X POST https://api.example.com/v1/items',
      redactedCount: 0,
    });
  });
});

describe('redact key-value-secret: prose and code stay untouched', () => {
  it.each([
    'we chose BM25 because developer queries are keyword-heavy',
    'I forgot my password again and need a reset link',
    'the token expires after an hour',
    'Here is the secret:\nwe rotate keys weekly',
    'tokenizer=bert',
    'bypass=true',
    'sort_key=name primary_key=id monkey=banana',
    'PWD=/home/me',
    'password: string;',
    'token: string | null',
    'if (password === other) return',
    // Real false positives measured on this repo's own conversation corpus while fixing the leak.
    'first pass: collect every id',
    'max_tokens=4096',
    'USD_PER_MILLION_TOKENS = 0.25',
    'const rawTokens = text.split(" ")',
    'approxTokens: 1234',
  ])('%s', (text) => {
    expect(redact(text)).toEqual({ text, redactedCount: 0 });
  });
});
