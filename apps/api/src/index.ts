import { Hono } from 'hono';
import { subjectFor, verifyInitData } from './auth.js';
import { closeVisit } from './close.js';
import { createServiceClient, resolveIdentity, scopeFor, TenantScope, type Env, type Identity } from './db.js';
import { doctor } from './routes/doctor.js';
import { patient } from './routes/patient.js';
import { warehouse } from './routes/warehouse.js';
import { onboarding } from './routes/onboarding.js';
import { creditTelegramPayment, sendInvoice, subscriptionState, type Plan } from './billing.js';
import { confirmedText, notifyReminder, notifyStaffCancelled, notifyStaffRescheduled } from './notify.js';

type Vars = { scope: TenantScope; identity: Identity; sb: ReturnType<typeof createServiceClient> };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

/** Адрес мини-аппа. Нужен и вебхуку для кнопок, и напоминаниям для «Перенести». */
const miniapp = (env: Env) => env.MINIAPP_URL ?? 'https://stomiko-api.alrevion.workers.dev';

app.use('/api/*', async (c, next) => {
  const initData = c.req.header('X-Telegram-Init-Data');
  if (!initData) return c.json({ error: 'нет initData' }, 401);
  try {
    const verified = await verifyInitData(initData, c.env.TELEGRAM_BOT_TOKEN);
    const sb = createServiceClient(c.env);
    const subject = subjectFor(verified.user);
    const identity = await resolveIdentity(
      sb, subject, verified.startParam,
      (verified.user as { first_name?: string } | null)?.first_name,
    );
    c.set('sb', sb);
    c.set('identity', identity);
    // Кабинета может не быть вовсе: человек здесь впервые и без ссылки.
    // Тогда работают только маршруты /api/me — им тенант не нужен.
    if (identity.tenantId) c.set('scope', await scopeFor(c.env, sb, identity.tenantId));
  } catch (err) {
    return c.json({ error: (err as Error).message }, 401);
  }
  return next();
});

/**
 * Кто я и что мне показывать.
 *
 * Отдаём не роль, а РЕЖИМ плюс список доступных режимов: приложение у врача и
 * у пациента разное, но человек может быть и тем и другим — стоматолог тоже
 * лечит зубы.
 */
app.get('/api/me', (c) => {
  const id = c.get('identity');
  return c.json({
    mode: id.mode,
    canBeDoctor: id.canBeDoctor,
    needsChoice: id.needsChoice,
    ownLink: id.ownLink,
    cabinet: id.tenantName,
    tenantId: id.tenantId,
    staffOf: id.staffOf,
    patientOf: id.patientOf,
    phone: id.phone,
    onboarding: id.onboarding,
    catalogReviewed: id.catalogReviewed,
    bot: c.env.TELEGRAM_BOT_USERNAME ?? 'stomiko_bot',
  });
});

