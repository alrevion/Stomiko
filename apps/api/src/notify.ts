/**
 * Уведомления пациенту через бота.
 *
 * Отменённый приём, о котором пациент не узнал, — это не «мелкая недоработка»,
 * а человек, приехавший к закрытой двери. Поэтому отмена врачом обязана
 * сопровождаться сообщением и причиной.
 *
 * Написать можно только тем, кто записывался через Telegram: у них есть чат
 * с ботом. Остальным приложение обязано честно сказать «позвоните», а не делать
 * вид, что уведомление ушло.
 */

const TZ = 'Asia/Tashkent';

/** `tg:123456` → `123456`. Для личного чата id пользователя и есть id чата. */
export function chatIdFromSubject(subject: string | null | undefined): string | null {
  if (!subject || !subject.startsWith('tg:')) return null;
  const id = subject.slice(3);
  return /^\d+$/.test(id) ? id : null;
}

export function formatWhen(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', weekday: 'long', timeZone: TZ });
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
  return `${date}, ${time}`;
}

export type SendResult = 'sent' | 'no_chat' | 'blocked' | 'failed';

/**
 * Бот НЕ может написать первым тому, кто ни разу не начинал с ним чат:
 * Telegram отвечает «chat not found». Открытие Mini App по ссылке чат не
 * создаёт — нужен /start. Поэтому причину неудачи надо различать: одно дело
 * «пациент заблокировал бота», другое — «он просто не нажимал Start».
 */
async function send(botToken: string, chatId: string, text: string, keyboard?: unknown): Promise<SendResult> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId, text, parse_mode: 'HTML',
        ...(keyboard ? { reply_markup: keyboard } : {}),
      }),
    });
    const json = (await res.json()) as { ok?: boolean; description?: string };
    if (json.ok) return 'sent';
    const d = (json.description ?? '').toLowerCase();
    if (d.includes('chat not found')) return 'no_chat';
    if (d.includes('blocked') || d.includes('deactivated')) return 'blocked';
    return 'failed';
  } catch {
    // Сбой отправки не роняет отмену: запись уже отменена, слот свободен.
    return 'failed';
  }
}

export interface CancelNotice {
  telegramSubject: string | null;
  patientName: string;
  patientPhone: string | null;
  serviceName: string | null;
  startsAt: string;
  reason: string | null;
  cancelledBy: string;
}

/** Возвращает, дошло ли сообщение и почему нет. Врач обязан это видеть. */
export async function notifyCancelled(botToken: string, n: CancelNotice, cabinet: string): Promise<SendResult> {
  const chatId = chatIdFromSubject(n.telegramSubject);
  if (!chatId) return 'no_chat';

  const text = [
    '<b>Приём отменён</b>',
    '',
    `${n.serviceName ? `${escapeHtml(n.serviceName)}\n` : ''}${formatWhen(n.startsAt)}`,
    '',
    n.reason ? `Причина: ${escapeHtml(n.reason)}` : '',
    '',
    `${escapeHtml(cabinet)}. Откройте бота, чтобы выбрать другое время.`,
  ].filter(Boolean).join('\n');

  return send(botToken, chatId, text);
}

/** Подтверждение записи: пациент должен получить время в переписке, а не запомнить. */
export async function notifyBooked(
  botToken: string,
  subject: string,
  cabinet: string,
  serviceName: string,
  startsAt: string,
): Promise<SendResult> {
  const chatId = chatIdFromSubject(subject);
  if (!chatId) return 'no_chat';
  const text = [
    '<b>Вы записаны</b>',
    '',
    escapeHtml(serviceName),
    formatWhen(startsAt),
    '',
    escapeHtml(cabinet),
  ].join('\n');
  return send(botToken, chatId, text);
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));
}


/**
 * План лечения готов — пациенту стоит его увидеть.
 *
 * План, который врач составил и никому не показал, не работает ни как
 * обещание, ни как инструмент продаж. Сообщение уходит один раз, когда план
 * впервые становится видимым, а не при каждом сохранении.
 */
export async function notifyPlanReady(
  botToken: string, subject: string | null, cabinet: string, title: string,
  total: number, appUrl: string,
): Promise<SendResult> {
  const chatId = chatIdFromSubject(subject);
  if (!chatId) return 'no_chat';
  const text = [
    '<b>Врач составил план лечения</b>', '',
    escapeHtml(title),
    `Всего: ${new Intl.NumberFormat('ru-RU').format(Math.round(total))} сум`, '',
    escapeHtml(cabinet), '',
    'Откройте, чтобы посмотреть этапы и сроки.',
  ].join('\n');
  return send(botToken, chatId, text, {
    inline_keyboard: [[{ text: 'Посмотреть план', web_app: { url: `${appUrl}?plan=1` } }]],
  });
}

/* ── Уведомления врачу ────────────────────────────────────────────────── */

export interface StaffNotice {
  patientName: string;
  patientPhone: string | null;
  serviceName: string | null;
  startsAt: string;
  note?: string | null;
}

/**
 * Врач узнаёт о новой записи сразу, а не когда откроет приложение.
 * Иначе онлайн-запись бесполезна: пациент записался, врач не знает.
 */
