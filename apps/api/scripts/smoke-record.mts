/** Переносимая история: запечатывание, доступ врача, дополнение, живучесть. */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const BASE = process.env.WORKER_URL ?? 'https://stomiko-api.alrevion.workers.dev';
const DEV = new URL('../.dev.vars', import.meta.url).pathname;
const env=(k:string)=>{for(const l of readFileSync(DEV,'utf8').split('\n'))if(l.trim().startsWith(`${k}=`))return l.trim().slice(k.length+1).trim();throw new Error(k)};
const token=env('TELEGRAM_BOT_TOKEN');
const sb=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false}});
function initData(uid:number,sp?:string){const f:Record<string,string>={auth_date:String(Math.floor(Date.now()/1000)),chat_instance:'-1',chat_type:'sender',user:JSON.stringify({id:uid,first_name:'T'})};
if(sp)f.start_param=sp;const dcs=Object.keys(f).sort().map(k=>`${k}=${f[k]}`).join('\n');
const sec=createHmac('sha256','WebAppData').update(token).digest();f.hash=createHmac('sha256',sec).update(dcs).digest('hex');return new URLSearchParams(f).toString()}
const as=(uid:number,sp?:string)=>async(p:string,init:RequestInit={})=>{const r=await fetch(`${BASE}/api${p}`,{...init,headers:{'Content-Type':'application/json','X-Telegram-Init-Data':initData(uid,sp),...(init.headers??{})}});return{status:r.status,body:await r.json().catch(()=>({})) as any}};
const problems:string[]=[]; const ok=(c:boolean,l:string,d='')=>{console.log(`  ${c?'✓':'✗'} ${l}${d?` — ${d}`:''}`); if(!c)problems.push(l)};

const A=990801, B=990802, PAT=990803;
await sb.from('memberships').delete().in('subject',[`tg:${A}`,`tg:${B}`]);
await sb.from('app_users').delete().in('subject',[`tg:${A}`,`tg:${B}`,`tg:${PAT}`]);
const docA=as(A), docB=as(B);

console.log('── Два кабинета и один человек ──');
const rA=await docA('/onboarding/register',{method:'POST',body:JSON.stringify({name:'Первый Кабинет',doctorName:'Каримов А.А.',template:'therapist'})});
const rB=await docB('/onboarding/register',{method:'POST',body:JSON.stringify({name:'Второй Кабинет',doctorName:'Юсупов Б.Б.',template:'therapist'})});
const tA=rA.body.tenantId as string, tB=rB.body.tenantId as string;
await docA('/onboarding/finish',{method:'POST'}); await docB('/onboarding/finish',{method:'POST'});
ok(!!tA && !!tB,'кабинеты созданы');
const linkA=(await sb.from('tenants').select('public_token').eq('id',tA).single()).data!.public_token;
await sb.rpc('set_verified_phone',{p_subject:`tg:${PAT}`,p_phone:'+998900990803'});
const pat=as(PAT,linkA);

console.log('\n── Лечение в первом кабинете ──');
const info=await pat('/book/info');
const svc=(info.body.services??[])[0];
const slots=await pat(`/book/slots?serviceId=${svc.id}&days=21`);
const booked=await pat('/book',{method:'POST',body:JSON.stringify({serviceId:svc.id,startsAt:slots.body.days[0].times[0],name:'Носитель Истории'})});
ok(booked.status===200,'пациент записался',String(booked.body.error??''));
const patientId=booked.body.patientId as string;

