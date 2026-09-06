/** Лицензия открывает поиск: подача, вердикт, доступ к очереди. */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const BASE = 'https://stomiko-api.alrevion.workers.dev';
const DEV = new URL('../.dev.vars', import.meta.url).pathname;
const env = (k: string) => { for (const l of readFileSync(DEV,'utf8').split('\n')) if (l.trim().startsWith(`${k}=`)) return l.trim().slice(k.length+1).trim(); throw new Error(k); };
const token = env('TELEGRAM_BOT_TOKEN');
const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth:{persistSession:false} });
function initData(uid: number) {
  const f: Record<string,string> = { auth_date: String(Math.floor(Date.now()/1000)), chat_instance:'-1', chat_type:'sender', user: JSON.stringify({ id: uid, first_name:'T' }) };
  const dcs = Object.keys(f).sort().map(k=>`${k}=${f[k]}`).join('\n');
  const sec = createHmac('sha256','WebAppData').update(token).digest();
  f.hash = createHmac('sha256',sec).update(dcs).digest('hex');
  return new URLSearchParams(f).toString();
}
const as = (uid: number) => async (p: string, init: RequestInit = {}) => {
  const r = await fetch(`${BASE}/api${p}`, { ...init, headers:{ 'Content-Type':'application/json','X-Telegram-Init-Data': initData(uid), ...(init.headers??{}) } });
  return { status: r.status, body: (await r.json().catch(()=>({}))) as any };
};
const problems: string[] = [];
const ok = (c: boolean, l: string, d='') => { console.log(`  ${c?'✓':'✗'} ${l}${d?` — ${d}`:''}`); if(!c) problems.push(l); };

// Проверяющий — тот, кто указан в PLATFORM_OWNERS воркера.
const CHECKER = Number(env('PLATFORM_OWNERS').replace('tg:', ''));
const DOC = 994001, OUTSIDER = 994002;
for (const uid of [DOC, OUTSIDER]) {
  const { data } = await sb.from('memberships').select('tenant_id').eq('subject', `tg:${uid}`);
  for (const m of data ?? []) await sb.rpc('delete_tenant', { p_tenant_id: m.tenant_id });
  await sb.from('app_users').delete().eq('subject', `tg:${uid}`);
}
const doc = as(DOC), outsider = as(OUTSIDER), checker = as(CHECKER);

console.log('── Кабинет заводится без документов ──');
const reg = await doc('/onboarding/register', { method:'POST', body: JSON.stringify({ name:'Кабинет Лицензии', doctorName:'Проверкин П.П.', template:'therapist' }) });
const tid = reg.body.tenantId as string;
ok(reg.status === 200, 'кабинет создан без единого документа', String(reg.body.error ?? ''));
await doc('/onboarding/finish', { method:'POST' });
const l0 = await doc('/doctor/listing');
ok(l0.body.licenseStatus === 'none', 'лицензии нет — так и написано', String(l0.body.licenseStatus));

console.log('\n── Без лицензии в поиск нельзя ──');
const early = await doc('/doctor/listing', { method:'PUT', body: JSON.stringify({
  city:'Ташкент', address:'ул. Амира Темура, 12', phone:'+998901112233', listed:true }) });
ok(early.status === 400, 'публикация без проверенной лицензии отклонена', String(early.body.error ?? ''));
const saved = await doc('/doctor/listing', { method:'PUT', body: JSON.stringify({
  city:'Ташкент', address:'ул. Амира Темура, 12', phone:'+998901112233', listed:false }) });
ok(saved.status === 200, 'адрес сохраняется и без лицензии — кабинет работает по ссылке');

console.log('\n── Подача номера ──');
const short = await doc('/doctor/license', { method:'PUT', body: JSON.stringify({ number:'12' }) });
ok(short.status === 400, 'слишком короткий номер не принимается', String(short.body.error ?? ''));
const junk = await doc('/doctor/license', { method:'PUT', body: JSON.stringify({ number:'47895138; drop' }) });
ok(junk.status === 400, 'номер с лишними знаками не принимается', String(junk.body.error ?? ''));
const sent = await doc('/doctor/license', { method:'PUT', body: JSON.stringify({ number:'47895138', tin:'304638816' }) });
ok(sent.status === 200 && sent.body.licenseStatus === 'pending', 'номер принят и ждёт проверки', String(sent.body.licenseStatus ?? sent.body.error));

