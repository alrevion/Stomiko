import { Hono } from 'hono';
import type { Env, Identity, TenantScope } from '../db.js';
import { notifyBooked, notifyStaffBooked, notifyStaffCancelled } from '../notify.js';

type Vars = { scope: TenantScope; identity: Identity };
export const patient = new Hono<{ Bindings: Env; Variables: Vars }>();

const TZ = 'Asia/Tashkent';

/**
 * Приложение пациента.
 *
 * Отраслевая практика записи: минимум шагов, сначала информация — потом форма,
 * и только имя с телефоном. Анкеты, история болезни и согласия досылаются
 * после: каждое лишнее поле на этом шаге стоит записей.
 *
 * Пациент не видит ни себестоимости, ни склада, ни чужих записей — маршруты
 * разделены на уровне приложения, а не спрятаны в интерфейсе.
 */

async function chairId(scope: TenantScope): Promise<string> {
  const { data } = await scope.select('resources', 'id').eq('kind', 'chair').limit(1);
  const row = (data ?? [])[0];
  if (!row) throw new Error('в кабинете не заведено кресло');
  return String(row.id);
}

/** Что показать до формы: кабинет, услуги, цены и длительность. */
patient.get('/info', async (c) => {
  const scope = c.get('scope');
  const identity = c.get('identity');

  const [services, doctors] = await Promise.all([
    scope.select('services', 'id, code, name_ru, name_uz, price, duration_minutes, unit_of_norm')
      .eq('bookable', true).order('price'),
    scope.select('resources', 'name').eq('kind', 'practitioner').limit(1),
  ]);

  // Приём врача идёт первым, остальное — по цене.
  //
  // Пациент не знает, нужна ему обработка канала или пломба II/III класса:
  // это решает врач на осмотре. Прайс процедур первым экраном заставляет
  // человека ставить себе диагноз, и он либо ошибается, либо уходит.
  // В номенклатуре 804н приёмы врача — это коды группы B01.
  const isConsult = (code: unknown) => String(code ?? '').startsWith('B01.');
  const rows = [...(services.data ?? [])].sort((a, b) =>
    (isConsult(b.code) ? 1 : 0) - (isConsult(a.code) ? 1 : 0) || Number(a.price) - Number(b.price));

  return c.json({
    cabinet: identity.tenantName,
    phone: identity.phone,
    needsPhone: !identity.phone,
    // «Врач» — это не имя, а заглушка из справочника ресурсов: показывать её
    // пациенту незачем.
    doctor: ['Врач', 'Доктор', ''].includes(String((doctors.data ?? [])[0]?.name ?? ''))
      ? null : (doctors.data ?? [])[0]?.name,
    services: rows.map((s) => ({
      id: s.id,
      name: s.name_ru,
      price: Number(s.price),
      durationMinutes: s.duration_minutes,
      unit: s.unit_of_norm,
      consultation: isConsult(s.code),
    })),
  });
});

/**
 * Свободные слоты. Считаются на лету из правил врача — пациент обязан
 * получить именно тот слот, который увидел, а не снимок часовой давности.
 */
