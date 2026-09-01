import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { subjectFor, verifyInitData } from './auth.js';

const BOT_TOKEN = '123456:TEST-BOT-TOKEN-FOR-UNIT-TESTS';

/**
 * Независимая реализация подписи на node:crypto. Если бы тест переиспользовал
 * ту же функцию, что и код, он бы проверял только сам себя.
 */
function signInitData(fields: Record<string, string>): string {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

function freshFields(over: Record<string, string> = {}) {
  return {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAE_test',
    user: JSON.stringify({ id: 777001, first_name: 'Санжар', username: 'dr_sanjar' }),
    ...over,
  };
}

describe('подпись Telegram initData', () => {
  it('корректная подпись принимается, пользователь разбирается', async () => {
    const verified = await verifyInitData(signInitData(freshFields()), BOT_TOKEN);
    expect(verified.user.id).toBe(777001);
    expect(subjectFor(verified.user)).toBe('tg:777001');
  });

  it('подмена данных после подписи отвергается', async () => {
    const initData = signInitData(freshFields());
    const tampered = new URLSearchParams(initData);
    tampered.set('user', JSON.stringify({ id: 999999, first_name: 'Чужой' }));
    await expect(verifyInitData(tampered.toString(), BOT_TOKEN)).rejects.toThrow(/подпись/);
  });

  it('подпись чужим токеном отвергается', async () => {
    await expect(
      verifyInitData(signInitData(freshFields()), '999:ANOTHER-BOT-TOKEN'),
    ).rejects.toThrow(/подпись/);
  });

  it('устаревший initData отвергается — иначе перехваченный работал бы вечно', async () => {
    const old = String(Math.floor(Date.now() / 1000) - 48 * 3600);
    await expect(
      verifyInitData(signInitData(freshFields({ auth_date: old })), BOT_TOKEN),
    ).rejects.toThrow(/устарел/);
  });

  it('свежий в пределах окна принимается', async () => {
    const recent = String(Math.floor(Date.now() / 1000) - 3600);
    const v = await verifyInitData(signInitData(freshFields({ auth_date: recent })), BOT_TOKEN);
    expect(v.user.id).toBe(777001);
  });

  it('поле signature ВХОДИТ в data_check_string при проверке hash', async () => {
    // Из строки проверки исключается только `hash`. Оба поля выкидываются
    // лишь при валидации самого `signature`.
    //
    // Прошлая версия теста утверждала обратное — ровно то же неверное
    // допущение, что и код. Он проходил на синтетических данных без
    // `signature` и молча пропускал баг, на котором ломался живой Telegram.
    const initData = signInitData(freshFields({ signature: 'ZWQyNTUxOS1zaWduYXR1cmU' }));
    const v = await verifyInitData(initData, BOT_TOKEN);
    expect(v.user.id).toBe(777001);
  });

  it('подпись, посчитанная БЕЗ signature, отвергается', async () => {
    // Проверка от обратного: если бы signature исключался, эта строка прошла бы.
    const signed = new URLSearchParams(signInitData(freshFields()));
    signed.set('signature', 'ZWQyNTUxOS1zaWduYXR1cmU');
    await expect(verifyInitData(signed.toString(), BOT_TOKEN)).rejects.toThrow(/не сходится/);
  });

  it('реальный набор полей Telegram принимается', async () => {
    // Живой initData несёт больше полей, чем синтетический: chat_instance,
    // chat_type, signature. Тест на минимальном наборе этого не ловил.
    const v = await verifyInitData(
      signInitData(freshFields({
        chat_instance: '-1234567890123456789',
        chat_type: 'sender',
        signature: 'ZWQyNTUxOS1zaWduYXR1cmU',
        start_param: 'd_a8K29x',
      })),
      BOT_TOKEN,
    );
    expect(v.user.id).toBe(777001);
    expect(v.startParam).toBe('d_a8K29x');
  });

  it('start_param из deep link доходит до приложения', async () => {
    const v = await verifyInitData(
      signInitData(freshFields({ start_param: 'd_a8K29x' })),
      BOT_TOKEN,
    );
    expect(v.startParam).toBe('d_a8K29x');
  });

  it('initData без подписи отвергается', async () => {
    await expect(verifyInitData('user=%7B%7D&auth_date=1', BOT_TOKEN)).rejects.toThrow(/без подписи/);
  });
});
