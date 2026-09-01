import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mintTenantToken } from './tenantjwt.js';

/**
 * Подпись токена проверяется независимой реализацией.
 *
 * Проверять свою подпись своим же кодом бессмысленно: обе половины
 * ошибутся одинаково. Здесь HMAC считает node:crypto, а токен собирает
 * WebCrypto — сходятся они только если обе правы.
 */

const SECRET = 'super-secret-jwt-key-for-tests-only';
const TENANT = '6cd29ec9-97ca-4c7b-9454-7b732bf68dac';

const b64url = (b: Buffer) => b.toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const decode = (part: string) =>
  JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());

describe('токен кабинета', () => {
  it('подпись сходится с независимой реализацией HMAC', async () => {
    const token = await mintTenantToken(SECRET, TENANT);
    const [head, payload, sig] = token.split('.');
    const expected = b64url(createHmac('sha256', SECRET).update(`${head}.${payload}`).digest());
    expect(sig).toBe(expected);
  });

  it('несёт роль и кабинет — по ним работает политика на таблице', async () => {
    const [, payload] = (await mintTenantToken(SECRET, TENANT)).split('.');
    const claims = decode(payload!);
    expect(claims.role).toBe('authenticated');
    expect(claims.tenant_id).toBe(TENANT);
  });

  it('живёт минуту: токен не хранится, длинный срок только увеличил бы ущерб', async () => {
    const [, payload] = (await mintTenantToken(SECRET, TENANT)).split('.');
    const claims = decode(payload!);
    expect(claims.exp - claims.iat).toBe(60);
    expect(claims.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it('чужой секрет даёт другую подпись', async () => {
    const [head, payload, sig] = (await mintTenantToken(SECRET, TENANT)).split('.');
    const wrong = b64url(createHmac('sha256', 'другой-секрет').update(`${head}.${payload}`).digest());
    expect(sig).not.toBe(wrong);
  });

  it('разным кабинетам — разные токены', async () => {
    const a = await mintTenantToken(SECRET, TENANT);
    const b = await mintTenantToken(SECRET, '00000000-0000-0000-0000-000000000000');
    expect(a).not.toBe(b);
  });

  // base64url без выравнивания: '=' в JWT недопустим, а '+' и '/' ломают
  // разбор на стороне PostgREST.
  it('в токене только допустимые символы', async () => {
    const token = await mintTenantToken(SECRET, TENANT);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });
});