const started=await docA(`/doctor/appointments/${booked.body.appointmentId}/start`,{method:'POST'});
ok(started.status===200,'приём начат');
const recAopen=await docA(`/doctor/patients/${patientId}/record`);
ok(recAopen.status===200,'при открытом приёме карта открыта врачу',String(recAopen.body.error??''));
ok((recAopen.body.entries??[]).length===0,'но в ней пока пусто — приём не закрыт');
const beforeClose=(await sb.from('clinical_entries').select('*',{count:'exact',head:true}).eq('person_subject',`tg:${PAT}`)).count;
ok((beforeClose??0)===0,'пока приём открыт истории нет — это черновик врача');
const closed=await docA(`/doctor/visits/${started.body.visitId}/close`,{method:'POST'});
ok(closed.status===200,'приём закрыт',String(closed.body.error??''));
const { data: sealed } = await sb.from('clinical_entries').select('*').eq('person_subject',`tg:${PAT}`);
ok((sealed??[]).length===1,'закрытие запечатало запись',`${(sealed??[]).length}`);
ok(sealed![0].author_cabinet==='Первый Кабинет','кабинет записан снимком',String(sealed![0].author_cabinet));
ok(sealed![0].author_doctor==='Каримов А.А.','врач записан снимком',String(sealed![0].author_doctor));
ok(sealed![0].sealed_at!=null,'момент запечатывания зафиксирован');

console.log('\n── Карта у пациента ──');
const mine=await pat('/me/record');
ok(mine.status===200,'пациент открыл свою карту',String(mine.body.error??''));
ok((mine.body.entries??[]).length===1,'в карте одна запись',`${(mine.body.entries??[]).length}`);
ok(mine.body.entries?.[0]?.cabinet==='Первый Кабинет','видно, где лечили');
ok(mine.body.entries?.[0]?.doctor==='Каримов А.А.','видно, кто лечил');
ok(!JSON.stringify(mine.body).includes('cost') && !JSON.stringify(mine.body).includes('margin'),
   'себестоимости в карте пациента нет');

console.log('\n── Зуб приходит от оказанной услуги, а не от плана ──');
// План на ДВА зуба одной услугой: до 074 закрывался первый пункт по порядку
// и в историю уходил его зуб — даже если лечили другой.
const svcs=(await docA('/doctor/services?withCost=1')).body.services;
const filling=svcs.find((x:any)=>/пломб/i.test(x.name_ru)) ?? svcs[0];
const plan=await docA('/doctor/plans',{method:'POST',body:JSON.stringify({
  patientId, title:'Две пломбы', status:'active',
  items:[{serviceId:filling.id,tooth:'26',quantity:1,price:filling.price,stage:1},
         {serviceId:filling.id,tooth:'36',quantity:1,price:filling.price,stage:1}]})});
ok(plan.status===200,'план на два зуба сохранён',String(plan.body.error??''));

const w=await docA('/doctor/walk-in',{method:'POST',body:JSON.stringify({name:'Носитель Истории',phone:'+998900990803'})});
ok(w.status===200,'приём без записи открыт тому же пациенту',String(w.body.error??''));
const vid=w.body.visitId as string;
const bad=await docA(`/doctor/visits/${vid}/services`,{method:'POST',
  body:JSON.stringify({serviceId:filling.id,quantity:1,teeth:['99']})});
ok(bad.status===400,'зуб не по FDI отклонён',`${bad.status}`);
// ДВА зуба одной услугой: врач вносит один раз, а не дважды.
const added=await docA(`/doctor/visits/${vid}/services`,{method:'POST',
  body:JSON.stringify({serviceId:filling.id,quantity:2,teeth:['36','26','36']})});
ok(added.status===200,'услуга на два зуба внесена одной строкой',String(added.body.error??''));

const closed2=await docA(`/doctor/visits/${vid}/close`,{method:'POST'});
ok(closed2.status===200,'приём закрыт',String(closed2.body.error??''));
const { data: teeth } = await sb.from('clinical_entries').select('tooth, quantity, service_name, visit_id')
  .eq('person_subject',`tg:${PAT}`).eq('visit_id',vid);
ok((teeth??[]).length===2,'одна строка услуги — ДВЕ записи в карте, по зубу на каждую',
   `${(teeth??[]).length}`);
ok((teeth??[]).map(x=>x.tooth).sort().join(',')==='26,36','в истории оба зуба',
   (teeth??[]).map(x=>x.tooth).join(','));
ok((teeth??[]).every(x=>x.quantity===1),'количество разложено по зубам, а не удвоено');
const { data: items } = await sb.from('treatment_plan_items').select('tooth, status')
  .in('id',(await sb.from('treatment_plan_items').select('id').eq('plan_id',plan.body.planId)).data!.map(x=>x.id));
