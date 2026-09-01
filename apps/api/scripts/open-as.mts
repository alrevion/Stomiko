/**
 * Ссылка, открывающая Mini App в обычном браузере.
 *
 * Telegram передаёт подпись в хеше `#tgWebAppData=…`, и telegram-web-app.js
 * разбирает её где угодно, не только внутри клиента. Значит приложение можно
 * пройти глазами и с ноутбука — не собирая руками второй телефон ради каждой
 * проверки вёрстки.
 *
 *   pnpm exec tsx scripts/open-as.mts 900700 invite   # врач по приглашению
 *   pnpm exec tsx scripts/open-as.mts 977001 link     # пациент по ссылке врача
 *
 * Членство, выданное по приглашению, остаётся в базе — preflight поймает его
 * и потребует убрать перед показом.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const DEV = new URL('../.dev.vars', import.meta.url).pathname;
const env = (k: string) => {
  for (const l of readFileSync(DEV, 'utf8').split('\n')) {
    if (l.trim().startsWith(`${k}=`)) return l.trim().slice(k.length + 1).trim();
  }
  throw new Error(`нет ${k}`);
};

const token = env('TELEGRAM_BOT_TOKEN');
const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
});

const uid = Number(process.argv[2] ?? 900500);
let sp = process.argv[3];
if (sp === 'invite') {
  const tenant = (await sb.from('tenants').select('id').limit(1).single()).data!.id;
  const owner = (await sb.from('memberships').select('subject').limit(1).single()).data!.subject;
  sp = (await sb.rpc('create_staff_invite', {
    p_tenant_id: tenant, p_created_by: owner, p_hours: 24,
  })).data as string;
} else if (sp === 'link') {
  sp = (await sb.from('tenants').select('public_token').limit(1).single()).data!.public_token;
}

const f: Record<string, string> = {
  auth_date: String(Math.floor(Date.now() / 1000)),
  chat_instance: '-1',
  chat_type: 'sender',
  user: JSON.stringify({ id: uid, first_name: `U${uid}`, language_code: 'ru' }),
};
if (sp) f.start_param = sp;
const dcs = Object.keys(f).sort().map((k) => `${k}=${f[k]}`).join('\n');
const secret = createHmac('sha256', 'WebAppData').update(token).digest();
f.hash = createHmac('sha256', secret).update(dcs).digest('hex');

const initData = new URLSearchParams(f).toString();
console.log(
  `https://stomiko-api.alrevion.workers.dev/#tgWebAppData=${encodeURIComponent(initData)}`
  + '&tgWebAppVersion=7.10&tgWebAppPlatform=web&tgWebAppThemeParams=%7B%22bg_color%22%3A%22%23ffffff%22%7D',
);
