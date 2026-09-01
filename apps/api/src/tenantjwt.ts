/**
 * Токен доступа с привязкой к кабинету.
 *
 * Зачем: проверка тенанта внутри функций (шаг 1) держится на аккуратности
 * кода. Она верна ровно до следующего маршрута, где кто-то забудет фильтр —
 * и режим отказа снова станет «тихо вернули чужое».
 *
 * С этим токеном изоляцию держит сама база: политика на таблице сравнивает
 * `tenant_id` строки с claim из токена. Забытый фильтр отдаёт ноль строк
 * вместо чужих данных — ошибка становится заметной, а не опасной.
 *
 * PostgREST берёт роль из claim `role`, а весь набор claims кладёт в
 * `request.jwt.claims`; оттуда его читает `auth.jwt()` в политиках.
 *
 * Схема подписи — HS256 тем же секретом, которым подписаны ключи проекта
 * (устаревшая схема Supabase). Секрет лежит в панели: Settings → API →
 * JWT Settings. Пока его нет, воркер работает как раньше, под service_role.
 */

const enc = new TextEncoder();

/** base64url без выравнивания — как требует спецификация JWT. */
function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    // Ключ импортируется один раз на изолят: подпись идёт на каждый запрос,
    // и повторный импорт был бы заметной долей работы.
    k = crypto.subtle.importKey(
      'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    keyCache.set(secret, k);
  }
  return k;
}

/**
 * Токен на один запрос.
 *
 * Живёт минуту: он не хранится и не передаётся клиенту, поэтому длинный срок
 * не нужен, а короткий ограничивает ущерб, если токен всё же куда-то попадёт.
 */
export async function mintTenantToken(secret: string, tenantId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    role: 'authenticated',
    tenant_id: tenantId,
    iat: now,
    exp: now + 60,
  };
  const data = `${b64url(enc.encode(JSON.stringify(header)))}.${b64url(enc.encode(JSON.stringify(payload)))}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data));
  return `${data}.${b64url(sig)}`;
}
