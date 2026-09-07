import { Hono } from 'hono';
import { closeVisit } from '../close.js';
import { TenantScope, type Env, type Identity } from '../db.js';
import type { SupabaseClient } from '@supabase/supabase-js';

type Vars = { scope: TenantScope; identity: Identity; sb: SupabaseClient };
export const onboarding = new Hono<{ Bindings: Env; Variables: Vars }>();

/**
 * Регистрация кабинета и знакомство с ним.
 *
 * Врач получает не пустой экран, а кабинет с выдуманной работой: на пустом
 * складе и пустом календаре показывать нечего, а именно отчёт «сверх
 * материалов по услугам» и продаёт продукт.
 *
 * Демо-приёмы закрываются ТЕМ ЖЕ распределителем, что считает настоящую
 * себестоимость. Отдельная упрощённая версия для демо однажды разошлась бы
 * с боевой — и показала бы врачу цифру, которой в его кабинете не бывает.
 */

/**
 * Что предлагается при регистрации.
 *
 * Две разные вещи, которые раньше были одной. Справочник — стартовые
 * материалы, техкарты и нормы расхода; он подставляется один раз.
 * Специализации — чем кабинет занимается; их несколько, и пациент ищет
 * именно по ним.
 */
onboarding.get('/templates', async (c) => {
  const sb = c.get('sb');
  const [tpl, spec] = await Promise.all([
    sb.rpc('available_templates', {}),
    sb.rpc('specialty_list', {}),
  ]);
  if (tpl.error) return c.json({ error: tpl.error.message }, 500);
  return c.json({ templates: tpl.data ?? [], specialties: spec.data ?? [] });
});

onboarding.post('/register', async (c) => {
  const id = c.get('identity');
  const sb = c.get('sb');
  const b = await c.req.json<{
    name?: string; template?: string; doctorName?: string; withDemo?: boolean;
    specialties?: string[];
  }>().catch(() => ({} as Record<string, never>));

  const name = String((b as { name?: string }).name ?? '').trim();
  if (name.length < 2) return c.json({ error: 'укажите название кабинета' }, 400);
  if (name.length > 80) return c.json({ error: 'название слишком длинное' }, 400);

  const { data: prov, error } = await sb.rpc('provision_tenant', {
    p_subject: id.subject,
    p_name: name,
    p_template_code: (b as { template?: string }).template ?? 'therapist',
    // Имя врача больше не спрашивается второй раз: человек назвал ФИО при
    // знакомстве с платформой, и переспрашивать его через две минуты —
    // сомневаться в том, что он только что написал.
    p_doctor_name: (b as { doctorName?: string }).doctorName || id.fullName || null,
  });
  if (error) return c.json({ error: error.message }, 400);

  const created = prov as { tenantId: string; name: string; publicToken: string };

  // Специализации: их может быть несколько, и справочнику они не равны.
  // Молча падать нельзя, но и откатывать созданный кабинет из-за списка
  // специализаций неправильно — врач поправит их в «Показе в поиске».
  const codes = (b as { specialties?: string[] }).specialties;
  if (Array.isArray(codes) && codes.length) {
    await sb.rpc('set_cabinet_specialties', {
      p_tenant_id: created.tenantId, p_codes: codes,
    });
  }

  // Демо готовится сразу: врач должен увидеть работающий кабинет в ту же
  // минуту, иначе он закроет приложение и не вернётся.
  if ((b as { withDemo?: boolean }).withDemo !== false) {
    try {
      await seedDemo(sb, created.tenantId);
    } catch (err) {
      // Кабинет уже создан и рабочий — демо не критично. Молчать нельзя,
      // но и откатывать регистрацию из-за витрины неправильно.
      console.error('демо-данные:', (err as Error).message);
      return c.json({ ...created, demo: false, demoError: (err as Error).message });
    }
  }
  return c.json({ ...created, demo: true });
});

/**
 * Наполнение демо-данными.
 *
 * Подготовка — одним запросом в БД, закрытие приёмов — распределителем
 * воркера, по два обращения на приём. Двенадцать приёмов это около двух
 * секунд ожидания: терпимо один раз при регистрации.
 */
async function seedDemo(sb: SupabaseClient, tenantId: string): Promise<void> {
  const { data, error } = await sb.rpc('seed_demo_data', { p_tenant_id: tenantId });
  if (error) throw new Error(error.message);

  const scope = new TenantScope(sb, tenantId);
  const ids = ((data ?? []) as { visit_id: string }[]).map((r) => r.visit_id);
  for (const visitId of ids) {
    // Приём, который не закрылся, оставляем открытым: он попадёт в ленту дня
    // как незакрытый, что честнее выдуманного успеха.
    await closeVisit(scope, visitId).catch((e) => console.error('демо-приём:', e.message));
  }
}

/** Экран пройден. Список закрытый — проверяет БД. */
onboarding.post('/seen', async (c) => {
  const b = await c.req.json<{ screen?: string }>().catch(() => ({}));
  const state = await c.get('scope').rpc<Record<string, unknown>>('onboarding_seen', {
    p_screen: (b as { screen?: string }).screen ?? '',
  });
  return c.json({ onboarding: state });
});

/**
 * Конец знакомства.
 *
 * Стирается выдуманная работа, справочник остаётся: врачу дальше сверять
 * материалы и цены со своими, а не заводить 53 позиции заново.
 */
onboarding.post('/finish', async (c) => {
  const wiped = await c.get('scope').rpc<Record<string, number>>('wipe_demo', {});
  return c.json({ wiped });
});

/** Врач подтвердил, что сверил материалы и цены со своими. */
onboarding.post('/reviewed', async (c) => {
  await c.get('scope').rpc('mark_catalog_reviewed', {});
  return c.json({ ok: true });
});