console.log('\n── Очередь видна только проверяющему ──');
const stolen = await outsider('/admin/licenses');
ok(stolen.status === 403, 'посторонний в очередь не попадает', String(stolen.status));
const stolenVerdict = await outsider(`/admin/licenses/${tid}`, { method:'POST', body: JSON.stringify({ verdict:'verified', validUntil:'2030-01-01' }) });
ok(stolenVerdict.status === 403, 'посторонний не может подтвердить сам себя', String(stolenVerdict.status));
const selfVerdict = await doc(`/admin/licenses/${tid}`, { method:'POST', body: JSON.stringify({ verdict:'verified', validUntil:'2030-01-01' }) });
ok(selfVerdict.status === 403, 'ВРАЧ не может подтвердить свой же кабинет', String(selfVerdict.status));
const queue = await checker('/admin/licenses');
ok(queue.status === 200, 'проверяющий очередь видит', String(queue.status));
const mine = (queue.body.pending ?? []).find((x: any) => x.tenantId === tid);
ok(!!mine && mine.licenseNumber === '47895138', 'заявка в очереди с номером', String(mine?.licenseNumber));
ok(mine?.licenseTin === '304638816', 'СТИР доехал до проверяющего', String(mine?.licenseTin));

console.log('\n── Вердикт ──');
const noReason = await checker(`/admin/licenses/${tid}`, { method:'POST', body: JSON.stringify({ verdict:'rejected' }) });
ok(noReason.status === 400, 'отказ без причины не проходит', String(noReason.body.error ?? ''));
const bogus = await checker(`/admin/licenses/${tid}`, { method:'POST', body: JSON.stringify({ verdict:'maybe' }) });
ok(bogus.status === 400, 'третьего вердикта не бывает', String(bogus.body.error ?? ''));
const good = await checker(`/admin/licenses/${tid}`, { method:'POST', body: JSON.stringify({ verdict:'verified', validUntil:'2027-03-24' }) });
ok(good.status === 200 && good.body.licenseStatus === 'verified', 'лицензия подтверждена', String(good.body.error ?? ''));
const twice = await checker(`/admin/licenses/${tid}`, { method:'POST', body: JSON.stringify({ verdict:'verified', validUntil:'2027-03-24' }) });
ok(twice.status === 400, 'повторный вердикт по той же заявке не проходит', String(twice.body.error ?? ''));

console.log('\n── Теперь поиск открыт ──');
const pub = await doc('/doctor/listing', { method:'PUT', body: JSON.stringify({
  city:'Ташкент', address:'ул. Амира Темура, 12', phone:'+998901112233', listed:true }) });
ok(pub.status === 200 && pub.body.listed === true, 'кабинет опубликован', String(pub.body.error ?? ''));
const back = await doc('/doctor/listing');
ok(back.body.licenseValidUntil === '2027-03-24', 'срок действия сохранён — будет что напомнить', String(back.body.licenseValidUntil));

console.log('\n── Новый номер снимает кабинет с поиска ──');
const again = await doc('/doctor/license', { method:'PUT', body: JSON.stringify({ number:'99999999' }) });
ok(again.body.licenseStatus === 'pending', 'новый номер снова ждёт проверки');
const after = await doc('/doctor/listing');
ok(after.body.listed === false,
  'кабинет ушёл из поиска: отметка не переживает документ, к которому относилась');
const reListed = await doc('/doctor/listing', { method:'PUT', body: JSON.stringify({
  city:'Ташкент', address:'ул. Амира Темура, 12', phone:'+998901112233', listed:true }) });
ok(reListed.status === 400, 'обратно в поиск без новой проверки нельзя', String(reListed.body.error ?? ''));

console.log('\n── Уборка ──');
const del = await sb.rpc('delete_tenant', { p_tenant_id: tid });
ok(!del.error, 'кабинет удалён', del.error?.message ?? '');
await sb.from('app_users').delete().in('subject', [`tg:${DOC}`, `tg:${OUTSIDER}`]);
console.log(`\n${problems.length ? `НЕ ПРОШЛО: ${problems.join('; ')}` : 'Проверка лицензий работает.'}`);
if (problems.length) process.exit(1);