/** Переключение режима. Врачом делает членство, а не желание — проверяет БД. */
app.post('/api/me/mode', async (c) => {
  const id = c.get('identity');
  const b = await c.req.json<{ mode?: string; tenantId?: string }>().catch(() => ({}));
  try {
    const res = await c.get('sb').rpc('set_user_mode', {
      p_subject: id.subject,
      p_mode: (b as { mode?: string }).mode ?? 'patient',
      p_tenant_id: (b as { tenantId?: string }).tenantId ?? null,
    });
    if (res.error) throw new Error(res.error.message);
    return c.json(res.data);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

/** Записи пациента по всем кабинетам, где он лечится. */
app.get('/api/me/appointments', async (c) => {
  const id = c.get('identity');
  const { data, error } = await c.get('sb').rpc('my_appointments', { p_subject: id.subject });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({
    appointments: ((data ?? []) as Record<string, unknown>[]).map((a) => ({
      id: a.id,
      tenantId: a.tenant_id,
      cabinet: a.cabinet,
      startsAt: a.starts_at,
      status: a.status,
      service: a.service ?? '—',
      price: a.price,
      past: a.is_past,
      confirmed: Boolean(a.confirmed),
    })),
  });
});

/**
 * Отмена своей записи в ЛЮБОМ кабинете, где человек лечится.
 *
 * Пациентский маршрут `/book/my/:id/cancel` работает только в активном
 * кабинете, а список записей теперь сквозной: человек видит записи в трёх
 * кабинетах и вправе отменить любую, не переключаясь между ними.
 */
app.post('/api/me/appointments/:id/cancel', async (c) => {
  const id = c.get('identity');
  const sb = c.get('sb');
  const apptId = c.req.param('id');

  // Право проверяется принадлежностью: в выдаче только СВОИ записи.
  const { data: mine } = await sb.rpc('my_appointments', { p_subject: id.subject });
  const appt = ((mine ?? []) as Record<string, unknown>[]).find((a) => String(a.id) === apptId);
  if (!appt) return c.json({ error: 'запись не найдена' }, 404);
  if (appt.is_past) return c.json({ error: 'приём уже прошёл' }, 400);

  try {
    const { data: notice, error } = await sb.rpc('cancel_appointment', {
      p_tenant_id: appt.tenant_id,
      p_appointment_id: apptId,
      p_by: 'пациент',
      p_reason: null,
    });
    if (error) throw new Error(error.message);

    const n = notice as Record<string, unknown>;
    const { data: staff } = await sb.rpc('tenant_staff', { p_tenant_id: appt.tenant_id });
    await notifyStaffCancelled(c.env.TELEGRAM_BOT_TOKEN,
      ((staff ?? []) as { subject: string }[]).map((x) => x.subject), {
        patientName: String(n.patientName ?? ''),
        patientPhone: (n.patientPhone as string | null) ?? null,
        serviceName: (n.serviceName as string | null) ?? null,
        startsAt: String(n.startsAt ?? ''),
      });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

/**
 * Поиск стоматолога.
 *
 * Единственный маршрут, который работает БЕЗ кабинета: человек пришёл по
 * рекламе, ссылки врача у него нет, и до этого экрана он упирался в тупик.
 *
 * Идёт под служебным ключом, а не под областью кабинета: он по смыслу
 * пересекает кабинеты. Отдаёт ровно тот набор полей, который кабинет сам
 * открыл, — не «те же данные с фильтром», а другой набор.
 */
app.get('/api/find', async (c) => {
  const sb = c.get('sb');
  const [cabs, cities] = await Promise.all([
    sb.rpc('public_cabinets', {
      p_city: c.req.query('city') ?? null,
      p_query: c.req.query('q') ?? null,
    }),
    sb.rpc('public_cities', {}),
  ]);
  if (cabs.error) return c.json({ error: cabs.error.message }, 500);
  return c.json({
    cabinets: ((cabs.data ?? []) as Record<string, unknown>[]).map((r) => ({
      tenantId: r.tenant_id,
      name: r.name,
      doctor: r.doctor,
      city: r.city,
      address: r.address,
      landmark: r.landmark,
      phone: r.phone,
      consultPrice: r.consult_price == null ? null : Number(r.consult_price),
      nextSlot: r.next_slot,
    })),
    cities: ((cities.data ?? []) as Record<string, unknown>[])
      .map((r) => ({ city: r.city, cabinets: Number(r.cabinets) })),
  });
});

/** Выбор кабинета из поиска. Право даёт публикация, а не знание номера. */
app.post('/api/me/choose', async (c) => {
  const b = await c.req.json<{ tenantId?: string }>().catch(() => ({} as { tenantId?: string }));
  if (!b.tenantId) return c.json({ error: 'не выбран кабинет' }, 400);
  try {
    const { data, error } = await c.get('sb').rpc('choose_public_cabinet', {
      p_subject: c.get('identity').subject, p_tenant_id: b.tenantId,
    });
    if (error) throw new Error(error.message);
    return c.json(data);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

/**
 * План лечения глазами пациента.
 *
 * Сквозной, как список записей: человек лечится в нескольких кабинетах и
 * должен видеть все свои планы, не переключаясь между ними.
 *
 * Себестоимости здесь нет и быть не может — функция БД отдаёт пациенту
 * другой набор полей, а не тот же с погашенными колонками.
 */
app.get('/api/me/plans', async (c) => {
  const { data, error } = await c.get('sb').rpc('my_treatment_plans', {
    p_subject: c.get('identity').subject,
  });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ plans: data ?? [] });
});

/**
 * Своя медицинская карта.
 *
 * Ключ — подписанный subject, а не кабинет: карта принадлежит человеку и
 * читается целиком, включая записи кабинетов, которых уже нет. Поэтому
 * маршрут сквозной и не требует активного кабинета — человек, ушедший от
 * своего стоматолога, не должен терять доступ к тому, что ему лечили.
 */
app.get('/api/me/record', async (c) => {
  const { data, error } = await c.get('sb').rpc('my_clinical_record', {
    p_subject: c.get('identity').subject,
  });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ entries: data ?? [] });
});

/**
 * Своя зубная карта: что с зубами сейчас, по отметкам всех кабинетов.
 *
 * Только чтение: состояние зубов ставит врач, а не пациент. Палитра нужна и
 * здесь — без неё «filling» так и осталось бы словом «filling».
 */
app.get('/api/me/teeth', async (c) => {
  const sb = c.get('sb');
  const [chart, palette] = await Promise.all([
    sb.rpc('my_tooth_chart', { p_subject: c.get('identity').subject }),
    sb.rpc('mark_palette', {}),
  ]);
  if (chart.error) return c.json({ error: chart.error.message }, 500);
  return c.json({ ...(chart.data as object), palette: palette.data ?? [] });
});

/**
 * Куда можно перенести — и сам перенос.
 *
 * Оба маршрута сквозные, как отмена: человек лечится в нескольких кабинетах,
 * а ссылка «Перенести» приходит из напоминания любого из них. Заставлять его
 * сперва переключить кабинет — значит показать ошибку вместо сетки времени.
 *
 * Право проверяется принадлежностью: в выдаче my_appointments только СВОИ
 * записи, и кабинет для вызова берётся оттуда же, а не из запроса.
 */
async function ownAppointment(
  sb: ReturnType<typeof createServiceClient>, subject: string, apptId: string,
) {
  const { data } = await sb.rpc('my_appointments', { p_subject: subject });
  const a = ((data ?? []) as Record<string, unknown>[]).find((x) => String(x.id) === apptId);
  if (!a) return { error: 'запись не найдена', status: 404 as const };
  if (a.is_past) return { error: 'приём уже прошёл', status: 400 as const };
  if (a.status === 'cancelled') return { error: 'запись отменена', status: 400 as const };
  return { appt: a };
}

app.get('/api/me/appointments/:id/slots', async (c) => {
  const sb = c.get('sb');
  const own = await ownAppointment(sb, c.get('identity').subject, c.req.param('id'));
  if (own.error) return c.json({ error: own.error }, own.status);

  const from = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' });
  const days = Math.min(Number(c.req.query('days') ?? 21), 60);
  const to = new Date(Date.now() + days * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' });

  const { data, error } = await sb.rpc('appointment_slots', {
    p_tenant_id: own.appt!.tenant_id, p_appointment_id: c.req.param('id'), p_from: from, p_to: to,
  });
  if (error) return c.json({ error: error.message }, 400);

  // Группировка по дням: выбирают сначала день, потом время. Плоский список
  // из двухсот слотов с телефона не читается.
  const byDate = new Map<string, string[]>();
  for (const s of (data ?? []) as { slot_start: string; slot_date: string }[]) {
    byDate.set(s.slot_date, [...(byDate.get(s.slot_date) ?? []), s.slot_start]);
  }
  const fmt = (d: string, o: Intl.DateTimeFormatOptions) =>
    new Date(`${d}T12:00:00+05:00`).toLocaleDateString('ru-RU', { ...o, timeZone: 'Asia/Tashkent' });

  return c.json({
    current: { startsAt: own.appt!.starts_at, service: own.appt!.service ?? '—', cabinet: own.appt!.cabinet },
    days: [...byDate.entries()].map(([date, times]) => ({
      date,
      weekday: fmt(date, { weekday: 'short' }),
      label: fmt(date, { day: 'numeric', month: 'long' }),
      times,
    })),
  });
});

app.post('/api/me/appointments/:id/reschedule', async (c) => {
  const sb = c.get('sb');
  const own = await ownAppointment(sb, c.get('identity').subject, c.req.param('id'));
  if (own.error) return c.json({ error: own.error }, own.status);

  const b = await c.req.json<{ startsAt?: string }>().catch(() => ({} as { startsAt?: string }));
  if (!b.startsAt) return c.json({ error: 'не выбрано время' }, 400);

  try {
    const { data, error } = await sb.rpc('reschedule_appointment', {
      p_tenant_id: own.appt!.tenant_id,
      p_appointment_id: c.req.param('id'),
      p_starts_at: b.startsAt,
    });
    if (error) throw new Error(error.message);
    const n = data as Record<string, unknown>;

    // Врач узнаёт сразу: прежнее окно освободилось, и его ещё можно отдать.
    const { data: staff } = await sb.rpc('tenant_staff', { p_tenant_id: own.appt!.tenant_id });
    await notifyStaffRescheduled(c.env.TELEGRAM_BOT_TOKEN,
      ((staff ?? []) as { subject: string }[]).map((x) => x.subject), {
        patientName: String(n.patientName ?? ''),
        patientPhone: (n.patientPhone as string | null) ?? null,
        serviceName: (n.serviceName as string | null) ?? null,
        wasAt: String(n.wasAt ?? ''),
        startsAt: String(n.startsAt ?? ''),
      });
    return c.json({ ok: true, startsAt: n.startsAt });
  } catch (err) {
    const msg = (err as Error).message;
    // Слот мог уйти между показом и нажатием — это обычная гонка, и правду
    // надо сказать прямо, а не «ошибка сервера». Два случая различаются:
    // «заняли» — это факт о другом пациенте, и утверждать его, когда время
    // просто выпало из сетки (кончился рабочий день, прошёл срок), нельзя.
    if (msg.includes('занят')) {
      return c.json({ error: 'Это время только что заняли. Выберите другое.' }, 409);
    }
    if (msg.includes('недоступно')) {
      return c.json({ error: 'Это время больше не предлагается. Выберите другое.' }, 409);
    }
    return c.json({ error: msg }, 400);
  }
});

// Справочники и регистрация доступны без кабинета: его как раз и создают.
app.route('/api/onboarding', onboarding);

/** Состояние подписки и планы. Доступно даже замороженному — иначе не оплатить. */
app.get('/api/billing', async (c) => {
  const id = c.get('identity');
  if (!id.tenantId) return c.json({ error: 'кабинет не выбран' }, 400);
  const sb = c.get('sb');
  const [state, plans] = await Promise.all([
    subscriptionState(sb, id.tenantId),
    sb.rpc('subscription_plans_list', {}),
  ]);
  return c.json({ subscription: state, plans: plans.data ?? [] });
});

/** Счёт на оплату уходит в чат с ботом: платят там, а не внутри Mini App. */
app.post('/api/billing/invoice', async (c) => {
  const id = c.get('identity');
  if (!id.tenantId) return c.json({ error: 'кабинет не выбран' }, 400);
  const b = await c.req.json<{ plan?: string }>().catch(() => ({}));
  const sb = c.get('sb');

  const { data: plans } = await sb.rpc('subscription_plans_list', {});
  const plan = ((plans ?? []) as Plan[]).find((p) => p.code === (b as { plan?: string }).plan);
  if (!plan) return c.json({ error: 'план не найден' }, 400);

  const chatId = id.subject.startsWith('tg:') ? id.subject.slice(3) : '';
  if (!chatId) return c.json({ error: 'нет чата с ботом' }, 400);

  const res = await sendInvoice(c.env, chatId, id.tenantId, plan);
  if (!res.ok) return c.json({ error: res.error }, 400);
  return c.json({ ok: true, bot: c.env.TELEGRAM_BOT_USERNAME ?? 'stomiko_bot' });
});

/**
 * Заморозка после неоплаты.
 *
 * Решение владельца: кабинет замирает целиком. Поэтому вся работа перенесена
 * в предупреждения — молча погасший кабинет это пациенты у закрытой двери.
 *
 * Уже назначенные записи НЕ отменяются и напоминания по ним продолжают
 * уходить: отменить чужой приём из-за долга владельца значит ударить по
 * пациенту за чужие обязательства.
 */
app.use('/api/doctor/*', async (c, next) => {
  const id = c.get('identity');
  if (!id.tenantId) return next();
  const st = await subscriptionState(c.get('sb'), id.tenantId);
  if (st?.frozen) {
    return c.json({
      error: 'кабинет заморожен — продлите подписку',
      frozen: true,
      paidUntil: st.paidUntil,
    }, 402);
  }
  return next();
});

/**
 * Пациент не должен видеть слово «оплата»: он ни при чём. Вместо записи —
 * телефон кабинета, чтобы человек всё-таки дозвонился.
 */
app.use('/api/book/*', async (c, next) => {
  const id = c.get('identity');
  if (!id.tenantId) return next();
  const st = await subscriptionState(c.get('sb'), id.tenantId);
  if (st?.frozen) {
    const { data } = await c.get('sb').from('tenants')
      .select('contact_phone').eq('id', id.tenantId).maybeSingle();
    return c.json({
      error: 'Кабинет временно не принимает онлайн-записи',
      paused: true,
      phone: (data as { contact_phone?: string } | null)?.contact_phone ?? null,
    }, 503);
  }
  return next();
});

/**
 * Врачебные маршруты закрыты режимом на уровне приложения, а не спрятаны в UI.
 * Пациент, который подставит /api/doctor/..., получит отказ, а не данные.
 */
app.use('/api/doctor/*', async (c, next) => {
  const id = c.get('identity');
  if (id.mode !== 'doctor' || !id.tenantId) return c.json({ error: 'доступ только для врача' }, 403);
  return next();
});

/** Пациентские маршруты требуют кабинета: без него записываться некуда. */
app.use('/api/book/*', async (c, next) => {
  if (!c.get('identity').tenantId) {
    return c.json({ error: 'кабинет не выбран — откройте ссылку врача' }, 400);
  }
  return next();
});
app.route('/api/doctor', doctor);
app.route('/api/doctor/stock', warehouse);
app.route('/api/book', patient);

/** Лента дня: то, с чего врач начинает. Незакрытые вчерашние подсвечены. */
app.get('/api/doctor/day', async (c) => {
  const scope = c.get('scope');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' });

  const { data, error } = await scope
    .select('visits', 'id, status, visit_date, closed_at, patients(full_name), visit_services(price, quantity, services(name_ru))')
    .or(`visit_date.eq.${today},and(status.eq.open,visit_date.lt.${today})`)
    .order('visit_date', { ascending: false });
  if (error) return c.json({ error: error.message }, 500);

  const costs = await scope.select('visit_costs', 'visit_id, materials_total, has_unpriced')
    .is('superseded_at', null);

  const costByVisit = new Map<string, { total: string; hasUnpriced: boolean }>();
  for (const row of (costs.data ?? []) as Record<string, unknown>[]) {
    costByVisit.set(String(row.visit_id), {
      total: String(row.materials_total),
      hasUnpriced: Boolean(row.has_unpriced),
    });
  }

  const visits = ((data ?? []) as Record<string, unknown>[]).map((v) => {
    const services = (v.visit_services ?? []) as Record<string, unknown>[];
    const revenue = services.reduce((s, x) => s + Number(x.price ?? 0), 0);
    const cost = costByVisit.get(String(v.id));
    return {
      id: v.id,
      status: v.status,
      visitDate: v.visit_date,
      overdue: v.status === 'open' && String(v.visit_date) < today,
      patient: (v.patients as { full_name?: string } | null)?.full_name ?? 'Без имени',
      services: services.map((x) => ({
        name: (x.services as { name_ru?: string } | null)?.name_ru ?? '—',
        quantity: x.quantity,
        price: x.price,
      })),
      revenue,
      cost: cost ? Number(cost.total) : null,
      margin: cost ? revenue - Number(cost.total) : null,
      hasUnpriced: cost?.hasUnpriced ?? false,
    };
  });

  return c.json({ today, visits });
});

app.get('/api/doctor/services', async (c) => {
  const scope = c.get('scope');
  const { data, error } = await scope
    .select('services', 'id, code, name_ru, name_uz, price, unit_of_norm')
    .order('name_ru');
  if (error) return c.json({ error: error.message }, 500);

  // Себестоимость нужна только редактору плана, и только там её и просим:
  // на каждую услугу это разворот техкарты, а список услуг открывается
  // ещё и при наборе приёма, где цифра не нужна.
  if (c.req.query('withCost') !== '1') return c.json({ services: data });

  // Расход делится на постоянную часть (кресло, анестезия — один раз на
  // приём) и переменную (на каждый канал, зуб, поверхность). Отдаём обе,
  // и редактор считает любую кратность сам, без запроса на каждое нажатие.
  const costs = await scope.rpc<{ service_id: string; base: string; per_unit: string; unpriced: number }[]>(
    'service_cost_parts', { p_tenant_id: scope.tenantId });
  const by = new Map((costs ?? []).map((x) => [String(x.service_id), x]));

  return c.json({
    services: ((data ?? []) as Record<string, unknown>[]).map((s) => {
      const c2 = by.get(String(s.id));
      return {
        ...s,
        costBase: Number(c2?.base ?? 0),
        costPerUnit: Number(c2?.per_unit ?? 0),
        unpricedLines: Number(c2?.unpriced ?? 0),
      };
    }),
  });
});

/** Walk-in: самотёк — норма для кабинета, приём создаётся без записи. */
app.post('/api/doctor/visits', async (c) => {
  const scope = c.get('scope');
  const body: { patientName?: string } = await c.req.json().catch(() => ({}));
  const [loc] = await scope.select('locations', 'id').limit(1).then((r) => r.data ?? []) as { id: string }[];
  if (!loc) return c.json({ error: 'у кабинета нет ни одного филиала' }, 400);

  const [patient] = await scope.insert('patients', {
    full_name: body.patientName?.trim() || 'Пациент без имени',
  });
  const [visit] = await scope.insert('visits', {
    location_id: loc.id,
    patient_id: (patient as { id: string }).id,
  });
  return c.json({ visit });
});

app.post('/api/doctor/visits/:id/services', async (c) => {
  const scope = c.get('scope');
  const visitId = c.req.param('id');
  const { serviceId, quantity, teeth } = await c.req.json<{
    serviceId: string; quantity?: number; teeth?: string[] }>();

  const { data: svc, error } = await scope
    .select('services', 'id, price, techcard_version_id')
    .eq('id', serviceId)
    .maybeSingle();
  if (error || !svc) return c.json({ error: 'услуга не найдена' }, 404);

  const qty = Math.max(1, Math.floor(quantity ?? 1));
  // Зубы проверяем здесь же, а не только в БД: пустое поле из формы должно
  // стать отсутствием зуба, а не отказом вставки. Повторы убираем — «26, 26»
  // это одна пломба, а не две.
  const list = [...new Set((teeth ?? []).map((x) => String(x).trim()).filter(Boolean))];
  const bad = list.find((x) => !/^[1-8][1-8]$/.test(x));
  if (bad) return c.json({ error: `«${bad}» — не номер зуба по FDI. Например 26.` }, 400);
  const rows = await scope.insert('visit_services', {
    visit_id: visitId,
    service_id: serviceId,
    quantity: qty,
    teeth: list,
    // Цена фиксируется по факту: прайс мог измениться после оказания.
    price: Number((svc as { price: number }).price) * qty,
    techcard_version_id: (svc as { techcard_version_id: string }).techcard_version_id,
  });
  return c.json({ visitService: rows[0] });
});

/** Единственная точка запуска расхода материалов. Кнопки «списать» не существует. */
app.post('/api/doctor/visits/:id/close', async (c) => {
  try {
    const result = await closeVisit(c.get('scope'), c.req.param('id'));
    return c.json(result);
  } catch (err) {
    const status = (err as { httpStatus?: number }).httpStatus ?? 500;
    return c.json({ error: (err as Error).message }, status as 400 | 409 | 500);
  }
});

/** Раскладка себестоимости до партии, нормы и цены. Недостачи показаны отдельно. */
app.get('/api/doctor/visits/:id/cost-breakdown', async (c) => {
  const scope = c.get('scope');
  const visitId = c.req.param('id');

  const { data, error } = await scope
    .select('stock_movements', 'kind, qty_delta, cost, unpriced, shortfall_state, materials(name_ru), batches(expires_at, total_price, initial_qty, supplier)')
    .eq('visit_id', visitId)
    .in('kind', ['consume', 'shortfall', 'reversal']);
  if (error) return c.json({ error: error.message }, 500);

  const rows = ((data ?? []) as Record<string, unknown>[]).map((m) => ({
    kind: m.kind,
    material: (m.materials as { name_ru?: string } | null)?.name_ru ?? '—',
    qty: Math.abs(Number(m.qty_delta)),
    cost: m.cost === null ? null : Number(m.cost),
    unpriced: m.unpriced,
    shortfallState: m.shortfall_state,
    batchExpiresAt: (m.batches as { expires_at?: string } | null)?.expires_at ?? null,
  }));

  const { data: cost } = await scope
    .select('visit_costs', 'materials_total, has_unpriced, unpriced_lines_count, total')
    .eq('visit_id', visitId)
    .is('superseded_at', null)
    .maybeSingle();

  const sum = rows.filter((r) => r.cost !== null).reduce((s, r) => s + (r.cost as number), 0);
  return c.json({
    lines: rows.sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0)),
    snapshot: cost ?? null,
    // Инвариант драйвера №1 виден прямо в ответе: расхождение обязано быть нулём.
    reconciles: cost ? Math.abs(sum - Number((cost as { materials_total: number }).materials_total)) < 0.005 : null,
  });
});

/**
 * Ключевой экран продукта: сверх материалов по услуге за период.
 *
 * Вся агрегация — в БД. Прошлая версия тянула движения в воркер и складывала
 * в JS; PostgREST молча обрезал выдачу на 1000 строках, и себестоимость
 * оказывалась в семь раз меньше настоящей. Ничего, что может обрезаться,
 * через границу воркера больше не ходит.
 */
app.get('/api/doctor/reports/margin', async (c) => {
  const scope = c.get('scope');
  const tz = { timeZone: 'Asia/Tashkent' } as const;
  const from = c.req.query('from') ?? new Date(Date.now() - 30 * 864e5).toLocaleDateString('en-CA', tz);
  const to = c.req.query('to') ?? new Date().toLocaleDateString('en-CA', tz);

  type MarginRow = {
    service_id: string; name_ru: string; unit_of_norm: string;
    qty: number; revenue: string; cost: string;
    shortfall_cost: string; unpriced_visits: number;
  };

  let raw: MarginRow[];
  try {
    raw = await scope.rpc<MarginRow[]>('margin_by_service', {
      p_tenant_id: scope.tenantId,
      p_from: from,
      p_to: to,
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }

  const rows = (raw ?? []).map((r) => {
    const revenue = Number(r.revenue);
    const cost = Number(r.cost);
    const shortfall = Number(r.shortfall_cost);
    return {
      serviceId: r.service_id,
      name: r.name_ru,
      unit: r.unit_of_norm,
      count: Number(r.qty),
      revenue: Math.round(revenue),
      cost: Math.round(cost),
      margin: Math.round(revenue - cost),
      marginPct: revenue > 0 ? Math.round(((revenue - cost) / revenue) * 100) : 0,
      // Доля себестоимости из недостач: сумма сходится математически, но
      // экономически загрязнена. Врач обязан это видеть, а не догадываться.
      shortfallShare: cost > 0 ? Math.round((shortfall / cost) * 100) : 0,
      hasUnpriced: Number(r.unpriced_visits) > 0,
    };
  });

  const totals = rows.reduce(
    (t, r) => ({ revenue: t.revenue + r.revenue, cost: t.cost + r.cost, margin: t.margin + r.margin }),
    { revenue: 0, cost: 0, margin: 0 },
  );

  return c.json({ from, to, rows, totals });
});

/**
 * Вебхук бота.
 *
 * Нужен ровно для одного: чтобы у пациента появился чат с ботом. Без /start
 * Telegram отвечает «chat not found», и уведомление об отмене приёма молча
 * не доходит — человек приезжает к закрытой двери.
 *
 * Проверка — секретный заголовок Telegram, а не initData: сюда стучится
 * сервер Telegram, а не Mini App.
 */
app.post('/tg/webhook', async (c) => {
  if (c.env.TELEGRAM_WEBHOOK_SECRET
      && c.req.header('X-Telegram-Bot-Api-Secret-Token') !== c.env.TELEGRAM_WEBHOOK_SECRET) {
    return c.json({ ok: false }, 401);
  }

  type Update = {
    message?: {
      chat?: { id: number };
      from?: { id: number; first_name?: string };
      text?: string;
      contact?: { phone_number?: string; user_id?: number; first_name?: string };
      successful_payment?: {
        invoice_payload?: string; total_amount?: number; currency?: string;
        telegram_payment_charge_id?: string;
      };
    };
    pre_checkout_query?: { id?: string };
    callback_query?: {
      id: string;
      from?: { id: number };
      data?: string;
      message?: { chat?: { id: number }; message_id?: number };
    };
  };
  const update: Update = await c.req.json().catch(() => ({}));

  // Telegram ждёт ответа на pre_checkout_query не дольше десяти секунд,
  // иначе платёж отменяется на его стороне. Никаких проверок здесь не
  // делаем — счёт уже выставлен нами, и отказывать поздно.
  if (update.pre_checkout_query?.id) {
    await fetch(`https://api.telegram.org/bot${c.env.TELEGRAM_BOT_TOKEN}/answerPreCheckoutQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pre_checkout_query_id: update.pre_checkout_query.id, ok: true }),
    }).catch(() => {});
    return c.json({ ok: true });
  }

  // ── Нажатие кнопки под напоминанием ───────────────────────────────────
  //
  // Сообщение с кнопкой пересылается в два касания, поэтому право проверяет
  // не бот, а база: подтвердить можно только запись, привязанную к тому же
  // аккаунту Telegram, который нажал. Ответ приходит НЕ сообщением в чат, а
  // всплывающей подсказкой — иначе на каждое нажатие копился бы новый текст.
  if (update.callback_query) {
    const q = update.callback_query;
    const answer = (text: string) =>
      fetch(`https://api.telegram.org/bot${c.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: q.id, text }),
      }).catch(() => {});

    const apptId = (q.data ?? '').startsWith('cfm:') ? q.data!.slice(4) : null;
    if (!apptId || !q.from?.id) {
      await answer('Кнопка устарела.');
      return c.json({ ok: true });
    }

    try {
      const sb = createServiceClient(c.env);
      const { data, error } = await sb.rpc('confirm_appointment', {
        p_subject: `tg:${q.from.id}`, p_appointment_id: apptId,
      });
      if (error) throw new Error(error.message);
      const r = (data ?? {}) as {
        ok?: boolean; already?: boolean; reason?: string;
        serviceName?: string | null; cabinet?: string | null; startsAt?: string;
      };

      if (!r.ok) {
        await answer({
          not_yours: 'Эта запись не ваша.',
          cancelled: 'Эта запись уже отменена.',
          past: 'Этот приём уже прошёл.',
        }[r.reason ?? ''] ?? 'Не получилось. Попробуйте ещё раз.');
        return c.json({ ok: true });
      }

      await answer(r.already ? 'Уже подтверждено — ждём вас.' : 'Спасибо, ждём вас.');

      // Кнопки убираем вместе с текстом: живая «Подтверждаю» над уже
      // подтверждённым приёмом заставляет жать её снова.
      if (q.message?.chat?.id && q.message.message_id) {
        await fetch(`https://api.telegram.org/bot${c.env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: q.message.chat.id,
            message_id: q.message.message_id,
            parse_mode: 'HTML',
            text: confirmedText(r.cabinet ?? '', r.serviceName ?? null, r.startsAt ?? ''),
          }),
        }).catch(() => {});
      }
    } catch {
      await answer('Не получилось. Попробуйте ещё раз.');
    }
    return c.json({ ok: true });
  }

  const msg = update.message;
  const chatId = msg?.chat?.id;
  if (!chatId) return c.json({ ok: true });

  // ── Оплата прошла ─────────────────────────────────────────────────────
  if (msg.successful_payment) {
    const sb = createServiceClient(c.env);
    const res = await creditTelegramPayment(sb, msg.successful_payment, `tg:${msg.from?.id}`);
    const text = res.error
      ? `Платёж получен, но зачесть не удалось: ${res.error}. Напишите нам, разберёмся.`
      : res.credited
        ? `Оплата зачтена. Кабинет работает до ${new Date(res.paidUntil!).toLocaleDateString('ru-RU')}.`
        : 'Этот платёж уже был зачтён ранее.';
    await fetch(`https://api.telegram.org/bot${c.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    }).catch(() => {});
    return c.json({ ok: true });
  }

  const send = (text: string, reply_markup?: unknown) =>
    fetch(`https://api.telegram.org/bot${c.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, ...(reply_markup ? { reply_markup } : {}) }),
    }).catch(() => {});

  const appUrl = miniapp(c.env);

  // ── Человек поделился номером ─────────────────────────────────────────
  //
  // Принимаем ТОЛЬКО собственный контакт: в пересланной визитке user_id чужой
  // либо отсутствует, и без этой проверки любой прислал бы чужой номер и
  // забрал бы чужие карточки.
  if (msg?.contact) {
    const own = msg.contact.user_id && msg.from?.id && msg.contact.user_id === msg.from.id;
    if (!own) {
      await send('Это чужой контакт. Нажмите кнопку «Поделиться номером» — Telegram пришлёт ваш собственный.');
      return c.json({ ok: true });
    }
    try {
      const sb = createServiceClient(c.env);
      const { data, error } = await sb.rpc('set_verified_phone', {
        p_subject: `tg:${msg.from!.id}`,
        p_phone: msg.contact.phone_number ?? '',
      });
      if (error) throw new Error(error.message);
      const linked = Number((data as { linkedCards?: number } | null)?.linkedCards ?? 0);
      await send(
        linked > 0
          ? `Номер подтверждён. Нашли вашу карточку — история приёмов уже в приложении.`
          : 'Номер подтверждён. Теперь можно записаться на приём.',
        { inline_keyboard: [[{ text: 'Записаться', web_app: { url: appUrl } }]], remove_keyboard: true },
      );
    } catch {
      await send('Не удалось сохранить номер. Попробуйте ещё раз.');
    }
    return c.json({ ok: true });
  }

  if (!(msg.text ?? '').startsWith('/start')) return c.json({ ok: true });

  // ── /start ────────────────────────────────────────────────────────────
  // Клавиатуру с запросом номера показываем только тем, у кого его ещё нет:
  // просить второй раз то, что уже дали, — раздражать без причины.
  let hasPhone = false;
  try {
    const sb = createServiceClient(c.env);
    const { data } = await sb.rpc('user_context', { p_subject: `tg:${msg.from?.id}` });
    hasPhone = Boolean((data as { phoneVerified?: boolean } | null)?.phoneVerified);
  } catch { /* нет записи о человеке — значит номера точно нет */ }

  await send(
    hasPhone
      ? 'Здесь можно записаться на приём и получать напоминания. Если приём отменят — сообщение придёт сюда.'
      : 'Здесь можно записаться на приём. Чтобы врач мог с вами связаться, поделитесь номером — Telegram пришлёт его сам, вводить ничего не нужно.',
    hasPhone
      ? { inline_keyboard: [[{ text: 'Записаться', web_app: { url: appUrl } }]] }
      : {
          keyboard: [[{ text: 'Поделиться номером', request_contact: true }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
  );

  return c.json({ ok: true });
});

app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw));

/**
 * Планировщик напоминаний.
 *
 * Cloudflare будит воркер по расписанию; он рассылает то, что подошло по
 * времени, и помечает отправленное. Повторить напоминание невозможно:
 * отметка живёт на самой записи, а не в очереди.
 */
async function runReminders(env: Env): Promise<{ sent: number; skipped: number }> {
  const sb = createServiceClient(env);
  const { data, error } = await sb.rpc('due_reminders', {});
  if (error) throw new Error(`due_reminders: ${error.message}`);

  type Due = {
    appointment_id: string; kind: 'day' | 'hour'; cabinet: string;
    telegram_subject: string; service_name: string | null; starts_at: string;
  };
  let sent = 0, skipped = 0;
  for (const r of (data ?? []) as Due[]) {
    const result = await notifyReminder(
      env.TELEGRAM_BOT_TOKEN, r.telegram_subject, r.cabinet, r.service_name, r.starts_at, r.kind,
      r.appointment_id, miniapp(env),
    );
    // Помечаем и при неудаче: если чата нет, повторять бессмысленно —
    // иначе каждые пятнадцать минут будет новая попытка до самого приёма.
    await sb.rpc('mark_reminded', { p_appointment_id: r.appointment_id, p_kind: r.kind });
    if (result === 'sent') sent += 1; else skipped += 1;
  }
  return { sent, skipped };
}

/**
 * Предупреждения о подписке.
 *
 * Заморозка жёсткая, поэтому предупредить обязаны заранее и несколько раз.
 * Этап запоминается на подписке: без этого cron слал бы одно и то же каждые
 * пятнадцать минут, и врач отключил бы бота вместе с уведомлениями о записях.
 */
async function runSubscriptionNotices(env: Env): Promise<{ sent: number }> {
  const sb = createServiceClient(env);
  const { data, error } = await sb.rpc('due_subscription_notices', {});
  if (error) throw new Error(`due_subscription_notices: ${error.message}`);

  type Due = {
    tenant_id: string; cabinet: string; stage: string;
    days_left: number; paid_until: string; subjects: string[];
  };
  const wording: Record<string, (d: Due) => string> = {
    d7: (d) => `Подписка Stomiko заканчивается через ${d.days_left} дн. `
      + 'Продлите в разделе «Кабинет», чтобы ничего не остановилось.',
    d3: (d) => `Подписка заканчивается через ${d.days_left} дн. `
      + 'После этого кабинет будет заморожен: календарь, склад и отчёты закроются.',
    last_day: () => 'Сегодня последний день подписки. Если не продлить, завтра '
      + 'кабинет будет заморожен, а онлайн-запись у пациентов перестанет открываться.',
    frozen: () => 'Кабинет заморожен. Записи пациентов сохранены и напоминания по ним '
      + 'продолжают уходить — но принимать новые и вести приёмы нельзя, пока не продлить.',
  };

  let sent = 0;
  for (const row of (data ?? []) as Due[]) {
    const text = wording[row.stage]?.(row);
    if (!text) continue;
    for (const subject of row.subjects ?? []) {
      const chatId = subject.startsWith('tg:') ? subject.slice(3) : null;
      if (!chatId) continue;
      const ok = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: `${row.cabinet}\n\n${text}` }),
      }).then((r) => r.ok).catch(() => false);
      if (ok) sent += 1;
    }
    await sb.rpc('mark_subscription_notified', { p_tenant_id: row.tenant_id, p_stage: row.stage });
  }
  return { sent };
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runReminders(env).then(
      (r) => console.log(`напоминания: отправлено ${r.sent}, пропущено ${r.skipped}`),
      (e) => console.error('напоминания:', e),
    ));
    ctx.waitUntil(runSubscriptionNotices(env).then(
      (r) => console.log(`подписки: предупреждений ${r.sent}`),
      (e) => console.error('подписки:', e),
    ));
    // Журнал доступа чистится тем же расписанием: отдельное задание ради
    // одного удаления в сутки — лишняя движущаяся часть. Двухлетний срок
    // задан здесь, потому что это решение владельца, а не свойство кода.
    ctx.waitUntil((async () => {
      const { data, error } = await createServiceClient(env)
        .rpc('prune_access_log', { p_keep_days: 730 });
      if (error) console.error('журнал доступа:', error.message);
      else if (Number(data) > 0) console.log(`журнал доступа: удалено ${data}`);
    })());
  },
};
