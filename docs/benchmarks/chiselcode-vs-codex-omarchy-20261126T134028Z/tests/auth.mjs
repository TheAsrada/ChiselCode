import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const MODEL = 'gpt-6.2-sol';
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(path, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
const derive = (user, home, salt) => scryptSync(`${user}:${home}:chiselcode`, salt, 32);
const buffer = value => Buffer.from(value, 'base64');
const claims = jwt => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));


function stage() {
  const [chiselConfig, codexHome, chosenProfile, output, agent, timeout] = process.argv.slice(2);
  const config = read(join(chiselConfig, 'config.json'));
  const profiles = Object.entries(config.profiles ?? {}).filter(([, value]) => value.providerId === 'chatgpt');
  const profile = chosenProfile || (profiles.length === 1 ? profiles[0][0] : null);
  if (!profile || !profiles.some(([key]) => key === profile)) {
    throw new Error('Укажи --profile с ID подключённого ChatGPT-профиля ChiselCode.');
  }

  const box = read(join(chiselConfig, 'credentials.enc'));
  if (box.version !== 1) throw new Error('Формат credentials.enc не поддержан.');
  const identity = process.env.USERNAME ?? process.env.USER ?? 'unknown';
  const home = process.env.USERPROFILE ?? process.env.HOME ?? 'unknown';
  const decoder = createDecipheriv('aes-256-gcm', derive(identity, home, buffer(box.salt)), buffer(box.iv));
  decoder.setAuthTag(buffer(box.tag));
  const decoded = Buffer.concat([decoder.update(buffer(box.ciphertext)), decoder.final()]);
  const profileRef = config.profiles[profile].apiKeyRef ?? profile;
  const key = `subscription:chatgpt:${profileRef}`;
  const chisel = JSON.parse(JSON.parse(decoded.toString('utf8'))[key] ?? 'null');
  const codex = read(join(codexHome, 'auth.json'));
  if (codex.OPENAI_API_KEY || (codex.auth_mode && codex.auth_mode !== 'chatgpt')) {
    throw new Error('Codex CLI должен быть авторизован через ChatGPT в auth.json.');
  }
  const tokens = codex.tokens;
  if (!chisel?.accessToken || !tokens?.access_token || !tokens?.id_token) {
    throw new Error('Подписка ChatGPT должна быть подключена в обеих CLI.');
  }
  const namespace = 'https://api.openai.com/auth';
  const codexClaims = claims(tokens.id_token)[namespace] ?? {};
  const chiselClaims = claims(chisel.accessToken)[namespace] ?? {};
  const codexAccount = tokens.account_id ?? codexClaims.chatgpt_account_id;
  if (codexClaims.chatgpt_user_id && chiselClaims.chatgpt_user_id &&
      codexClaims.chatgpt_user_id !== chiselClaims.chatgpt_user_id) {
    throw new Error('Обе CLI должны использовать один и тот же аккаунт ChatGPT.');
  }
  if (!codexAccount || codexAccount !== chisel.accountId) {
    throw new Error('Обе CLI должны использовать один и тот же аккаунт или workspace ChatGPT.');
  }
  const expiry = Math.min(chisel.expiresAt, claims(chisel.accessToken).exp * 1000,
                           claims(tokens.access_token).exp * 1000);
  if (!Number.isFinite(expiry) || expiry - Date.now() < Math.max(1200, Number(timeout) + 300) * 1000) {
    throw new Error('Открой обе штатные CLI и обнови вход ChatGPT. Срок действия токена должен покрывать весь запуск и запас на завершение.');
  }

  // A staged client may use its current scoped access token. Refresh remains possible only in the original CLI.
  const noRefresh = 'benchmark-copy-refresh-disabled';
  const state = {
    [key]: JSON.stringify({
      accessToken: chisel.accessToken, refreshToken: noRefresh,
      accountId: chisel.accountId, expiresAt: chisel.expiresAt,
    }),
  };
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const encoder = createCipheriv('aes-256-gcm', derive('bench', '/home/bench', salt), iv);
  const ciphertext = Buffer.concat([encoder.update(JSON.stringify(state)), encoder.final()]);
  const encoded = { version: 1, salt, iv, tag: encoder.getAuthTag(), ciphertext };
  for (const name of ['salt', 'iv', 'tag', 'ciphertext']) encoded[name] = encoded[name].toString('base64');

  const codexDir = join(output, '.codex');
  const chiselDir = join(output, '.config', 'chiselcode');
  if (agent === 'codex') {
    mkdirSync(codexDir, { recursive: true, mode: 0o700 });
    write(join(codexDir, 'auth.json'), {
      auth_mode: 'chatgpt', OPENAI_API_KEY: null,
      tokens: { id_token: tokens.id_token, access_token: tokens.access_token,
        refresh_token: noRefresh, account_id: codexAccount },
      last_refresh: codex.last_refresh,
    });
  } else if (agent === 'chisel') {
    mkdirSync(chiselDir, { recursive: true, mode: 0o700 });
    write(join(chiselDir, 'credentials.enc'), encoded);
    write(join(chiselDir, 'config.json'), {
      schemaVersion: 2, defaultProfileId: profile,
      profiles: { [profile]: { providerId: 'chatgpt', apiKeyRef: profileRef, defaultModel: MODEL } },
      mcp: { schemaVersion: 1, servers: {} }, web: { enabled: false },
      subagents: { enabled: false }, lsp: { mode: 'off' },
      backgroundTasks: { enabled: false },
      ui: { startupIntroSeen: true, motion: 'reduced' },
    });
  } else {
    throw new Error('Формат запуска не поддержан.');
  }
  console.log(JSON.stringify({
    profile,
    privateValues: [
      chisel.accessToken, chisel.accountId, chisel.label, profileRef,
      tokens.access_token, tokens.id_token, codexAccount, claims(tokens.id_token).email,
      chiselClaims.chatgpt_user_id, codexClaims.chatgpt_user_id,
    ],
  }));
}

try {
  stage();
} catch (error) {
  const known = [
    'Укажи', 'Формат', 'Codex CLI', 'Подписка', 'Обе CLI', 'Открой', 'Обнови',
  ];
  const message = error instanceof Error ? error.message : '';
  console.error(known.some(prefix => message.startsWith(prefix))
    ? message
    : 'Не удалось прочитать локальный вход. Проверь пути, способ хранения auth.json и исходное окружение ChiselCode.');
  process.exitCode = 1;
}
