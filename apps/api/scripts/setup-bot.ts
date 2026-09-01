/**
 * Настройка Mini App в боте + сквозной тест по задеплоенному URL.
 *
 * Токен читается из .dev.vars и никуда не печатается: в вывод попадают только
 * имя бота и результаты проверок.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const WORKER_URL = process.env.WORKER_URL ?? 'https://stomiko-api.alrevion.workers.dev';

function env(key: string): string {
  const raw = readFileSync(resolve(here, '../.dev.vars'), 'utf8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t.startsWith(`${key}=`)) return t.slice(key.length + 1).trim();
  }
  throw new Error(`в .dev.vars нет ${key}`);
}

const token = env('TELEGRAM_BOT_TOKEN');

async function tg<T>(method: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  return json.result as T;
}

/** Подписываем initData так же, как это делает Telegram — для сквозного теста. */
function forgeInitData(userId: number): string {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAE_smoke',
    user: JSON.stringify({ id: userId, first_name: 'Smoke', username: 'smoke_test' }),
  };
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

async function main() {
  const me = await tg<{ username: string; first_name: string }>('getMe');
  console.log(`Бот: @${me.username} (${me.first_name})`);

  await tg('setChatMenuButton', {
    menu_button: { type: 'web_app', text: 'Stomiko', web_app: { url: WORKER_URL } },
  });
  console.log(`Кнопка меню → Mini App: ${WORKER_URL}`);

  await tg('setMyCommands', {
    commands: [{ command: 'start', description: 'Открыть Stomiko' }],
  });

  // Вебхук нужен, чтобы /start создавал чат: без него бот не может написать
  // пациенту об отмене приёма — Telegram отвечает «chat not found».
  const secret = env('TELEGRAM_WEBHOOK_SECRET');
  await tg('setWebhook', {
    url: `${WORKER_URL}/tg/webhook`,
    secret_token: secret,
    allowed_updates: ['message'],
  });
  const hook = await tg<{ url: string; pending_update_count: number }>('getWebhookInfo');
  console.log(`Вебхук: ${hook.url} (в очереди ${hook.pending_update_count})`);

  console.log('\n── Сквозной тест по задеплоенному URL ──');

  const page = await fetch(WORKER_URL);
  const html = await page.text();
  console.log(`  статика:            ${page.status} ${html.includes('<title>Stomiko') ? 'index.html отдан' : 'НЕ index.html'}`);

  const noAuth = await fetch(`${WORKER_URL}/api/doctor/day`);
  console.log(`  /api/doctor/day без initData: ${noAuth.status} ${noAuth.status === 401 ? '(отказ, верно)' : '(ОЖИДАЛСЯ 401)'}`);

  const bad = await fetch(`${WORKER_URL}/api/doctor/day`, {
    headers: { 'X-Telegram-Init-Data': forgeInitData(1).replace(/hash=.*/, 'hash=deadbeef') },
  });
  console.log(`  /api/doctor/day с битой подписью: ${bad.status} ${bad.status === 401 ? '(отказ, верно)' : '(ОЖИДАЛСЯ 401)'}`);

  const initData = forgeInitData(900001);
  const day = await fetch(`${WORKER_URL}/api/doctor/day`, { headers: { 'X-Telegram-Init-Data': initData } });
  const dayBody = (await day.json()) as { visits?: unknown[]; error?: string };
  console.log(`  /api/doctor/day с подписью: ${day.status} ${
    day.ok ? `приёмов сегодня: ${dayBody.visits?.length ?? 0}` : dayBody.error
  }`);

  const margin = await fetch(`${WORKER_URL}/api/doctor/reports/margin`, {
    headers: { 'X-Telegram-Init-Data': initData },
  });
  const m = (await margin.json()) as {
    rows?: { name: string; revenue: number; margin: number; marginPct: number }[];
    totals?: { revenue: number; cost: number; margin: number };
    error?: string;
  };
  if (!margin.ok) {
    console.log(`  /api/doctor/reports/margin: ${margin.status} ${m.error}`);
  } else {
    console.log(`  /api/doctor/reports/margin: ${margin.status}, услуг ${m.rows?.length}`);
    console.log(`     выручка ${m.totals?.revenue.toLocaleString('ru-RU')} · материалы ${m.totals?.cost.toLocaleString('ru-RU')} · сверх ${m.totals?.margin.toLocaleString('ru-RU')}`);
    for (const r of (m.rows ?? []).slice(0, 3)) {
      console.log(`     ${r.name}: ${r.marginPct}%`);
    }
  }

  const health = await fetch(`${WORKER_URL}/api/doctor/stock/health`, {
    headers: { 'X-Telegram-Init-Data': initData },
  });
  const h = (await health.json()) as { reconcileMismatches?: number; openShortfalls?: number };
  console.log(`  /api/doctor/stock/health: расхождений ${h.reconcileMismatches}, открытых недостач ${h.openShortfalls}`);

  console.log(`\nОткрыть: https://t.me/${me.username}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