ok((items??[]).every(i=>i.status==='done'),'оба пункта плана закрыты одной строкой услуги',
   (items??[]).map(i=>`${i.tooth}:${i.status}`).join(' '));
const svcTeeth=(await sb.from('visit_services').select('teeth, quantity').eq('visit_id',vid).single()).data;
ok((svcTeeth?.teeth??[]).length===2,'у услуги два зуба, а строка одна',
   JSON.stringify(svcTeeth?.teeth));
ok(!(svcTeeth?.teeth??[]).includes('99'),'повтор и мусор в списке зубов не сохранились');

// Повторное закрытие не должно плодить дубли: частичный уникальный индекс
// с nulls not distinct и тем же предикатом в on conflict. На этом я уже
// спотыкался в 067, поэтому проверяю, а не надеюсь.
await sb.from('visits').update({status:'open'}).eq('id',vid);
await sb.from('visits').update({status:'closed'}).eq('id',vid);
const { count: again } = await sb.from('clinical_entries')
  .select('*',{count:'exact',head:true}).eq('visit_id',vid);
ok((again??0)===2,'повторное закрытие приёма не создало дублей',`${again}`);

console.log('\n── Врач: доступ живёт ровно от записи до закрытия приёма ──');
// Приём УЖЕ закрыт, и права у врача больше нет — таково правило: карта
// открыта, пока пациент записан или приём не закрыт. Проверяем именно это,
// а не «врач всегда видит своего пациента».
const recAafter=await docA(`/doctor/patients/${patientId}/record`);
ok(recAafter.status===403,'после закрытия приёма карта закрылась и для лечившего врача',
   `${recAafter.status}`);
const scaleA=await docA('/doctor/cabinet/scale');
ok(Number(scaleA.body.records)===3,'кабинет знает, сколько записей переживёт его удаление',
   JSON.stringify(scaleA.body.records));

console.log('\n── Второй кабинет видит историю, но не всегда ──');
const before=await sb.rpc('doctor_may_see_person',{p_tenant_id:tB,p_subject:`tg:${PAT}`});
ok(before.data===false,'до записи второй кабинет истории не видит');
const linkB=(await sb.from('tenants').select('public_token').eq('id',tB).single()).data!.public_token;
const pat2=as(PAT,linkB);
const info2=await pat2('/book/info');
const svc2=(info2.body.services??[])[0];
const slots2=await pat2(`/book/slots?serviceId=${svc2.id}&days=21`);
const booked2=await pat2('/book',{method:'POST',body:JSON.stringify({serviceId:svc2.id,startsAt:slots2.body.days[0].times[0],name:'Носитель Истории'})});
ok(booked2.status===200,'пациент записался во второй кабинет',String(booked2.body.error??''));
const after=await sb.rpc('doctor_may_see_person',{p_tenant_id:tB,p_subject:`tg:${PAT}`});
ok(after.data===true,'ПОСЛЕ ЗАПИСИ доступ открылся — врач готовится заранее');
const rec=await sb.rpc('person_record_for_doctor',{p_tenant_id:tB,p_subject:`tg:${PAT}`,p_actor:`tg:${B}`});
ok(!rec.error && (rec.data as any[]).length===3,'второй врач видит лечение первого',String(rec.error?.message??''));
ok((rec.data as any[])[0].cabinet==='Первый Кабинет','видно, где лечили');

console.log('\n── Исправление дополнением ──');
const entry=sealed![0].id;
const empty=await docB(`/doctor/record/${entry}/amend`,{method:'POST',body:JSON.stringify({note:'   '})});
ok(empty.status===400,'пустое дополнение отклонено',String(empty.status));
const am=await docB(`/doctor/record/${entry}/amend`,{method:'POST',body:JSON.stringify({note:'Зуб 26, а не 27'})});
ok(am.status===200,'дополнение добавлено',String(am.body.error??''));
const { data: all } = await sb.from('clinical_entries').select('id, amends, note').eq('person_subject',`tg:${PAT}`);
ok((all??[]).length===4,'дополнение добавилось, исходные целы',`${(all??[]).length}`);
ok((all??[]).some(e=>e.amends===entry),'дополнение ссылается на исходную');
const orig=(all??[]).find(e=>e.id===entry);
ok(orig!=null && orig.note==null,'исходная запись НЕ переписана');

