/** Отметки состояний: палитра, вытеснение, снятие, доступ, живучесть. */
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

const A=990901, B=990902, PAT=990903;
await sb.from('memberships').delete().in('subject',[`tg:${A}`,`tg:${B}`]);
await sb.from('app_users').delete().in('subject',[`tg:${A}`,`tg:${B}`,`tg:${PAT}`]);
const docA=as(A), docB=as(B);

console.log('── Кабинеты и пациент ──');
const rA=await docA('/onboarding/register',{method:'POST',body:JSON.stringify({name:'Кабинет Отметок',doctorName:'Каримов А.А.',template:'therapist'})});
const rB=await docB('/onboarding/register',{method:'POST',body:JSON.stringify({name:'Второй Отметок',doctorName:'Юсупов Б.Б.',template:'therapist'})});
const tA=rA.body.tenantId as string, tB=rB.body.tenantId as string;
await docA('/onboarding/finish',{method:'POST'}); await docB('/onboarding/finish',{method:'POST'});
const linkA=(await sb.from('tenants').select('public_token').eq('id',tA).single()).data!.public_token;
await sb.rpc('set_verified_phone',{p_subject:`tg:${PAT}`,p_phone:'+998900990903'});
const pat=as(PAT,linkA);
const info=await pat('/book/info');
const svc=(info.body.services??[])[0];
const slots=await pat(`/book/slots?serviceId=${svc.id}&days=21`);
const booked=await pat('/book',{method:'POST',body:JSON.stringify({serviceId:svc.id,startsAt:slots.body.days[0].times[0],name:'Носитель Отметок'})});
ok(booked.status===200,'пациент записался',String(booked.body.error??''));
const pid=booked.body.patientId as string;