patient.get('/slots', async (c) => {
  const scope = c.get('scope');
  const serviceId = c.req.query('serviceId');
  if (!serviceId) return c.json({ error: 'не указана услуга' }, 400);

  const from = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const days = Math.min(Number(c.req.query('days') ?? 21), 60);
  const to = new Date(Date.now() + days * 864e5).toLocaleDateString('en-CA', { timeZone: TZ });

  type Slot = { slot_start: string; slot_end: string; slot_date: string };
  const slots = await scope.rpc<Slot[]>('available_slots', {
    p_tenant_id: scope.tenantId,
    p_resource_id: await chairId(scope),
    p_service_id: serviceId,
    p_from: from,
    p_to: to,
  });

  // Группировка по дням: пациент выбирает сначала день, потом время.
  // Плоский список из двухсот слотов не читается с телефона.
  const byDate = new Map<string, string[]>();
  for (const s of slots ?? []) {
    const times = byDate.get(s.slot_date) ?? [];
    times.push(s.slot_start);
    byDate.set(s.slot_date, times);
  }

  return c.json({
    days: [...byDate.entries()].map(([date, times]) => ({
      date,
      weekday: new Date(`${date}T12:00:00+05:00`).toLocaleDateString('ru-RU', { weekday: 'short', timeZone: TZ }),
      label: new Date(`${date}T12:00:00+05:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: TZ }),
      times,
    })),
  });
});

// Путь — корень модуля: он уже примонтирован на /api/book.
// Было post('/book'), что давало /api/book/book и молчаливый 404.
patient.post('/', async (c) => {
  const scope = c.get('scope');
  const identity = c.get('identity');
  const b = await c.req.json<{ serviceId: string; startsAt: string; name: string; phone: string; note?: string }>();

  if (!b.serviceId || !b.startsAt) return c.json({ error: 'не выбрана услуга или время' }, 400);
  if (!b.name?.trim()) return c.json({ error: 'укажите имя' }, 400);

  // Номер берётся ТОЛЬКО подтверждённый — тот, что прислал сам Telegram.
  // Из тела запроса он больше не читается: введённый руками нельзя проверить,
  // он двоит карточки опечатками и не даёт врачу дозвониться.
  const phone = identity.phone;
  if (!phone) {
    return c.json({ error: 'подтвердите номер телефона', needsPhone: true }, 428);
  }

  try {
    const res = await scope.rpc<{ appointmentId: string; patientId: string; startsAt: string; endsAt: string }>(
      'book_appointment',
      {
        p_tenant_id: scope.tenantId,
        p_resource_id: await chairId(scope),
        p_service_id: b.serviceId,
        p_starts_at: b.startsAt,
        p_patient_name: b.name.trim(),
        p_phone: phone,
        p_note: b.note ?? null,
        p_source: 'patient_link',
        p_subject: identity.subject,
      },
    );
    // Подтверждение в переписку: время не должно жить только в памяти пациента.
    const { data: svc } = await scope.select('services', 'name_ru').eq('id', b.serviceId).maybeSingle();
    const delivery = await notifyBooked(
      c.env.TELEGRAM_BOT_TOKEN, identity.subject, identity.tenantName,
      String(svc?.name_ru ?? 'Приём'), res.startsAt,
    );
    // Если чат с ботом не начат, пациент не получит и уведомление об отмене.
    // Он должен узнать об этом сразу, а не в день несостоявшегося приёма.
    // Врач узнаёт о записи сразу, а не когда откроет приложение: иначе
    // онлайн-запись бесполезна — пациент записался, врач не в курсе.
    const staff = await scope.rpc<{ subject: string }[]>('tenant_staff', { p_tenant_id: scope.tenantId });
    await notifyStaffBooked(c.env.TELEGRAM_BOT_TOKEN, (staff ?? []).map((x) => x.subject), {
      patientName: b.name.trim(),
      patientPhone: phone,
      serviceName: String(svc?.name_ru ?? ''),
      startsAt: res.startsAt,
      note: b.note ?? null,
    });

    return c.json({ ...res, notificationsEnabled: delivery === 'sent' });
  } catch (err) {
    const msg = (err as Error).message;
    // Слот мог уйти между показом и нажатием — это нормальная гонка,
    // и пациенту надо сказать правду, а не «ошибка сервера».
    if (msg.includes('занят')) return c.json({ error: 'Это время только что заняли. Выберите другое.' }, 409);
    return c.json({ error: msg }, 400);
  }
});

/** Мои записи: чтобы пациент видел, когда ему прийти, и мог отменить. */
patient.get('/my', async (c) => {
  const scope = c.get('scope');
  const identity = c.get('identity');

  const { data: me } = await scope.select('patients', 'id, full_name, phone')
    .eq('telegram_subject', identity.subject).maybeSingle();
  if (!me) return c.json({ appointments: [] });

  const { data } = await scope
    .select('appointments', 'id, starts_at, ends_at, status, note, services(name_ru, price)')
    .eq('patient_id', me.id)
    .order('starts_at', { ascending: false });

  return c.json({
    patient: { name: me.full_name, phone: me.phone },
    appointments: (data ?? []).map((a) => ({
      id: a.id,
      startsAt: a.starts_at,
      endsAt: a.ends_at,
      status: a.status,
      service: (a.services as { name_ru?: string } | null)?.name_ru ?? '—',
      price: (a.services as { price?: number } | null)?.price ?? null,
      past: new Date(String(a.starts_at)).getTime() < Date.now(),
    })),
  });
});

patient.post('/my/:id/cancel', async (c) => {
  const scope = c.get('scope');
  const identity = c.get('identity');

  // Отменить можно только свою запись: id приёма угадать несложно.
  const { data: me } = await scope.select('patients', 'id')
    .eq('telegram_subject', identity.subject).maybeSingle();
  if (!me) return c.json({ error: 'записи не найдены' }, 404);

  const { data: appt } = await scope.select('appointments', 'id, patient_id')
    .eq('id', c.req.param('id')).maybeSingle();
  if (!appt || String(appt.patient_id) !== String(me.id)) {
    return c.json({ error: 'запись не найдена' }, 404);
  }

  try {
    const notice = await scope.rpc<Record<string, any>>('cancel_appointment', {
      p_appointment_id: appt.id, p_by: 'пациент', p_reason: null,
    });
    const staff = await scope.rpc<{ subject: string }[]>('tenant_staff', { p_tenant_id: scope.tenantId });
    await notifyStaffCancelled(c.env.TELEGRAM_BOT_TOKEN, (staff ?? []).map((x) => x.subject), {
      patientName: String(notice.patientName ?? ''),
      patientPhone: notice.patientPhone ?? null,
      serviceName: notice.serviceName ?? null,
      startsAt: String(notice.startsAt ?? ''),
    });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});