console.log('\n── Журнал доступа ──');
const { count: logged } = await sb.from('access_log').select('*',{count:'exact',head:true})
  .in('action',['clinical_record','clinical_amend']).eq('detail',`tg:${PAT}`);
ok((logged??0)>=2,'обращения к истории записаны',`${logged}`);

console.log('\n── Доступ закрывается вместе с записью ──');
const recB=await docB(`/doctor/patients/${booked2.body.patientId}/record`);
ok(recB.status===200 && (recB.body.entries??[]).length===4,'пока пациент записан — карта открыта',
   `${recB.status} ${(recB.body.entries??[]).length}`);
const cancelled=await pat2(`/me/appointments/${booked2.body.appointmentId}/cancel`,{method:'POST'});
ok(cancelled.status===200,'пациент отменил запись',String(cancelled.body.error??''));
const recBafter=await docB(`/doctor/patients/${booked2.body.patientId}/record`);
ok(recBafter.status===403,'ПОСЛЕ ОТМЕНЫ карта закрылась',`${recBafter.status}`);
const amAfter=await docB(`/doctor/record/${entry}/amend`,{method:'POST',body:JSON.stringify({note:'поздно'})});
ok(amAfter.status===400,'дополнить закрытую карту нельзя',`${amAfter.status}`);

console.log('\n── Кабинет исчезает, история остаётся ──');
const killed=await docA('/doctor/cabinet',{method:'DELETE'});
ok(killed.status===200,'первый кабинет удалён',String(killed.body.error??''));
// Без start_param: у человека больше нет кабинета, из которого он пришёл, —
// и карта всё равно должна открыться. Это и есть «карта принадлежит вам».
const stillMine=await as(PAT)('/me/record');
ok((stillMine.body.entries??[]).length===4,'пациент по-прежнему открывает свою карту',
   `${(stillMine.body.entries??[]).length}`);
ok((stillMine.body.entries??[]).every((e:any)=>e.cabinet),'в карте осталось имя закрытого кабинета');
const { data: survived } = await sb.from('clinical_entries').select('*').eq('person_subject',`tg:${PAT}`);
ok((survived??[]).length===4,'записи целы после удаления кабинета',`${(survived??[]).length}`);
const first=(survived??[]).find(e=>e.id===entry)!;
ok(first.author_tenant_id===null,'ссылка на кабинет обнулена');
ok(first.author_cabinet==='Первый Кабинет','НО имя кабинета осталось — запись читаема');
ok((survived??[]).some(e=>e.tooth==='36'),'зуб пережил удаление кабинета вместе с записью');
ok(first.visit_id===null,'связь с приёмом обнулена');
const { count: patientsGone } = await sb.from('patients').select('*',{count:'exact',head:true}).eq('tenant_id',tA);
ok((patientsGone??0)===0,'работа кабинета стёрта полностью');

console.log('\n── Сверка ──');
const { data: health } = await sb.rpc('clinical_health',{});
ok((health as any).missing===0,'сторож истории: пропусков нет',JSON.stringify(health));

console.log('\n── Уборка ──');
await sb.from('clinical_entries').delete().eq('person_subject',`tg:${PAT}`);
const d=await sb.rpc('delete_tenant',{p_tenant_id:tB}); ok(!d.error,'второй кабинет удалён',d.error?.message??'');
await sb.from('app_users').delete().in('subject',[`tg:${A}`,`tg:${B}`,`tg:${PAT}`]);
console.log(`\n${problems.length?`НЕ ПРОШЛО: ${problems.join('; ')}`:'Переносимая история работает.'}`);
if(problems.length) process.exit(1);
