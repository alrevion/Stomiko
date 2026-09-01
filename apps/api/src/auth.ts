/**
 * Авторизация Telegram Mini App.
 *
 * `initDataUnsafe` называется так не случайно: доверять ему нельзя. Единственная
 * настоящая проверка — подпись, и она обязана считаться на сервере.
 */

export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface VerifiedInitData {
  user: TelegramUser;
  startParam: string | null;
  authDate: number;
}

const encoder = new TextEncoder();

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Сравнение за постоянное время: обычное === утекает позицию первого различия. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Проверка подписи initData по алгоритму Telegram:
 *   secret_key = HMAC_SHA256(ключ "WebAppData", данные = bot_token)
 *   hash       = HMAC_SHA256(ключ = secret_key, данные = data_check_string)
 * где data_check_string — все поля кроме hash, отсортированные по имени и
 * склеенные через \n в виде `ключ=значение`.
 */
export async function verifyInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 24 * 60 * 60,
): Promise<VerifiedInitData> {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw new Error('initData без подписи');

  // Из строки проверки исключается ТОЛЬКО `hash`.
  //
  // Поле `signature` (Ed25519 для сторонней проверки) в неё ВХОДИТ: оба поля
  // исключаются лишь при валидации самого `signature`, а не `hash`. Раньше
  // здесь стоял `params.delete('signature')` — на синтетических данных без
  // этого поля всё сходилось, а на настоящих из Telegram подпись ломалась.
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = await hmac(encoder.encode('WebAppData'), botToken);
  const expected = toHex(await hmac(secretKey, dataCheckString));

  if (!timingSafeEqual(expected, hash)) {
    // Имена полей — не секрет, а без них разбирать расхождение вслепую.
    const keys = [...params.keys()].sort().join(', ');
    throw new Error(`подпись initData не сходится (поля: ${keys})`);
  }

  const authDate = Number(params.get('auth_date') ?? 0);
  if (!authDate) throw new Error('initData без auth_date');
  const age = Math.floor(Date.now() / 1000) - authDate;
  // Без этой проверки перехваченный однажды initData работал бы вечно.
  if (age > maxAgeSeconds) throw new Error(`initData устарел на ${age - maxAgeSeconds} с`);

  const rawUser = params.get('user');
  if (!rawUser) throw new Error('initData без пользователя');

  return {
    user: JSON.parse(rawUser) as TelegramUser,
    startParam: params.get('start_param'),
    authDate,
  };
}

/** Стабильный идентификатор пользователя для `memberships.subject`. */
export function subjectFor(user: TelegramUser): string {
  return `tg:${user.id}`;
}