export async function notifyStaffBooked(
  botToken: string, subjects: string[], n: StaffNotice,
  appUrl?: string, appointmentId?: string,
): Promise<number> {
  const text = [
    '<b>Новая запись</b>',
    '',
    escapeHtml(n.patientName) + (n.patientPhone ? ` · ${escapeHtml(n.patientPhone)}` : ''),
    n.serviceName ? escapeHtml(n.serviceName) : '',
    formatWhen(n.startsAt),
    n.note ? `\nПовод: ${escapeHtml(n.note)}` : '',
  ].filter(Boolean).join('\n');
  // Кнопка ведёт прямо к записи. Без неё врач узнавал о пациенте и дальше
  // искал его сам: открыть приложение, найти день, найти время — четыре
  // касания на то, что уже названо в сообщении.
  const keyboard = appUrl && appointmentId
    ? { inline_keyboard: [[{ text: 'Открыть', web_app: { url: `${appUrl}?appt=${appointmentId}` } }]] }
    : undefined;
  return broadcast(botToken, subjects, text, keyboard);
}

/** Пациент отменил сам — врач должен узнать, чтобы занять окно. */
export async function notifyStaffCancelled(
  botToken: string, subjects: string[], n: StaffNotice,
): Promise<number> {
  const text = [
    '<b>Пациент отменил запись</b>',
    '',
    escapeHtml(n.patientName) + (n.patientPhone ? ` · ${escapeHtml(n.patientPhone)}` : ''),
    n.serviceName ? escapeHtml(n.serviceName) : '',
    formatWhen(n.startsAt),
    '',
    'Окно освободилось.',
  ].filter(Boolean).join('\n');
  return broadcast(botToken, subjects, text);
}

/**
 * Напоминание пациенту.
 *
 * У напоминания за сутки есть две кнопки. Без них рассылка односторонняя:
 * врач всё равно не знает, придёт человек или нет, и обзванивает всех.
 * С ними звонить нужно только тем, кто промолчал.
 *
 * За два часа кнопок нет намеренно: подтверждать поздно — врач уже ничего
 * не успеет сделать с окном, а переносить некуда, запись ближе минимального
 * запаса система всё равно не предложит.
 */
export async function notifyReminder(
  botToken: string, subject: string, cabinet: string,
  serviceName: string | null, startsAt: string, kind: 'day' | 'hour',
  appointmentId?: string, appUrl?: string,
): Promise<SendResult> {
  const chatId = chatIdFromSubject(subject);
  if (!chatId) return 'no_chat';
  const withButtons = kind === 'day' && !!appointmentId && !!appUrl;
  const head = kind === 'day' ? '<b>Напоминание: приём завтра</b>' : '<b>Приём через два часа</b>';
  const text = [
    head, '',
    serviceName ? escapeHtml(serviceName) : '',
    formatWhen(startsAt), '',
    escapeHtml(cabinet),
    withButtons ? '\nПридёте? Ответьте кнопкой ниже — врачу важно знать заранее.'
      : kind === 'day' ? '\nЕсли планы изменились — отмените запись в приложении, чтобы освободить время.' : '',
  ].filter(Boolean).join('\n');

  return send(botToken, chatId, text, withButtons ? {
    inline_keyboard: [[
      { text: 'Подтверждаю', callback_data: `cfm:${appointmentId}` },
      // Кнопка Mini App, а не команда боту: перенос — это выбор времени из
      // сетки, а не разговор в чате.
      { text: 'Перенести', web_app: { url: `${appUrl}?resched=${appointmentId}` } },
    ]],
  } : undefined);
}

/**
 * Чем заменить напоминание после нажатия.
 *
 * Кнопки убираются вместе с текстом: сообщение с живой кнопкой «Подтверждаю»
 * над уже подтверждённым приёмом заставляет жать её снова и снова.
 */
export function confirmedText(cabinet: string, serviceName: string | null, startsAt: string): string {
  return [
    '<b>Приём подтверждён</b>', '',
    serviceName ? escapeHtml(serviceName) : '',
    formatWhen(startsAt), '',
    escapeHtml(cabinet), '',
    'Ждём вас. Если планы изменятся — перенесите или отмените в приложении.',
  ].filter(Boolean).join('\n');
}

/** Пациент перенёс сам — врач должен увидеть оба времени, а не одно новое. */
export async function notifyStaffRescheduled(
  botToken: string, subjects: string[], n: StaffNotice & { wasAt: string },
): Promise<number> {
  const text = [
    '<b>Пациент перенёс запись</b>', '',
    escapeHtml(n.patientName) + (n.patientPhone ? ` \u00b7 ${escapeHtml(n.patientPhone)}` : ''),
    n.serviceName ? escapeHtml(n.serviceName) : '',
    '',
    `Было: ${formatWhen(n.wasAt)}`,
    `Стало: ${formatWhen(n.startsAt)}`,
    '',
    'Прежнее окно освободилось.',
  ].filter(Boolean).join('\n');
  return broadcast(botToken, subjects, text);
}

async function broadcast(
  botToken: string, subjects: string[], text: string, keyboard?: unknown,
): Promise<number> {
  let delivered = 0;
  for (const subject of subjects) {
    const chatId = chatIdFromSubject(subject);
    if (!chatId) continue;
    if (await send(botToken, chatId, text, keyboard) === 'sent') delivered += 1;
  }
  return delivered;
}
