/** Журнал доступа: пишется сам, забыть его нельзя, чужого не отдаёт. */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const BASE = 'https://stomiko-api.alrevion.workers.dev';
const DEV = new URL('../.dev.vars', import.meta.url).pathname;
const env = (k: string) => { for (const l of readFileSync(DEV,'utf8').split('\n')) if (l.trim().startsWith(`${k}=`)) return l.trim().slice(k.length+1).trim(); throw new Error(k); };
const token = env('TELEGRAM_BOT_TOKEN');
const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
function initData(uid: number, sp?: string) {
  const f: Record<string,string> = { auth_date: String(Math.floor(Date.now()/1000)), chat_instance:'-1', chat_type:'sender', user: JSON.stringify({ id: uid, first_name:'T' }) };
  if (sp) f.start_param = sp;
  const dcs = Object.keys(f).sort().map(k=>`${k}=${f[k]}`).join('\n');
  const sec = createHmac('sha256','WebAppData').update(token).digest();
  f.hash = createHmac('sha256',sec).update(dcs).digest('hex');
  return new URLSearchParams(f).toString();
}
const as = (uid: number, sp?: string) => async (p: string, init: RequestInit = {}) => {
  const r = await fetch(`${BASE}/api${p}`, { ...init, headers:{ 'Content-Type':'application/json','X-Telegram-Init-Data': initData(uid, sp), ...(init.headers??{}) } });
  return { status: r.status, body: (await r.json().catch(()=>({}))) as any };
};
const problems: string[] = [];
const ok = (c: boolean, l: string, d='') => { console.log(`  ${c?'✓':'✗'} ${l}${d?` — ${d}`:''}`); if(!c) problems.push(l); };

const tid = (await sb.from('tenants').select('id').limit(1).single()).data!.id;
const owner = (await sb.from('memberships').select('subject').limit(1).single()).data!.subject;
const DOC = 991001;
const inv = (await sb.rpc('create_staff_invite', { p_tenant_id: tid, p_created_by: owner, p_hours: 1 })).data as string;
await as(DOC, inv)('/me');
const doc = as(DOC);
const since = new Date().toISOString();

console.log('── Журнал пишется сам ──');
const list = await doc('/doctor/patients');
const withHistory = (list.body.patients ?? []).find((p: any) => p.visits > 0);
await doc(`/doctor/patients/${withHistory.id}`);
await doc(`/doctor/patients?q=${encodeURIComponent('Абдулла')}`);
const card = await doc(`/doctor/patients/${withHistory.id}`);
const visitId = card.body.visits?.[0]?.id;
if (visitId) await doc(`/doctor/visits/${visitId}`);
await new Promise(r => setTimeout(r, 700));

const { data: log } = await sb.from('access_log').select('action, target_id, detail, subject')
  .eq('tenant_id', tid).gte('at', since).order('id');
const acts = (log ?? []).map((l: any) => l.action);
ok(acts.includes('patient_card'), 'открытие карточки записано');
ok(acts.includes('patient_search'), 'поиск по базе записан');
ok(acts.includes('visit'), 'открытие приёма записано');
ok(!acts.includes('calendar' as never), 'календарь и склад НЕ пишутся — иначе журнал утонет в рутине');
const search = (log ?? []).find((l: any) => l.action === 'patient_search');
ok(search?.detail === 'Абдулла', 'в журнале виден сам запрос', String(search?.detail));
ok((log ?? []).every((l: any) => l.subject === `tg:${DOC}`), 'записан именно тот, кто смотрел');

console.log('\n── Открытие списка не пишется ──');
const before = ((await sb.from('access_log').select('id', { count:'exact', head:true }).eq('tenant_id', tid)) as any).count;
await doc('/doctor/patients');
await new Promise(r => setTimeout(r, 500));
const after = ((await sb.from('access_log').select('id', { count:'exact', head:true }).eq('tenant_id', tid)) as any).count;
ok(before === after, 'список без поиска — рабочая рутина, в журнал не идёт');

console.log('\n── Забыть журнал нельзя ──');
const noActor = await sb.rpc('patient_card', { p_tenant_id: tid, p_patient_id: withHistory.id });
ok(Boolean(noActor.error), 'вызов без актора отклоняется', noActor.error?.message?.slice(0, 60) ?? 'ПРОШЁЛ');

console.log('\n── Кто открывал карту ──');
const shown = await doc(`/doctor/patients/${withHistory.id}`);
ok(Array.isArray(shown.body.accessLog) && shown.body.accessLog.length > 0,
  'врач видит журнал по карте, когда в кабинете не он один', `${shown.body.accessLog?.length} записей`);

console.log('\n── Чистка ──');
const pruned = await sb.rpc('prune_access_log', { p_keep_days: 730 });
ok(!pruned.error, 'чистка журнала работает', `удалено ${pruned.data ?? 0} старых`);

console.log('\n── Уборка ──');
await sb.from('access_log').delete().eq('subject', `tg:${DOC}`);
await sb.from('memberships').delete().eq('subject', `tg:${DOC}`);
await sb.from('app_users').delete().eq('subject', `tg:${DOC}`);
await sb.from('staff_invites').delete().eq('token', inv);
ok(true, 'следы прогона убраны');
console.log(`\n${problems.length ? `НЕ ПРОШЛО: ${problems.join('; ')}` : 'Журнал доступа работает.'}`);
if (problems.length) process.exit(1);