console.log('\n── Палитра ──');
const chart=await docA(`/doctor/patients/${pid}/teeth`);
ok(chart.status===200,'зубная карта открыта',String(chart.body.error??''));
ok((chart.body.palette??[]).length>=30,'палитра пришла с картой',`${(chart.body.palette??[]).length}`);
const groups=new Set((chart.body.palette??[]).map((x:any)=>x.category));
ok(groups.size===5,'пять групп отметок',[...groups].join(','));
const caries=(chart.body.palette??[]).find((x:any)=>x.code==='caries');
ok(caries?.name==='Кариес' && /^#[0-9a-f]{6}$/.test(caries?.color),'у отметки есть имя и цвет',JSON.stringify(caries));
ok((chart.body.marks??[]).length===0,'отметок пока нет');

console.log('\n── Кариес, пломба, коронка ──');
const bad=await docA(`/doctor/patients/${pid}/teeth`,{method:'POST',body:JSON.stringify({tooth:'26',code:'нетакой'})});
ok(bad.status===400,'неизвестная отметка отклонена',`${bad.status}`);
const badTooth=await docA(`/doctor/patients/${pid}/teeth`,{method:'POST',body:JSON.stringify({tooth:'99',code:'caries'})});
ok(badTooth.status===400,'зуб не по FDI отклонён',`${badTooth.status}`);
for (const [tooth,code] of [['26','caries'],['36','filling'],['46','crown_metal_cer'],['26','canal_full']] as const) {
  const r=await docA(`/doctor/patients/${pid}/teeth`,{method:'POST',body:JSON.stringify({tooth,code})});
  ok(r.status===200,`${tooth}: ${code}`,String(r.body.error??''));
}
const after=await docA(`/doctor/patients/${pid}/teeth`);
ok((after.body.marks??[]).length===4,'четыре отметки на карте',`${(after.body.marks??[]).length}`);
const t26=(after.body.marks??[]).filter((m:any)=>m.tooth==='26');
ok(t26.length===2,'на 26 живут кариес и канал сразу — это разные группы',
   t26.map((m:any)=>m.category).join(','));

console.log('\n── Кариес стал пломбой ──');
const heal=await docA(`/doctor/patients/${pid}/teeth`,{method:'POST',body:JSON.stringify({tooth:'26',code:'filling'})});
ok(heal.status===200,'на 26 поставлена пломба',String(heal.body.error??''));
const now=await docA(`/doctor/patients/${pid}/teeth`);
const cur26=(now.body.marks??[]).filter((m:any)=>m.tooth==='26');
// Пломба НЕ снимает кариес: это разные группы, и на одном зубе бывает и
// пломба, и кариес на другой поверхности. Снимает врач, руками — программа
// не должна решать за него, что зуб вылечен.
ok(cur26.some((m:any)=>m.code==='caries'),'кариес на 26 остался — пломба его не отменяет');
ok(cur26.some((m:any)=>m.code==='filling'),'пломба встала рядом');
ok(cur26.some((m:any)=>m.code==='canal_full'),'канал не тронут — третья группа');
const cured=await docA(`/doctor/patients/${pid}/teeth`,{method:'POST',body:JSON.stringify({tooth:'26',category:'lesion'})});
ok(cured.status===200,'врач снял кариес сам',String(cured.body.error??''));
const now2=await docA(`/doctor/patients/${pid}/teeth`);
ok(!(now2.body.marks??[]).some((m:any)=>m.tooth==='26'&&m.code==='caries'),'кариеса на 26 больше нет');
ok((now2.body.history??[]).some((h:any)=>h.tooth==='26'&&h.code==='caries'),
   'КАРИЕС ОСТАЛСЯ В ИСТОРИИ, а не стёрт');

const inflated=await docA(`/doctor/patients/${pid}/teeth`);
ok((inflated.body.marks??[]).filter((m:any)=>m.tooth==='26').length===2,
   'на 26 осталось ровно две отметки', String((inflated.body.marks??[]).filter((m:any)=>m.tooth==='26').length));

console.log('\n── Снятие ──');
const off=await docA(`/doctor/patients/${pid}/teeth`,{method:'POST',body:JSON.stringify({tooth:'36',category:'build'})});
ok(off.status===200,'отметка снята',String(off.body.error??''));
const after2=await docA(`/doctor/patients/${pid}/teeth`);
ok(!(after2.body.marks??[]).some((m:any)=>m.tooth==='36'),'на 36 отметок нет');
ok((after2.body.history??[]).some((h:any)=>h.tooth==='36'&&h.code===null),'снятие тоже записано в историю');

console.log('\n── Пациент видит своё ──');
const mine=await pat('/me/teeth');
ok(mine.status===200,'пациент открыл свои зубы',String(mine.body.error??''));
ok((mine.body.marks??[]).length===(after2.body.marks??[]).length,'видит то же состояние',
   `${(mine.body.marks??[]).length}`);
ok((mine.body.marks??[]).every((m:any)=>m.name&&m.color),'с названиями и цветами');

console.log('\n── Другой кабинет ──');
const closed=await docB(`/doctor/patients/${pid}/teeth`);
ok(closed.status===404,'чужой пациент второму кабинету не виден',`${closed.status}`);
const linkB=(await sb.from('tenants').select('public_token').eq('id',tB).single()).data!.public_token;
const pat2=as(PAT,linkB);
const info2=await pat2('/book/info');
const svc2=(info2.body.services??[])[0];
const slots2=await pat2(`/book/slots?serviceId=${svc2.id}&days=21`);
const b2=await pat2('/book',{method:'POST',body:JSON.stringify({serviceId:svc2.id,startsAt:slots2.body.days[0].times[0],name:'Носитель Отметок'})});
ok(b2.status===200,'пациент записался во второй кабинет',String(b2.body.error??''));
const seen=await docB(`/doctor/patients/${b2.body.patientId}/teeth`);
ok(seen.status===200,'после записи второй кабинет видит зубы',String(seen.body.error??''));
ok((seen.body.marks??[]).some((m:any)=>m.cabinet==='Кабинет Отметок'),
   'ВИДИТ ОТМЕТКИ ПЕРВОГО КАБИНЕТА — карта переносится');
const cancel=await pat2(`/me/appointments/${b2.body.appointmentId}/cancel`,{method:'POST'});
ok(cancel.status===200,'запись отменена',String(cancel.body.error??''));
const shut=await docB(`/doctor/patients/${b2.body.patientId}/teeth`);
ok(shut.status===403,'после отмены зубы закрылись',`${shut.status}`);
const late=await docB(`/doctor/patients/${b2.body.patientId}/teeth`,{method:'POST',body:JSON.stringify({tooth:'11',code:'caries'})});
ok(late.status===400,'и отмечать больше нельзя',`${late.status}`);

console.log('\n── Журнал ──');
const { count: logged } = await sb.from('access_log').select('*',{count:'exact',head:true}).eq('action','tooth_mark');
ok((logged??0)>=6,'каждая отметка записана в журнал',`${logged}`);

console.log('\n── Кабинет исчезает, отметки остаются ──');
const killed=await docA('/doctor/cabinet',{method:'DELETE'});
ok(killed.status===200,'первый кабинет удалён',String(killed.body.error??''));
const still=await as(PAT)('/me/teeth');
ok((still.body.marks??[]).length>0,'пациент по-прежнему видит свои зубы',
   `${(still.body.marks??[]).length}`);
ok((still.body.marks??[]).every((m:any)=>m.cabinet),'имя закрытого кабинета осталось в отметке');
const { data: orphan } = await sb.from('tooth_marks').select('tenant_id').eq('person_subject',`tg:${PAT}`).limit(1);
ok(orphan?.[0]?.tenant_id===null,'ссылка на кабинет обнулена');

console.log('\n── Уборка ──');
await sb.rpc('delete_tenant',{p_tenant_id:tB});
await sb.from('app_users').delete().in('subject',[`tg:${A}`,`tg:${B}`,`tg:${PAT}`]);
console.log(`\n${problems.length?`НЕ ПРОШЛО: ${problems.join('; ')}`:'Отметки состояний работают.'}`);
if(problems.length) process.exit(1);
