import type { TelegramQuickBubble, WasteReport } from '../types';

export type TelegramReportLike = Omit<Partial<WasteReport>, 'urgency' | 'status' | 'severityLevel'> & {
  urgency?: string;
  status?: string;
  severityLevel?: string;
};

export const TELEGRAM_QUICK_BUBBLES: TelegramQuickBubble[] = [
  {
    id: 'active',
    command: '/active',
    labelTl: '📋 Active & Unresolved Concerns',
    labelEn: '📋 Check Active Concerns / Unresolved',
    autoMessageTl: '📋 Check Active Concerns / Unresolved',
    autoMessageEn: '📋 Check Active Concerns / Unresolved',
  },
  {
    id: 'summary',
    command: '/summary',
    labelTl: '📊 Buod at Bilang',
    labelEn: '📊 Show Summary & Counts',
    autoMessageTl: '📊 Ipakita ang Buod at Bilang',
    autoMessageEn: '📊 Show Summary & Counts',
  },
  {
    id: 'help',
    command: '/help',
    labelTl: '❓ Help / Mga Command',
    labelEn: '❓ Help / Bot Commands',
    autoMessageTl: '❓ Help / Mga Command ng Bot',
    autoMessageEn: '❓ Help / Bot Commands',
  },
];

export function escapeTelegramHtml(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function formatTelegramTicket(raw?: string): string {
  const cleaned = String(raw || '')
    .trim()
    .replace(/^#+/, '');
  if (!cleaned) return '';
  return cleaned
    .replace(/^(PULSE|TRASH|DRAW)-CAV-/i, 'TUGON-CAV-')
    .replace(/^TUGON-CAV-/i, 'TUGON-CAV-');
}

export function getTelegramPhTime(): string {
  try {
    return new Intl.DateTimeFormat('en-PH', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }).format(new Date());
  } catch {
    return new Date().toISOString();
  }
}

export function htmlToPlainTelegramText(html: string): string {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<a\s+href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '$2: $1')
    .replace(/<\/?(b|strong|i|em|u|code|pre|a)[^>]*>/gi, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

/**
 * Stateless base64url helpers for packing/unpacking Telegram webhook context
 * into Telegram's X-Telegram-Bot-Api-Secret-Token header ([A-Za-z0-9_-], <= 256 chars)
 * so Cloudflare Workers cold isolates in any datacenter POP can always verify and reply.
 */
function toBase64UrlUtf8(raw: string): string {
  const bytes = new TextEncoder().encode(raw);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64UrlUtf8(encoded: string): string {
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

export function encodeTelegramWebhookSecret(
  token: string,
  chatId?: string,
  piUrl?: string
): string {
  const cleanToken = String(token || '').trim();
  if (!cleanToken) return '';
  const cleanChat = String(chatId || '').trim();
  const cleanPi = String(piUrl || '').trim().replace(/\/+$/, '');
  const barePi = cleanPi.replace(/^https:\/\//i, '');
  try {
    // Compact newline-delimited tg2_ format fits much longer tunnel subdomains within Telegram's 256-char header limit
    if (barePi) {
      const packed2 = `tg2_${toBase64UrlUtf8(`${cleanToken}\n${cleanChat}\n${barePi}`)}`;
      if (packed2.length <= 256) return packed2;
    }
    const packed2NoPi = `tg2_${toBase64UrlUtf8(`${cleanToken}\n${cleanChat}`)}`;
    if (packed2NoPi.length <= 256) return packed2NoPi;

    if (cleanPi) {
      const full = `tg1_${toBase64UrlUtf8(JSON.stringify({ t: cleanToken, c: cleanChat, p: cleanPi }))}`;
      if (full.length <= 256) return full;
      const tight = `tg1_${toBase64UrlUtf8(JSON.stringify({ t: cleanToken, c: cleanChat, p: barePi }))}`;
      if (tight.length <= 256) return tight;
    }
    const compact = `tg1_${toBase64UrlUtf8(JSON.stringify({ t: cleanToken, c: cleanChat }))}`;
    if (compact.length <= 256) return compact;
    const tokenOnly = `tg1_${toBase64UrlUtf8(JSON.stringify({ t: cleanToken }))}`;
    return tokenOnly.length <= 256 ? tokenOnly : '';
  } catch {
    return '';
  }
}

export function decodeTelegramWebhookSecret(secretHeader?: string | null): {
  token: string;
  chatId: string;
  piUrl: string;
} | null {
  const raw = String(secretHeader || '').trim();
  if (raw.startsWith('tg2_')) {
    try {
      const parts = fromBase64UrlUtf8(raw.slice(4)).split('\n');
      const token = String(parts[0] || '').trim();
      const chatId = String(parts[1] || '').trim();
      let decodedPi = String(parts[2] || '').trim();
      if (decodedPi && !/^https?:\/\//i.test(decodedPi)) {
        decodedPi = `https://${decodedPi}`;
      }
      if (token) {
        return { token, chatId, piUrl: decodedPi };
      }
    } catch {}
    return null;
  }
  if (!raw.startsWith('tg1_')) return null;
  try {
    const parsed = JSON.parse(fromBase64UrlUtf8(raw.slice(4)));
    if (parsed && typeof parsed === 'object' && typeof parsed.t === 'string' && parsed.t.trim()) {
      let decodedPi = typeof parsed.p === 'string' ? parsed.p.trim() : '';
      if (decodedPi && !/^https?:\/\//i.test(decodedPi)) {
        decodedPi = `https://${decodedPi}`;
      }
      return {
        token: parsed.t.trim(),
        chatId: typeof parsed.c === 'string' ? parsed.c.trim() : '',
        piUrl: decodedPi,
      };
    }
  } catch {}
  return null;
}

/**
 * Persistent Reply Keyboard bubble buttons for Telegram chat.
 * Tapping any button in Telegram auto-sends that text to the bot immediately.
 */
export function buildTelegramReplyKeyboard(lang: 'tl' | 'en' = 'tl') {
  const isEn = lang === 'en';
  const find = (id: string) =>
    TELEGRAM_QUICK_BUBBLES.find((b) => b.id === id) || TELEGRAM_QUICK_BUBBLES[0];

  const row1 = [
    { text: isEn ? find('active').autoMessageEn : find('active').autoMessageTl },
  ];
  const row2 = [
    { text: isEn ? find('summary').autoMessageEn : find('summary').autoMessageTl },
    { text: isEn ? find('help').autoMessageEn : find('help').autoMessageTl },
  ];

  return {
    keyboard: [row1, row2],
    resize_keyboard: true,
    is_persistent: true,
    one_time_keyboard: false,
  };
}

/**
 * Inline Cloud Bubble buttons for messages without a single report pin (or Group/Supergroup chats
 * where Telegram Privacy Mode blocks plain ReplyKeyboard text unless inline callback_query is used).
 */
export function buildTelegramInlineQuickKeyboard(lang: 'tl' | 'en' = 'tl') {
  const isEn = lang === 'en';
  return {
    inline_keyboard: [
      [
        {
          text: isEn ? '📋 Check Active / Unresolved' : '📋 Active & Unresolved',
          callback_data: `tg_cmd:active:${lang}`,
        },
      ],
      [
        {
          text: isEn ? '📊 Show Summary & Counts' : '📊 Buod at Bilang',
          callback_data: `tg_cmd:summary:${lang}`,
        },
        {
          text: isEn ? '❓ Help / Bot Commands' : '❓ Help / Mga Command',
          callback_data: `tg_cmd:help:${lang}`,
        },
      ],
    ],
  };
}

/**
 * Selects Inline Cloud Bubbles for Group/Supergroup/Channel chats (guaranteed callback_query delivery
 * even with BotFather Group Privacy Mode ON) and Persistent Reply Keyboard bubbles for Private 1-on-1 chats.
 */
export function buildTelegramReplyMarkupForChat(
  lang: 'tl' | 'en' = 'tl',
  chatId?: string | number
) {
  const idStr = String(chatId || '').trim();
  if (idStr.startsWith('-')) {
    return buildTelegramInlineQuickKeyboard(lang);
  }
  return buildTelegramReplyKeyboard(lang);
}

/**
 * Normalizes any incoming cloud bubble payload (inline callback_data, JSON notification bubble payload,
 * persistent reply keyboard button label, or slash command) into a canonical command string & language.
 */
export function detectTelegramLanguage(
  rawText: string,
  fallback: 'tl' | 'en' = 'tl'
): 'tl' | 'en' {
  const txt = String(rawText || '').trim();
  if (!txt) return fallback;
  const lower = txt.toLowerCase();

  // Explicit Tagalog markers take priority so shared words like "Check" or "Help" don't flip Tagalog bubbles to English
  if (
    /\b(mga|ipakita|buod|bilang|tingnan|ulat|kamusta|kumusta|kagawad|basura|hindi pa tapos|lugar|tulong|ilan)\b/i.test(
      lower
    )
  ) {
    return 'tl';
  }
  if (
    lower === '📊 show summary & counts' ||
    lower === '❓ help / bot commands' ||
    /\b(pending only|show summary|bot commands|how many|counts|status of|resolved)\b/i.test(lower)
  ) {
    return 'en';
  }
  return fallback;
}

export function parseTelegramCloudBubblePayload(rawInput: string): {
  normalizedCommand: string;
  displayLabel: string;
  detectedLang?: 'tl' | 'en';
  ticketNumber?: string;
} {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed) {
    return { normalizedCommand: '', displayLabel: '' };
  }

  // Handle JSON cloud bubble payloads sent from webhook/server buttons or bridge
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') {
        const actionRaw = String(
          obj.command || obj.action || obj.bubble || obj.cmd || obj.intent || obj.type || ''
        )
          .trim()
          .toLowerCase();
        const langHint =
          obj.lang === 'en' ? 'en' : obj.lang === 'tl' ? 'tl' : undefined;
        const ticket = obj.ticketNumber ? String(obj.ticketNumber).trim() : undefined;

        if (ticket) {
          return {
            normalizedCommand: ticket,
            displayLabel: `🎫 Ticket ${ticket}`,
            detectedLang: langHint,
            ticketNumber: ticket,
          };
        }
        if (actionRaw.includes('summary') || actionRaw.includes('count') || actionRaw.includes('buod')) {
          return {
            normalizedCommand: '/summary',
            displayLabel: '📊 Show Summary & Counts',
            detectedLang: langHint,
          };
        }
        if (actionRaw.includes('help') || actionRaw.includes('command')) {
          return {
            normalizedCommand: '/help',
            displayLabel: '❓ Help / Bot Commands',
            detectedLang: langHint,
          };
        }
        if (
          actionRaw.includes('active') ||
          actionRaw.includes('unresolved') ||
          actionRaw.includes('pending') ||
          actionRaw.includes('cloud_bubble')
        ) {
          return {
            normalizedCommand: '/active',
            displayLabel: '📋 Check Active Concerns / Unresolved',
            detectedLang: langHint,
          };
        }
        if (obj.text || obj.message) {
          return {
            normalizedCommand: String(obj.text || obj.message).trim(),
            displayLabel: String(obj.text || obj.message).trim(),
            detectedLang: langHint,
          };
        }
      }
    } catch {
      // Fallback to string matching below
    }
  }

  // Strip Telegram group @BotUsername suffix from slash commands (e.g. /active@TugonBrgy40Bot -> /active)
  const strippedSlash = trimmed.startsWith('/')
    ? trimmed.replace(/^(\/[a-zA-Z0-9_]+)@[a-zA-Z0-9_]+/, '$1')
    : trimmed;

  const lower = strippedSlash.toLowerCase();
  const explicitSuffixLang: 'tl' | 'en' | undefined = lower.endsWith(':en')
    ? 'en'
    : lower.endsWith(':tl')
      ? 'tl'
      : undefined;

  if (
    lower.startsWith('tg_cmd:active') ||
    lower.startsWith('cloud_bubble:active') ||
    lower.startsWith('bubble:active')
  ) {
    return {
      normalizedCommand: '/active',
      displayLabel: '📋 Check Active Concerns / Unresolved',
      detectedLang: explicitSuffixLang,
    };
  }
  if (
    lower.startsWith('tg_cmd:summary') ||
    lower.startsWith('cloud_bubble:summary') ||
    lower.startsWith('bubble:summary')
  ) {
    return {
      normalizedCommand: '/summary',
      displayLabel: '📊 Show Summary & Counts',
      detectedLang: explicitSuffixLang,
    };
  }
  if (
    lower.startsWith('tg_cmd:help') ||
    lower.startsWith('cloud_bubble:help') ||
    lower.startsWith('bubble:help')
  ) {
    return {
      normalizedCommand: '/help',
      displayLabel: '❓ Help / Bot Commands',
      detectedLang: explicitSuffixLang,
    };
  }

  const ticketBubbleMatch = lower.match(/^(?:tg_cmd:ticket:|cloud_bubble:ticket:)(.+)$/);
  if (ticketBubbleMatch && ticketBubbleMatch[1]) {
    return {
      normalizedCommand: ticketBubbleMatch[1].trim(),
      displayLabel: `🎫 ${ticketBubbleMatch[1].trim()}`,
      ticketNumber: ticketBubbleMatch[1].trim(),
    };
  }

  return {
    normalizedCommand: strippedSlash,
    displayLabel: trimmed,
  };
}

/**
 * Inline cloud bubble buttons attached directly under Message 1 (New Concern card).
 */
export function buildNewConcernInlineKeyboard(
  report: TelegramReportLike,
  lang: 'tl' | 'en' = 'tl'
) {
  const isEn = lang === 'en';
  const coords = report.coordinates || { lat: 14.47558, lng: 120.89115 };
  const lat = Number.isFinite(Number(coords.lat)) ? Number(coords.lat) : 14.47558;
  const lng = Number.isFinite(Number(coords.lng)) ? Number(coords.lng) : 120.89115;
  const mapsUrl = `https://www.google.com/maps?q=${lat},${lng}`;
  return {
    inline_keyboard: [
      [
        {
          text: isEn ? '🗺 Open Google Maps' : '🗺 Buksan sa Google Maps',
          url: mapsUrl,
        },
        {
          text: isEn ? '📋 Check Active / Unresolved' : '📋 Active & Unresolved',
          callback_data: `tg_cmd:active:${lang}`,
        },
      ],
      [
        {
          text: isEn ? '📊 Show Summary & Counts' : '📊 Buod at Bilang',
          callback_data: `tg_cmd:summary:${lang}`,
        },
        {
          text: isEn ? '❓ Help / Bot Commands' : '❓ Help / Mga Command',
          callback_data: `tg_cmd:help:${lang}`,
        },
      ],
    ],
  };
}

/**
 * Message 1 of 2: Full details for the newly submitted concern.
 */
export function buildNewConcernMessage1Html(
  report: TelegramReportLike,
  lang: 'tl' | 'en' = 'tl',
  phTime = getTelegramPhTime()
): string {
  const isEn = lang === 'en';
  const ticket = formatTelegramTicket(report.ticketNumber) || 'TUGON-CAV-0000';
  const coords = report.coordinates || { lat: 14.47558, lng: 120.89115 };
  const mapsUrl = `https://www.google.com/maps?q=${coords.lat},${coords.lng}`;
  const locationText =
    report.realtimeGpsAddress ||
    [report.houseNumber, report.streetAddress, report.purok || report.barangay, 'Cavite City']
      .filter(Boolean)
      .join(', ');
  const wasteTypesText =
    Array.isArray(report.wasteTypes) && report.wasteTypes.length > 0
      ? report.wasteTypes.join(', ')
      : 'Household Trash';
  const photoCount = Array.isArray(report.photos) ? report.photos.length : 0;
  const priorityBanner = report.isElderly
    ? '🚨 <b>[SENIOR CITIZEN / PWD PRIORITY]</b>\n'
    : report.severityLevel === 'EMERGENCY' || report.severityLevel === 'OVERFLOWING'
      ? isEn
        ? '⚠️ <b>[HIGH URGENCY / OVERFLOWING]</b>\n'
        : '⚠️ <b>[MATAAS NA KALUBHAAN / UMAAPAW]</b>\n'
      : '';

  const landmarkPart = report.landmark ? ` (${escapeTelegramHtml(report.landmark)})` : '';
  const extraLine = report.extraMessage
    ? `\n💬 "${escapeTelegramHtml(String(report.extraMessage).slice(0, 140))}"`
    : '';

  if (isEn) {
    return (
      `🗑 <b>[T.U.G.O.N. NEW CONCERN • ${escapeTelegramHtml(report.barangay || 'Brgy 40 & 41')}]</b>\n` +
      `${priorityBanner}` +
      `🎫 <b>#${escapeTelegramHtml(ticket)}</b> • 🕒 ${escapeTelegramHtml(phTime)}\n` +
      `👤 ${escapeTelegramHtml(report.residentName || 'Concerned Resident')}\n` +
      `📍 ${escapeTelegramHtml(locationText)}${landmarkPart}\n` +
      `🗺 <a href="${mapsUrl}">Open Google Maps</a>\n` +
      `♻️ ${escapeTelegramHtml(wasteTypesText)} • ⚡ ${escapeTelegramHtml(report.severityLevel || 'MODERATE')} (${escapeTelegramHtml(report.estimatedBags || '1-3 bags')}) • 📸 ${photoCount}${extraLine}\n` +
      `📌 Status: ⏳ PENDING`
    );
  }

  return (
    `🗑 <b>[T.U.G.O.N. BAGONG CONCERN • ${escapeTelegramHtml(report.barangay || 'Brgy 40 & 41')}]</b>\n` +
    `${priorityBanner}` +
    `🎫 <b>#${escapeTelegramHtml(ticket)}</b> • 🕒 ${escapeTelegramHtml(phTime)}\n` +
    `👤 ${escapeTelegramHtml(report.residentName || 'Residente')}\n` +
    `📍 ${escapeTelegramHtml(locationText)}${landmarkPart}\n` +
    `🗺 <a href="${mapsUrl}">Buksan sa Google Maps</a>\n` +
    `♻️ ${escapeTelegramHtml(wasteTypesText)} • ⚡ ${escapeTelegramHtml(report.severityLevel || 'MODERATE')} (${escapeTelegramHtml(report.estimatedBags || '1-3 bags')}) • 📸 ${photoCount} litrato${extraLine}\n` +
    `📌 Katayuan: ⏳ PENDING`
  );
}

/**
 * Compact HTML caption (<= 950 chars) for sendPhoto on Message 1.
 */
export function buildNewConcernPhotoCaptionHtml(
  report: TelegramReportLike,
  lang: 'tl' | 'en' = 'tl',
  phTime = getTelegramPhTime()
): string {
  const full = buildNewConcernMessage1Html(report, lang, phTime);
  if (full.length <= 950) return full;
  const ticket = formatTelegramTicket(report.ticketNumber) || 'TUGON-CAV-0000';
  const coords = report.coordinates || { lat: 14.47558, lng: 120.89115 };
  const mapsUrl = `https://www.google.com/maps?q=${coords.lat},${coords.lng}`;
  const loc = (
    report.realtimeGpsAddress ||
    report.streetAddress ||
    report.purok ||
    report.barangay ||
    'Cavite City'
  ).slice(0, 120);
  return (
    `🗑 <b>[T.U.G.O.N. ${lang === 'en' ? 'NEW CONCERN' : 'BAGONG CONCERN'} • ${escapeTelegramHtml(report.barangay || 'Brgy 40 & 41')}]</b>\n` +
    `🎫 <b>#${escapeTelegramHtml(ticket)}</b> • 🕒 ${escapeTelegramHtml(phTime)}\n` +
    `📍 ${escapeTelegramHtml(loc)}\n` +
    `🗺 <a href="${mapsUrl}">Maps</a> • ⚡ ${escapeTelegramHtml(report.severityLevel || 'MODERATE')} • 📸 ${report.photos?.length || 1}\n` +
    `📌 Status: ⏳ PENDING`
  ).slice(0, 950);
}

/**
 * Message 2 of 2: Active & Unresolved Concerns list (PENDING + DISPATCHED).
 */
function unwrapTelegramReportsList(allReports: unknown): TelegramReportLike[] {
  if (Array.isArray(allReports)) return allReports.filter((r): r is TelegramReportLike => Boolean(r && typeof r === 'object'));
  if (allReports && typeof allReports === 'object' && Array.isArray((allReports as any).reports)) {
    return (allReports as any).reports.filter((r: unknown): r is TelegramReportLike => Boolean(r && typeof r === 'object'));
  }
  return [];
}

function normalizeTelegramStatus(rawStatus: unknown): string {
  const s = String(rawStatus || 'PENDING').trim().toUpperCase();
  return s || 'PENDING';
}

export function buildActiveUnresolvedConcernsMessage2Html(
  allReports: TelegramReportLike[],
  lang: 'tl' | 'en' = 'tl',
  filterMode: 'ACTIVE' | 'BRGY40' | 'BRGY41' = 'ACTIVE'
): string {
  const isEn = lang === 'en';
  const active = unwrapTelegramReportsList(allReports).filter((r) => {
    if ((r as any).isPurgedFromFeed) return false;
    const st = normalizeTelegramStatus(r.status);
    return st === 'PENDING' || st === 'DISPATCHED';
  });

  let filtered = active;
  if (filterMode === 'BRGY40') {
    filtered = active.filter(
      (r) => String(r.barangay || r.purok || '').toLowerCase().includes('40')
    );
  } else if (filterMode === 'BRGY41') {
    filtered = active.filter(
      (r) => !String(r.barangay || r.purok || '').toLowerCase().includes('40')
    );
  }

  if (filtered.length === 0) {
    if (filterMode === 'ACTIVE') {
      return isEn
        ? '✨ <b>[ACTIVE &amp; UNRESOLVED CONCERNS: 0]</b>\nAll waste concerns in Barangay 40 &amp; 41 are cleared! 🎉'
        : '✨ <b>[MGA ACTIVE AT HINDI PA TAPOS NA CONCERNS: 0]</b>\nLahat ng concerns sa Barangay 40 &amp; 41 ay malinis at tapos na! 🎉';
    }
    return isEn
      ? `✨ <b>No active concerns in ${filterMode === 'BRGY40' ? 'Barangay 40' : 'Barangay 41'}.</b>\nTotal Active: ${active.length}`
      : `✨ <b>Walang active concern sa ${filterMode === 'BRGY40' ? 'Barangay 40' : 'Barangay 41'}.</b>\nKabuuang Active: ${active.length}`;
  }

  const sortByPriorityAndTime = (arr: TelegramReportLike[]) =>
    [...arr].sort((a, b) => {
      const score = (r: TelegramReportLike) =>
        (r.isElderly ? 100 : 0) +
        (r.severityLevel === 'EMERGENCY' ? 50 : r.severityLevel === 'OVERFLOWING' ? 25 : 0);
      const diff = score(b) - score(a);
      if (diff !== 0) return diff;
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    });

  const seniorSection = sortByPriorityAndTime(filtered.filter((r) => Boolean(r.isElderly)));
  const pendingRegularSection = sortByPriorityAndTime(
    filtered.filter((r) => !r.isElderly && normalizeTelegramStatus(r.status) === 'PENDING')
  );
  const dispatchedRegularSection = sortByPriorityAndTime(
    filtered.filter((r) => !r.isElderly && normalizeTelegramStatus(r.status) === 'DISPATCHED')
  );

  const formatConcernItem = (r: TelegramReportLike, idx: number): string => {
    const ticket = formatTelegramTicket(r.ticketNumber) || `TUGON-CAV-${idx + 1}`;
    const createdMs = new Date(r.createdAt || Date.now()).getTime();
    const minsAgo = Math.max(0, Math.floor((Date.now() - createdMs) / 60000));
    const ageLabel =
      minsAgo < 60
        ? `${minsAgo}m`
        : `${Math.floor(minsAgo / 60)}h`;

    const tags: string[] = [];
    if (r.isElderly) tags.push('🚨 SENIOR/PWD');
    if (r.severityLevel === 'EMERGENCY') tags.push('⚠️ EMERGENCY');
    else if (r.severityLevel === 'OVERFLOWING') tags.push('⚠️ OVERFLOW');
    else if (r.severityLevel) tags.push(`⚡ ${escapeTelegramHtml(r.severityLevel)}`);
    const tagStr = tags.length > 0 ? ` • ${tags.join(' • ')}` : '';

    const statusLabel =
      normalizeTelegramStatus(r.status) === 'DISPATCHED'
        ? isEn
          ? '🚚 DISPATCHED'
          : '🚚 KINOKOLEKTA'
        : '⏳ PENDING';

    const brgyShort =
      String(r.barangay || r.purok || '').toLowerCase().includes('40') ? 'Brgy 40' : 'Brgy 41';
    const addr = r.realtimeGpsAddress || r.streetAddress || r.purok || 'Cavite City';
    const coords = r.coordinates || { lat: 14.47558, lng: 120.89115 };
    const mapUrl = `https://www.google.com/maps?q=${coords.lat},${coords.lng}`;

    return (
      `${idx + 1}. <b>#${escapeTelegramHtml(ticket)}</b>${tagStr}\n` +
      `   ${statusLabel} (${ageLabel}) • ${brgyShort}: ${escapeTelegramHtml(addr.slice(0, 55))} • <a href="${mapUrl}">Maps</a>`
    );
  };

  const MAX_TOTAL_ITEMS = 10;
  const MAX_ITEMS_HTML_BUDGET = 2800;
  let remainingSlots = MAX_TOTAL_ITEMS;
  let usedChars = 0;

  const takeSlice = (arr: TelegramReportLike[]) => {
    const takenFormatted: string[] = [];
    let count = 0;
    for (let i = 0; i < arr.length && remainingSlots > 0; i++) {
      const formatted = formatConcernItem(arr[i], i);
      if (takenFormatted.length > 0 && usedChars + formatted.length + 1 > MAX_ITEMS_HTML_BUDGET) {
        break;
      }
      if (usedChars + formatted.length > MAX_ITEMS_HTML_BUDGET && filtered.length > 1) {
        break;
      }
      takenFormatted.push(formatted);
      usedChars += formatted.length + 1;
      remainingSlots--;
      count++;
    }
    return { takenFormatted, omitted: Math.max(0, arr.length - count) };
  };

  const seniorTake = takeSlice(seniorSection);
  const pendingTake = takeSlice(pendingRegularSection);
  const dispatchedTake = takeSlice(dispatchedRegularSection);
  const totalOmitted = seniorTake.omitted + pendingTake.omitted + dispatchedTake.omitted;

  const headerTitle =
    filterMode === 'BRGY40'
      ? `📍 <b>[BRGY 40 GUMAMELA ACTIVE (${filtered.length})]</b>`
      : filterMode === 'BRGY41'
        ? `📍 <b>[BRGY 41 ROSAL ACTIVE (${filtered.length})]</b>`
        : isEn
          ? `📋 <b>[ACTIVE &amp; UNRESOLVED CONCERNS (${filtered.length} total)]</b>`
          : `📋 <b>[MGA ACTIVE AT HINDI PA TAPOS NA CONCERNS (${filtered.length} kabuuan)]</b>`;

  const sections: string[] = [];
  if (seniorTake.takenFormatted.length > 0) {
    sections.push(`🚨 <b>SENIOR/PWD PRIORITY (${seniorSection.length})</b>\n${seniorTake.takenFormatted.join('\n')}`);
  }
  if (pendingTake.takenFormatted.length > 0) {
    sections.push(
      `⏳ <b>${isEn ? 'PENDING' : 'PENDING'} (${pendingRegularSection.length})</b>\n${pendingTake.takenFormatted.join('\n')}`
    );
  }
  if (dispatchedTake.takenFormatted.length > 0) {
    sections.push(
      `🚚 <b>${isEn ? 'DISPATCHED' : 'KINOKOLEKTA'} (${dispatchedRegularSection.length})</b>\n${dispatchedTake.takenFormatted.join('\n')}`
    );
  }

  const suffix =
    totalOmitted > 0
      ? isEn
        ? `\n<i>+ ${totalOmitted} more in portal</i>`
        : `\n<i>+ ${totalOmitted} pa sa portal</i>`
      : '';

  const totalPending = filtered.filter((r) => normalizeTelegramStatus(r.status) === 'PENDING').length;
  const totalDispatched = filtered.filter((r) => normalizeTelegramStatus(r.status) === 'DISPATCHED').length;
  const statsFooter = isEn
    ? `\n📊 Senior/PWD: <b>${seniorSection.length}</b> • Pending: <b>${totalPending}</b> • Dispatched: <b>${totalDispatched}</b> • Total Active: <b>${filtered.length}</b>`
    : `\n📊 Senior/PWD: <b>${seniorSection.length}</b> • Pending: <b>${totalPending}</b> • Dispatched: <b>${totalDispatched}</b> • Kabuuang Active: <b>${filtered.length}</b>`;

  return `${headerTitle}\n${sections.join('\n\n')}${suffix}${statsFooter}`;
}

export function buildResolvedConcernMessage1Html(
  report: TelegramReportLike,
  lang: 'tl' | 'en' = 'tl',
  phTime = getTelegramPhTime()
): string {
  const isEn = lang === 'en';
  const ticket = formatTelegramTicket(report.ticketNumber) || 'TUGON-CAV-0000';
  const coords = report.coordinates || { lat: 14.47558, lng: 120.89115 };
  const mapsUrl = `https://www.google.com/maps?q=${coords.lat},${coords.lng}`;
  const proofCount = Array.isArray(report.proofPhotos) ? report.proofPhotos.length : 0;
  const loc = (report.realtimeGpsAddress || report.streetAddress || report.purok || 'Cavite City').slice(0, 90);

  if (isEn) {
    return (
      `✅ <b>[T.U.G.O.N. RESOLVED • ${escapeTelegramHtml(report.barangay || 'Brgy 40 & 41')}]</b>\n` +
      `🎫 <b>#${escapeTelegramHtml(ticket)}</b> • 🕒 ${escapeTelegramHtml(phTime)}\n` +
      `📍 ${escapeTelegramHtml(loc)} • <a href="${mapsUrl}">Maps</a>\n` +
      `👮 ${escapeTelegramHtml(report.resolvedBy || 'Barangay Official')} • 📸 ${proofCount} proof photo(s)\n` +
      `📝 ${escapeTelegramHtml(report.resolutionNotes || 'Collected and cleared.')}`
    );
  }

  return (
    `✅ <b>[T.U.G.O.N. TAPOS NA • ${escapeTelegramHtml(report.barangay || 'Brgy 40 & 41')}]</b>\n` +
    `🎫 <b>#${escapeTelegramHtml(ticket)}</b> • 🕒 ${escapeTelegramHtml(phTime)}\n` +
    `📍 ${escapeTelegramHtml(loc)} • <a href="${mapsUrl}">Maps</a>\n` +
    `👮 ${escapeTelegramHtml(report.resolvedBy || 'Barangay Kagawad')} • 📸 ${proofCount} patunay\n` +
    `📝 ${escapeTelegramHtml(report.resolutionNotes || 'Nalinis at nakolekta na.')}`
  );
}

/**
 * Interactive Bot Reply Engine for BOTH Telegram chat and In-App Telegram Bot Chat.
 */
export function generateBotChatReply(
  rawInput: string,
  allReports: TelegramReportLike[],
  lang: 'tl' | 'en' = 'tl'
): {
  textHtml: string;
  textPlain: string;
  matchedIntent: string;
  activeCount: number;
} {
  const parsedBubble = parseTelegramCloudBubblePayload(rawInput);
  const resolvedLang: 'tl' | 'en' =
    parsedBubble.detectedLang || detectTelegramLanguage(parsedBubble.normalizedCommand, lang);
  const isEn = resolvedLang === 'en';
  const input = parsedBubble.normalizedCommand;
  const normalized = input.toLowerCase();
  const list = unwrapTelegramReportsList(allReports);
  const active = list.filter((r) => {
    if ((r as any).isPurgedFromFeed) return false;
    const st = normalizeTelegramStatus(r.status);
    return st === 'PENDING' || st === 'DISPATCHED';
  });
  const pending = active.filter((r) => normalizeTelegramStatus(r.status) === 'PENDING');
  const dispatched = active.filter((r) => normalizeTelegramStatus(r.status) === 'DISPATCHED');
  const resolved = list.filter((r) => normalizeTelegramStatus(r.status) === 'RESOLVED');
  const seniorActive = active.filter(
    (r) => r.isElderly || r.severityLevel === 'EMERGENCY' || r.severityLevel === 'OVERFLOWING'
  );
  const brgy40Active = active.filter((r) =>
    String(r.barangay || r.purok || '').toLowerCase().includes('40')
  );
  const brgy41Active = active.filter(
    (r) => !String(r.barangay || r.purok || '').toLowerCase().includes('40')
  );

  let textHtml = '';
  let matchedIntent = 'GENERAL';

  // 1. Check for specific Ticket Number lookup (#TUGON-CAV-XXXX, PULSE-CAV-XXXX, or 4 digits)
  const fullTicketMatch = input.match(/#?(?:TUGON|PULSE|TRASH|DRAW)-CAV-(\d{2,6})/i);
  const digitsOnlyMatch = !fullTicketMatch ? input.match(/\b(\d{3,5})\b/) : null;
  const searchDigits = fullTicketMatch?.[1] || (normalized.includes('ticket') || normalized.includes('tugon') || /^\d{4}$/.test(normalized) ? digitsOnlyMatch?.[1] : undefined);

  if (searchDigits) {
    const found = list.find((r) => {
      const t = formatTelegramTicket(r.ticketNumber).toUpperCase();
      return t.endsWith(`-${searchDigits}`) || t.includes(searchDigits);
    });
    if (found) {
      matchedIntent = 'TICKET_LOOKUP';
      const ticket = formatTelegramTicket(found.ticketNumber);
      const coords = found.coordinates || { lat: 14.47558, lng: 120.89115 };
      const mapsUrl = `https://www.google.com/maps?q=${coords.lat},${coords.lng}`;
      const st = normalizeTelegramStatus(found.status);
      const statusBadge =
        st === 'RESOLVED'
          ? '✅ RESOLVED'
          : st === 'DISPATCHED'
            ? '🚚 DISPATCHED'
            : st === 'CANCELLED'
              ? '❌ CANCELLED'
              : '⏳ PENDING';
      const pCount =
        Array.isArray(found.photos) && found.photos.length > 0
          ? found.photos.length
          : Number((found as any).photosCount || 0);
      const prCount =
        Array.isArray(found.proofPhotos) && found.proofPhotos.length > 0
          ? found.proofPhotos.length
          : Number((found as any).proofPhotosCount || 0);
      textHtml = isEn
        ? `🎫 <b>[#${escapeTelegramHtml(ticket)}]</b> • <b>${statusBadge}</b>\n` +
          `📍 ${escapeTelegramHtml(found.barangay || 'Brgy 40/41')} — ${escapeTelegramHtml((found.realtimeGpsAddress || found.streetAddress || found.purok || 'Cavite City').slice(0, 80))}\n` +
          `⚡ ${escapeTelegramHtml(found.severityLevel || 'MODERATE')}${found.isElderly ? ' (🚨 Senior/PWD)' : ''} • 📸 ${pCount} / Proof: ${prCount}\n` +
          (found.resolvedBy ? `👮 ${escapeTelegramHtml(found.resolvedBy)} • ` : '') +
          `🗺 <a href="${mapsUrl}">Open Maps</a>`
        : `🎫 <b>[#${escapeTelegramHtml(ticket)}]</b> • <b>${statusBadge}</b>\n` +
          `📍 ${escapeTelegramHtml(found.barangay || 'Brgy 40/41')} — ${escapeTelegramHtml((found.realtimeGpsAddress || found.streetAddress || found.purok || 'Cavite City').slice(0, 80))}\n` +
          `⚡ ${escapeTelegramHtml(found.severityLevel || 'MODERATE')}${found.isElderly ? ' (🚨 Senior/PWD)' : ''} • 📸 ${pCount} / Proeba: ${prCount}\n` +
          (found.resolvedBy ? `👮 ${escapeTelegramHtml(found.resolvedBy)} • ` : '') +
          `🗺 <a href="${mapsUrl}">Buksan sa Maps</a>`;
    } else {
      matchedIntent = 'TICKET_NOT_FOUND';
      textHtml = isEn
        ? `🔍 No report found for <b>#${escapeTelegramHtml(searchDigits)}</b>. Active unresolved: <b>${active.length}</b>.`
        : `🔍 Walang ulat para sa ticket <b>#${escapeTelegramHtml(searchDigits)}</b>. Active unresolved: <b>${active.length}</b>.`;
    }
  } else if (
    normalized.startsWith('/start') ||
    /^(hi|hello|hey|kamusta|kumusta|good\s+(morning|afternoon|evening)|magandang\s+(umaga|hapon|gabi))/i.test(
      normalized
    )
  ) {
    matchedIntent = 'GREETING';
    textHtml = isEn
      ? `👋 <b>T.U.G.O.N. Barangay 40 &amp; 41 Bot</b>\n` +
        `📊 Live: <b>${pending.length}</b> Pending • <b>${dispatched.length}</b> Dispatched • <b>${active.length}</b> Active\n` +
        `Tap a button below or send a ticket (e.g. <code>TUGON-CAV-7766</code>).`
      : `👋 <b>T.U.G.O.N. Barangay 40 &amp; 41 Bot</b>\n` +
        `📊 Live: <b>${pending.length}</b> Pending • <b>${dispatched.length}</b> Kinokolekta • <b>${active.length}</b> Active\n` +
        `Pindutin ang button sa ibaba o mag-type ng ticket (hal. <code>TUGON-CAV-7766</code>).`;
  } else if (
    normalized.includes('tg_cmd:summary') ||
    normalized.startsWith('/summary') ||
    normalized.startsWith('/status') ||
    normalized.includes('summary') ||
    normalized.includes('buod') ||
    normalized.includes('bilang') ||
    normalized.includes('count') ||
    normalized.includes('how many') ||
    normalized.includes('ilan')
  ) {
    matchedIntent = 'SUMMARY';
    const phTime = getTelegramPhTime();
    textHtml = isEn
      ? `📊 <b>[T.U.G.O.N. LIVE SUMMARY • BRGY 40 &amp; 41]</b>\n` +
        `🕒 ${escapeTelegramHtml(phTime)}\n` +
        `• 📋 Active &amp; Unresolved: <b>${active.length}</b> (🚨 Senior/PWD: <b>${seniorActive.length}</b>)\n` +
        `• ⏳ Pending: <b>${pending.length}</b> • 🚚 Dispatched: <b>${dispatched.length}</b>\n` +
        `• 📍 Brgy 40 Active: <b>${brgy40Active.length}</b> • Brgy 41 Active: <b>${brgy41Active.length}</b>\n` +
        `• ✅ Resolved Total: <b>${resolved.length}</b>`
      : `📊 <b>[T.U.G.O.N. LIVE NA BUOD • BRGY 40 &amp; 41]</b>\n` +
        `🕒 ${escapeTelegramHtml(phTime)}\n` +
        `• 📋 Active &amp; Hindi Pa Tapos: <b>${active.length}</b> (🚨 Senior/PWD: <b>${seniorActive.length}</b>)\n` +
        `• ⏳ Pending: <b>${pending.length}</b> • 🚚 Kinokolekta (Dispatched): <b>${dispatched.length}</b>\n` +
        `• 📍 Brgy 40 Active: <b>${brgy40Active.length}</b> • Brgy 41 Active: <b>${brgy41Active.length}</b>\n` +
        `• ✅ Kabuuang Na-resolve: <b>${resolved.length}</b>`;
  } else if (
    normalized.includes('tg_cmd:active') ||
    normalized.startsWith('/active') ||
    normalized.startsWith('/unresolved') ||
    normalized.startsWith('/pending') ||
    normalized.startsWith('/dispatched') ||
    normalized.startsWith('/urgent') ||
    normalized.includes('active') ||
    normalized.includes('unresolved') ||
    normalized.includes('hindi pa tapos') ||
    normalized.includes('pending') ||
    normalized.includes('dispatch') ||
    normalized.includes('kinokolekta') ||
    normalized.includes('senior') ||
    normalized.includes('urgent') ||
    normalized.includes('concern') ||
    normalized.includes('ulat') ||
    normalized.includes('check') ||
    normalized.includes('list') ||
    normalized.includes('tingnan')
  ) {
    matchedIntent = 'ACTIVE_UNRESOLVED';
    textHtml = buildActiveUnresolvedConcernsMessage2Html(list, resolvedLang, 'ACTIVE');
  } else if (
    normalized.includes('tg_cmd:help') ||
    normalized.startsWith('/help') ||
    normalized.includes('help') ||
    normalized.includes('tulong') ||
    normalized.includes('command') ||
    normalized.includes('menu')
  ) {
    matchedIntent = 'HELP';
    textHtml = isEn
      ? `❓ <b>[T.U.G.O.N. BOT COMMANDS]</b>\n` +
        `• <code>/active</code> — Active &amp; unresolved concerns\n` +
        `• <code>/summary</code> — Live Brgy 40 &amp; 41 counts\n` +
        `• Ticket lookup: <code>TUGON-CAV-7766</code>, <i>"Brgy 40"</i>, <i>"Brgy 41"</i>`
      : `❓ <b>[MGA COMMAND NG T.U.G.O.N. BOT]</b>\n` +
        `• <code>/active</code> — Mga active &amp; hindi pa tapos na concerns\n` +
        `• <code>/summary</code> — Live na bilang sa Brgy 40 at 41\n` +
        `• Ticket lookup: <code>TUGON-CAV-7766</code>, <i>"Brgy 40"</i>, <i>"Brgy 41"</i>`;
  } else if (
    normalized.includes('40') ||
    normalized.includes('gumamela')
  ) {
    matchedIntent = 'BRGY_40';
    textHtml = buildActiveUnresolvedConcernsMessage2Html(list, resolvedLang, 'BRGY40');
  } else if (
    normalized.includes('41') ||
    normalized.includes('rosal')
  ) {
    matchedIntent = 'BRGY_41';
    textHtml = buildActiveUnresolvedConcernsMessage2Html(list, resolvedLang, 'BRGY41');
  } else {
    matchedIntent = 'CHAT_FALLBACK';
    textHtml = isEn
      ? `🤖 Active Unresolved: <b>${active.length}</b> (🚨 ${seniorActive.length} Senior/PWD • ⏳ ${pending.length} Pending • 🚚 ${dispatched.length} Dispatched).\n` +
        `Tap <b>Check Active Concerns / Unresolved</b> or type a ticket (e.g. <code>TUGON-CAV-7766</code>).`
      : `🤖 Active Unresolved: <b>${active.length}</b> (🚨 ${seniorActive.length} Senior/PWD • ⏳ ${pending.length} Pending • 🚚 ${dispatched.length} Dispatched).\n` +
        `Pindutin ang <b>Check Active Concerns / Unresolved</b> o mag-type ng ticket (hal. <code>TUGON-CAV-7766</code>).`;
  }

  return {
    textHtml,
    textPlain: htmlToPlainTelegramText(textHtml),
    matchedIntent,
    activeCount: active.length,
  };
}
