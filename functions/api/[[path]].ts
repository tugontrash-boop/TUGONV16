/**
 * Cloudflare Pages Functions Edge Bridge (/functions/api/[[path]].ts)
 *
 * Automatically deployed on Cloudflare Pages (and mirrored by /cloudflare-worker.js on Cloudflare Workers).
 * Bridges /api/* requests server-to-server from Cloudflare's edge directly to ANY valid
 * Raspberry Pi Cloud Server link (ngrok-free.dev, ngrok.dev, ngrok-free.app, trycloudflare.com,
 * Tailscale Funnel, custom HTTPS domain, or VPS), bypassing browser CORS & ngrok interstitial pages
 * while strictly rejecting offline, unreachable, or invalid URLs.
 */

import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai/web';
import {
  verifyTugonCredentials,
  isAuthorizedAdminPassword,
} from '../../src/utils/authConfig.ts';
import {
  resolveLockedCloudServerState,
  isUrlAllowedUnderLock,
} from '../../src/utils/cloudServerConfig.ts';
import {
  buildTelegramReplyKeyboard,
  buildTelegramReplyMarkupForChat,
  buildNewConcernInlineKeyboard,
  buildNewConcernMessage1Html,
  buildNewConcernPhotoCaptionHtml,
  buildActiveUnresolvedConcernsMessage2Html,
  buildResolvedConcernMessage1Html,
  detectTelegramLanguage,
  encodeTelegramWebhookSecret,
  decodeTelegramWebhookSecret,
  generateBotChatReply,
  htmlToPlainTelegramText,
  parseTelegramCloudBubblePayload,
} from '../../src/utils/telegramBotEngine.ts';
import {
  AUTO_PURGE_TTL_DAYS,
  computeUnifiedPurgeInfo,
} from '../../src/utils/purgeConfig.ts';
import {
  buildSupportModerationInstruction,
  buildTugonAiSystemInstruction,
  computeTugonAiLiveSummary,
  type ResidentDeviceReportContext,
} from '../../src/utils/tugonAiPrompt.ts';

export interface EdgeEnv {
  GEMINI_API_KEY?: string;
  GOOGLE_GEMINI_API_KEY?: string;
  GOOGLE_API_KEY?: string;
  GEMINI_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_KEY?: string;
  GROQ_API_KEY?: string;
  GROQ_KEY?: string;
  VITE_GEMINI_API_KEY?: string;
  VITE_API_KEY?: string;
  API_KEY?: string;
  PI_SERVER_URL?: string;
  VITE_PI_SERVER_URL?: string;
  PI_SERVER_LOCKED?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  ASSETS?: { fetch: (req: Request) => Promise<Response> };
}

export interface PagesContext {
  request: Request;
  env: EdgeEnv;
}

function cleanEdgeGeminiKeyValue(raw: unknown): string {
  if (typeof raw !== "string" && typeof raw !== "number") return "";
  let cleaned = String(raw || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
  if (/^[A-Z0-9_]*KEY\s*=\s*/i.test(cleaned)) {
    cleaned = cleaned.replace(/^[A-Z0-9_]*KEY\s*=\s*/i, "").trim().replace(/^["']|["']$/g, "").trim();
  }
  return cleaned;
}

function classifyEdgeKeyProvider(
  keyVal: string,
  declaredHint: 'gemini' | 'openrouter' | 'groq'
): 'gemini' | 'openrouter' | 'groq' {
  if (/^sk-or-/i.test(keyVal)) return 'openrouter';
  if (/^gsk_/i.test(keyVal)) return 'groq';
  if (/^AIza/i.test(keyVal)) return 'gemini';
  return declaredHint;
}

function resolveEdgeAiProviderKeys(env?: EdgeEnv | Record<string, unknown>): {
  geminiKey: string;
  openRouterKey: string;
  groqKey: string;
  detectedKeyNames: string[];
} {
  const geminiPreferred = [
    "GEMINI_API_KEY",
    "GOOGLE_GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GENAI_API_KEY",
    "GOOGLE_AI_API_KEY",
    "GOOGLE_AI_STUDIO_API_KEY",
    "GEMINI_KEY",
    "API_KEY",
    "VITE_GEMINI_API_KEY",
    "VITE_API_KEY",
  ];
  const openRouterPreferred = ["OPENROUTER_API_KEY", "OPENROUTER_KEY"];
  const groqPreferred = ["GROQ_API_KEY", "GROQ_KEY"];

  const pEnv = (globalThis as any)?.process?.env || {};
  const sources: Record<string, unknown>[] = [];
  if (env && typeof env === "object") sources.push(env as Record<string, unknown>);
  if (pEnv && typeof pEnv === "object") sources.push(pEnv as Record<string, unknown>);

  let geminiKey = "";
  let openRouterKey = "";
  let groqKey = "";

  const assignKey = (val: string, declaredHint: "gemini" | "openrouter" | "groq") => {
    if (!val) return;
    const actual = classifyEdgeKeyProvider(val, declaredHint);
    if (actual === "gemini" && !geminiKey) geminiKey = val;
    else if (actual === "openrouter" && !openRouterKey) openRouterKey = val;
    else if (actual === "groq" && !groqKey) groqKey = val;
  };

  const detectedSet = new Set<string>();
  for (const obj of sources) {
    for (const k of Object.keys(obj)) {
      if (/gemini|google|genai|openrouter|groq|api_key/i.test(k)) detectedSet.add(k);
    }
  }

  for (const name of geminiPreferred) {
    for (const obj of sources) assignKey(cleanEdgeGeminiKeyValue(obj[name]), "gemini");
  }
  for (const name of openRouterPreferred) {
    for (const obj of sources) assignKey(cleanEdgeGeminiKeyValue(obj[name]), "openrouter");
  }
  for (const name of groqPreferred) {
    for (const obj of sources) assignKey(cleanEdgeGeminiKeyValue(obj[name]), "groq");
  }

  const upperPreferred = new Set(geminiPreferred);
  for (const obj of sources) {
    for (const [k, v] of Object.entries(obj)) {
      const up = String(k || "").trim().toUpperCase();
      const cleaned = cleanEdgeGeminiKeyValue(v);
      if (!cleaned) continue;
      if (upperPreferred.has(up) || (up.includes("GEMINI") && !up.includes("MODEL"))) {
        assignKey(cleaned, "gemini");
      } else if (up.includes("OPENROUTER")) {
        assignKey(cleaned, "openrouter");
      } else if (up.includes("GROQ")) {
        assignKey(cleaned, "groq");
      }
    }
  }

  return { geminiKey, openRouterKey, groqKey, detectedKeyNames: Array.from(detectedSet) };
}

interface PersistedEdgeConfig {
  piServerUrl?: string;
  piServerLocked?: boolean;
  telegramBotToken?: string;
  telegramChatId?: string;
  telegramSetupComplete?: boolean;
  telegramLocked?: boolean;
  telegramWebhookUrl?: string;
  telegramWebhookSecretTag?: string;
  kagawadCustomPassword?: string;
  lastBroadcastMessage?: string;
  lastBroadcastTime?: string;
  broadcastHistory?: string[];
  telegramUpdateOffset?: number;
  telegramChatHistory?: any[];
  knownTelegramChats?: { id: string; title: string; type: string }[];
  deletedReportIds?: string[];
  portalRevision?: number;
}

let memoryConfig: PersistedEdgeConfig = {};
let memoryReports: any[] = [];
let memoryLogbooks: any[] = [];
let memorySupportChats: any[] = [];

const EDGE_CONFIG_CACHE_KEY = 'https://tugon-edge-cache.internal/v2/system-config';
const EDGE_REPORTS_CACHE_KEY = 'https://tugon-edge-cache.internal/v2/reports';
const EDGE_LOGBOOKS_CACHE_KEY = 'https://tugon-edge-cache.internal/v2/logbooks';
const EDGE_SUPPORT_CHATS_CACHE_KEY = 'https://tugon-edge-cache.internal/v2/support-chats';

const BARE_TUNNEL_ROOTS = new Set([
  'ngrok.dev',
  'www.ngrok.dev',
  'ngrok.com',
  'www.ngrok.com',
  'ngrok.app',
  'ngrok-free.app',
  'ngrok-free.dev',
  'ngrok.io',
  'trycloudflare.com',
  'cloudflare.com',
  'www.cloudflare.com',
  'loca.lt',
  'ts.net',
  'pages.dev',
  'workers.dev',
]);

const PI_EDGE_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/plain, */*',
  'ngrok-skip-browser-warning': 'true',
  'Bypass-Tunnel-Reminder': 'true',
  'User-Agent': 'TUGON-Cloudflare-Edge-Bridge/2.1',
};

function isPrivateHost(urlOrHost: string): boolean {
  try {
    const parsed = new URL(urlOrHost.includes('://') ? urlOrHost : `http://${urlOrHost}`);
    const h = parsed.hostname.toLowerCase();
    return (
      h === 'localhost' ||
      h === '127.0.0.1' ||
      h === '0.0.0.0' ||
      h.endsWith('.local') ||
      h.startsWith('192.168.') ||
      h.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(h)
    );
  } catch {
    return false;
  }
}

function isPublicTunnelHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h.endsWith('.ngrok-free.dev') ||
    h.endsWith('.ngrok-free.app') ||
    h.endsWith('.ngrok.dev') ||
    h.endsWith('.ngrok.app') ||
    h.endsWith('.ngrok.io') ||
    h.endsWith('.trycloudflare.com') ||
    h.endsWith('.ts.net') ||
    h.endsWith('.loca.lt')
  );
}

function isBareTunnelRoot(raw: string): boolean {
  try {
    const cleaned = String(raw || '').trim().replace(/^["'`|]+|["'`|]+$/g, '').trim();
    if (!cleaned) return false;
    const withProto = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
    const parsed = new URL(withProto);
    return BARE_TUNNEL_ROOTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isValidUrlSyntax(cleanUrl: string, selfOrigin?: string): boolean {
  if (!cleanUrl || isBareTunnelRoot(cleanUrl)) return false;
  try {
    const parsed = new URL(cleanUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const h = parsed.hostname.toLowerCase();
    if (!h) return false;
    if (selfOrigin) {
      try {
        const selfParsed = new URL(selfOrigin);
        if (parsed.origin.toLowerCase() === selfParsed.origin.toLowerCase()) {
          return false;
        }
      } catch {}
    }
    const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(h) || h.includes(':');
    const isLocal = h === 'localhost' || h.endsWith('.local');
    const hasValidDomain = h.includes('.') && /\.[a-z]{2,}$/i.test(h) && !h.startsWith('.') && !h.endsWith('.');
    return isIp || isLocal || hasValidDomain;
  } catch {
    return false;
  }
}

function normalizeEdgePiUrl(raw: string): string {
  if (!raw) return '';
  let u = String(raw).trim().replace(/^["'`|]+|["'`|]+$/g, '').trim();
  if (!u || /\s/.test(u) && !/https?:\/\//i.test(u)) return '';

  const embeddedMatches = u.match(/https?:\/\/[a-zA-Z0-9.-]+(?::\d+)?(?:\/[^\s|"'<>]*)?/gi);
  if (embeddedMatches && (u.includes(' ') || u.includes('->') || u.includes('|'))) {
    const publicTunnel = embeddedMatches.find((m) => !isPrivateHost(m));
    u = publicTunnel || embeddedMatches[0];
  }

  if (!/^https?:\/\//i.test(u)) {
    if (isPrivateHost(u)) {
      const hasPort = /:\d+(\/|$)/.test(u);
      u = `http://${hasPort ? u : `${u.replace(/\/+$/, '')}:8000`}`;
    } else {
      u = `https://${u}`;
    }
  } else if (/^http:\/\//i.test(u) && !isPrivateHost(u)) {
    try {
      const parsedCheck = new URL(u);
      if (isPublicTunnelHost(parsedCheck.hostname)) {
        u = u.replace(/^http:\/\//i, 'https://');
      }
    } catch {}
  }

  try {
    const parsed = new URL(u);
    // Public tunnel domains always terminate HTTPS on port 443 and forward to local port 3000/8000 on Pi
    if (isPublicTunnelHost(parsed.hostname) && (parsed.port === '3000' || parsed.port === '8000')) {
      parsed.port = '';
      u = parsed.toString();
    }
  } catch {
    return '';
  }

  return u
    .replace(/\/api\/(health|storage|reports|logbooks|config|pi-status)\/?$/i, '')
    .replace(/\/test\.txt$/i, '')
    .replace(/\/+$/, '');
}

function detectMethod(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes('ngrok')) return 'ngrok Tunnel';
  if (lower.includes('trycloudflare') || lower.includes('cloudflare')) return 'Cloudflare Tunnel';
  if (lower.includes('.ts.net') || lower.includes('tailscale')) return 'Tailscale Funnel';
  if (isPrivateHost(lower)) return 'Local Wi-Fi / LAN';
  return 'HTTPS Cloud Domain';
}

function isValidPiHealthJson(parsed: any): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  if (parsed.online === false || parsed.ok === false || parsed.healthy === false) return false;
  const statusStr = String(parsed.status ?? parsed.state ?? '').trim().toLowerCase();
  if (['offline', 'error', 'down', 'dead', 'disconnected', 'fail', 'failed'].includes(statusStr)) {
    return false;
  }
  if (parsed.error && !statusStr && parsed.online !== true && parsed.ok !== true) {
    return false;
  }
  const positiveStatuses = [
    'online',
    'active',
    'ok',
    'healthy',
    'running',
    'up',
    'ready',
    'connected',
    'live',
    'success',
  ];
  if (positiveStatuses.includes(statusStr)) return true;
  if (parsed.online === true || parsed.ok === true || parsed.healthy === true || parsed.active === true) {
    return true;
  }
  if (
    parsed.storage_folder ||
    parsed.hardware ||
    parsed.system ||
    parsed.disk_total ||
    parsed.cpu_temp ||
    typeof parsed.reports_count === 'number'
  ) {
    return true;
  }
  return false;
}

function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers':
        'Content-Type, Authorization, X-Pi-Endpoint, X-Telegram-Token, X-Telegram-Chat-Id, ngrok-skip-browser-warning, Accept',
      'Access-Control-Expose-Headers': 'X-Pi-Online, X-Portal-Revision, Content-Disposition',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      ...extraHeaders,
    },
  });
}

async function readEdgeCacheJson<T>(cacheKey: string, fallback: T): Promise<T> {
  try {
    const cacheStorage = (globalThis as any).caches;
    const defaultCache = cacheStorage?.default;
    if (!defaultCache) return fallback;
    const hit = await defaultCache.match(cacheKey);
    if (!hit) return fallback;
    const parsed = await hit.json();
    return (parsed as T) ?? fallback;
  } catch {
    return fallback;
  }
}

async function writeEdgeCacheJson(cacheKey: string, payload: unknown): Promise<void> {
  try {
    const cacheStorage = (globalThis as any).caches;
    const defaultCache = cacheStorage?.default;
    if (!defaultCache) return;
    await defaultCache.put(
      cacheKey,
      new Response(JSON.stringify(payload), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=2592000',
        },
      })
    );
  } catch {}
}

async function getEdgeConfig(): Promise<PersistedEdgeConfig> {
  const cached = await readEdgeCacheJson<PersistedEdgeConfig>(EDGE_CONFIG_CACHE_KEY, {});
  memoryConfig = { ...cached, ...memoryConfig };
  return memoryConfig;
}

async function saveEdgeConfig(patch: Partial<PersistedEdgeConfig>): Promise<PersistedEdgeConfig> {
  const existing = await getEdgeConfig();
  const next = { ...existing, ...patch };
  memoryConfig = next;
  await writeEdgeCacheJson(EDGE_CONFIG_CACHE_KEY, next);
  return next;
}

async function bumpEdgePortalRevision(minRevision?: number): Promise<number> {
  const cfg = await getEdgeConfig();
  const current = Number(cfg.portalRevision || 0);
  const nextRev = Math.max(current + 1, Number(minRevision || 0));
  await saveEdgeConfig({ portalRevision: nextRev });
  return nextRev;
}

function extractEdgeKeys(r: any): string[] {
  const keys: string[] = [];
  if (typeof r === 'string') {
    const raw = r.trim();
    if (!raw) return keys;
    if (raw.startsWith('id:') || raw.startsWith('tk:')) {
      keys.push(raw);
    } else {
      keys.push(`id:${raw}`);
      const tk = formatEdgeTicket(raw).toUpperCase();
      if (tk) keys.push(`tk:${tk}`);
    }
    return keys;
  }
  const rid = String(r?.id || '').trim();
  if (rid) keys.push(`id:${rid}`);
  const tk = formatEdgeTicket(r?.ticketNumber).toUpperCase();
  if (tk) keys.push(`tk:${tk}`);
  return keys;
}

function isEdgeReportTombstoned(item: any, tombstones: Set<string>): boolean {
  if (tombstones.size === 0) return false;
  return extractEdgeKeys(item).some((k) => tombstones.has(k));
}

async function recordEdgeDeletedKeys(keys: string[]): Promise<string[]> {
  const cfg = await getEdgeConfig();
  const set = new Set(Array.isArray(cfg.deletedReportIds) ? cfg.deletedReportIds : []);
  for (const k of keys) {
    for (const expanded of extractEdgeKeys(k)) {
      if (expanded) set.add(expanded);
    }
  }
  const next = Array.from(set).slice(-2500);
  await saveEdgeConfig({ deletedReportIds: next });
  return next;
}

async function getEdgeReports(): Promise<any[]> {
  const cfg = await getEdgeConfig();
  const tombstones = new Set(Array.isArray(cfg.deletedReportIds) ? cfg.deletedReportIds : []);
  const cached = await readEdgeCacheJson<any[]>(EDGE_REPORTS_CACHE_KEY, []);
  if (Array.isArray(cached) && cached.length > 0) {
    memoryReports = mergeReportsLists(memoryReports, cached, Array.from(tombstones));
  } else if (tombstones.size > 0 && memoryReports.length > 0) {
    memoryReports = memoryReports.filter((r) => !isEdgeReportTombstoned(r, tombstones));
  }
  return memoryReports;
}

async function saveEdgeReports(nextList: any[]): Promise<void> {
  memoryReports = Array.isArray(nextList) ? nextList : [];
  await writeEdgeCacheJson(EDGE_REPORTS_CACHE_KEY, memoryReports);
}

async function getEdgeLogbooks(): Promise<any[]> {
  const cached = await readEdgeCacheJson<any[]>(EDGE_LOGBOOKS_CACHE_KEY, []);
  if (Array.isArray(cached) && cached.length > 0 && memoryLogbooks.length === 0) {
    memoryLogbooks = cached;
  }
  return memoryLogbooks;
}

async function saveEdgeLogbooks(nextLogs: any[]): Promise<void> {
  memoryLogbooks = Array.isArray(nextLogs) ? nextLogs : [];
  await writeEdgeCacheJson(EDGE_LOGBOOKS_CACHE_KEY, memoryLogbooks);
}

function mergeSupportChatThreads(listA: any[], listB: any[]): any[] {
  const byId = new Map<string, any>();
  for (const t of [...(Array.isArray(listA) ? listA : []), ...(Array.isArray(listB) ? listB : [])]) {
    if (!t || !t.sessionId) continue;
    const key = String(t.sessionId).trim();
    const prev = byId.get(key);
    if (!prev) {
      byId.set(key, { ...t, messages: Array.isArray(t.messages) ? [...t.messages] : [] });
      continue;
    }
    const prevTs = new Date(prev.updatedAt || prev.createdAt || 0).getTime() || 0;
    const curTs = new Date(t.updatedAt || t.createdAt || 0).getTime() || 0;
    const winner = curTs >= prevTs ? t : prev;
    const runner = curTs >= prevTs ? prev : t;
    const msgMap = new Map<string, any>();
    for (const m of [...(runner.messages || []), ...(winner.messages || [])]) {
      if (m && m.id && m.text) msgMap.set(String(m.id), m);
    }
    const mergedMsgs = Array.from(msgMap.values())
      .sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')))
      .slice(-80);
    byId.set(key, {
      ...runner,
      ...winner,
      residentName: winner.residentName || runner.residentName || 'Resident',
      barangay: winner.barangay || runner.barangay || 'Barangay 40 & 41',
      ticketNumber: winner.ticketNumber ?? runner.ticketNumber ?? '',
      folder: winner.folder || runner.folder || 'INBOX',
      spamReason: winner.spamReason ?? runner.spamReason ?? '',
      aiHandoffSummary: winner.aiHandoffSummary || runner.aiHandoffSummary || '',
      messages: mergedMsgs,
    });
  }
  return Array.from(byId.values())
    .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
    .slice(0, 100);
}

async function getEdgeSupportChats(): Promise<any[]> {
  const cached = await readEdgeCacheJson<any[]>(EDGE_SUPPORT_CHATS_CACHE_KEY, []);
  if (Array.isArray(cached) && cached.length > 0) {
    memorySupportChats = mergeSupportChatThreads(memorySupportChats, cached);
  }
  return memorySupportChats;
}

async function saveEdgeSupportChats(nextThreads: any[]): Promise<void> {
  memorySupportChats = mergeSupportChatThreads([], Array.isArray(nextThreads) ? nextThreads : []);
  await writeEdgeCacheJson(EDGE_SUPPORT_CHATS_CACHE_KEY, memorySupportChats);
}

function buildCompactReportSummaryList(list: any[]): any[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((r) => r && (r.id || r.ticketNumber))
    .slice(0, 80)
    .map((r) => ({
      id: r.id,
      ticketNumber: formatEdgeTicket(r.ticketNumber) || r.ticketNumber,
      residentName: r.residentName || '',
      status: r.status || 'PENDING',
      severityLevel: r.severityLevel || 'MODERATE',
      isElderly: Boolean(r.isElderly),
      barangay: r.barangay || '',
      purok: r.purok || '',
      streetAddress: r.streetAddress || '',
      houseNumber: r.houseNumber || '',
      landmark: r.landmark || '',
      realtimeGpsAddress: r.realtimeGpsAddress || '',
      coordinates: r.coordinates || { lat: 14.47558, lng: 120.89115 },
      createdAt: r.createdAt || '',
      updatedAt: r.updatedAt || r.createdAt || '',
      portalRevision: Number(r.portalRevision || 0),
      dispatchedKagawad: r.dispatchedKagawad || '',
      resolvedBy: r.resolvedBy || '',
      resolutionNotes: r.resolutionNotes || '',
      isPurgedFromFeed: Boolean(r.isPurgedFromFeed),
      photosCount: Array.isArray(r.photos) ? r.photos.length : Number(r.photosCount || 0),
      proofPhotosCount: Array.isArray(r.proofPhotos) ? r.proofPhotos.length : Number(r.proofPhotosCount || 0),
      photos: [],
      proofPhotos: [],
    }));
}

async function syncTelegramSnapshotToPi(activePi: string, reportsList: any[]): Promise<void> {
  if (!activePi || isPrivateHost(activePi) || !Array.isArray(reportsList)) return;
  try {
    const compact = buildCompactReportSummaryList(reportsList).slice(0, 40);
    await fetch(`${activePi}/api/config`, {
      method: 'POST',
      headers: { ...PI_EDGE_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegramActiveSnapshot: compact }),
    }).catch(() => null);
  } catch {}
}

function formatEdgeTicket(raw?: unknown): string {
  const cleaned = String(raw || '')
    .trim()
    .replace(/^#+/, '');
  if (!cleaned) return '';
  return cleaned
    .replace(/^(PULSE|TRASH|DRAW)-CAV-/i, 'TUGON-CAV-')
    .replace(/^TUGON-CAV-/i, 'TUGON-CAV-');
}

function isValidEdgePhotoSrc(src?: unknown): src is string {
  if (typeof src !== 'string') return false;
  const trimmed = src.trim();
  if (!trimmed || trimmed === 'data:,' || trimmed === 'data:' || trimmed === 'about:blank') return false;
  if (trimmed.startsWith('blob:')) return false;
  if (trimmed.startsWith('data:image/')) return trimmed.length >= 100;
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/')) return true;
  if (trimmed.length >= 100 && /^[A-Za-z0-9+/=\s]+$/.test(trimmed.slice(0, 120))) return true;
  return false;
}

function pickBestEdgePhotos(primary?: any[], secondary?: any[]): string[] {
  const validPrimary = Array.isArray(primary) ? primary.filter(isValidEdgePhotoSrc) : [];
  const validSecondary = Array.isArray(secondary) ? secondary.filter(isValidEdgePhotoSrc) : [];
  if (validPrimary.length >= validSecondary.length && validPrimary.length > 0) return validPrimary;
  if (validSecondary.length > 0) return validSecondary;
  if (Array.isArray(primary) && primary.length > 0) return primary;
  if (Array.isArray(secondary) && secondary.length > 0) return secondary;
  return [];
}

function parseEdgeUpdatedTs(r: any): number {
  const raw = r?.updatedAt || r?.resolvedAt || r?.cancelledAt || r?.dispatchedAt || r?.createdAt;
  if (!raw) return 0;
  const ts = new Date(raw).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function mergeReportsLists(listA: any[], listB: any[], deletedIds?: string[]): any[] {
  const tombstones = new Set(deletedIds || memoryConfig.deletedReportIds || []);
  const byId = new Map<string, any>();
  const ticketToKey = new Map<string, string>();
  const score = (r: any) => {
    const st = r?.status;
    const base = st === 'RESOLVED' ? 4 : st === 'CANCELLED' ? 3 : st === 'DISPATCHED' ? 2 : 1;
    const validProofCount = Array.isArray(r?.proofPhotos)
      ? r.proofPhotos.filter(isValidEdgePhotoSrc).length
      : 0;
    return base * 10 + validProofCount;
  };
  const compareEdgeRecords = (a: any, b: any): number => {
    const tsA = parseEdgeUpdatedTs(a);
    const tsB = parseEdgeUpdatedTs(b);
    if (tsA !== tsB) return tsA - tsB;
    const revA = Number(a?.portalRevision || 0);
    const revB = Number(b?.portalRevision || 0);
    if (revA !== revB) return revA - revB;
    return score(a) - score(b);
  };

  for (const item of [...(Array.isArray(listA) ? listA : []), ...(Array.isArray(listB) ? listB : [])]) {
    if (!item || (!item.id && !item.ticketNumber)) continue;
    if (isEdgeReportTombstoned(item, tombstones)) continue;

    const tk = formatEdgeTicket(item.ticketNumber).toUpperCase();
    const mappedKey = tk ? ticketToKey.get(tk) : undefined;
    const key = mappedKey || String(item.id || (tk ? `tk:${tk}` : ''));
    if (!key) continue;
    if (tk && !ticketToKey.has(tk)) ticketToKey.set(tk, key);

    const prev = byId.get(key);
    if (!prev) {
      byId.set(key, {
        ...item,
        ticketNumber: formatEdgeTicket(item.ticketNumber) || item.ticketNumber,
      });
    } else {
      const winner = compareEdgeRecords(item, prev) >= 0 ? item : prev;
      const runnerUp = compareEdgeRecords(item, prev) >= 0 ? prev : item;
      const winnerExplicitEdit = Boolean(winner.updatedAt);
      const winnerIsRevertedPending = winnerExplicitEdit && winner.status === 'PENDING';
      byId.set(key, {
        ...runnerUp,
        ...winner,
        id: winner.id || runnerUp.id,
        ticketNumber:
          formatEdgeTicket(winner.ticketNumber || runnerUp.ticketNumber) || winner.ticketNumber,
        residentName: winnerExplicitEdit
          ? (winner.residentName ?? runnerUp.residentName ?? '')
          : (winner.residentName || runnerUp.residentName || ''),
        residentPhone: winnerExplicitEdit
          ? (winner.residentPhone ?? runnerUp.residentPhone)
          : (winner.residentPhone || runnerUp.residentPhone),
        streetAddress: winnerExplicitEdit
          ? (winner.streetAddress ?? runnerUp.streetAddress)
          : (winner.streetAddress || runnerUp.streetAddress),
        houseNumber: winnerExplicitEdit
          ? (winner.houseNumber ?? runnerUp.houseNumber)
          : (winner.houseNumber || runnerUp.houseNumber),
        landmark: winnerExplicitEdit
          ? (winner.landmark ?? runnerUp.landmark)
          : (winner.landmark || runnerUp.landmark),
        notes: winnerExplicitEdit
          ? (winner.notes ?? runnerUp.notes)
          : (winner.notes || runnerUp.notes),
        extraMessage: winnerExplicitEdit
          ? (winner.extraMessage ?? runnerUp.extraMessage)
          : (winner.extraMessage || runnerUp.extraMessage),
        dispatchedAt: winnerIsRevertedPending
          ? winner.dispatchedAt
          : (winner.dispatchedAt || runnerUp.dispatchedAt),
        dispatchedKagawad: winnerIsRevertedPending
          ? winner.dispatchedKagawad
          : (winner.dispatchedKagawad || runnerUp.dispatchedKagawad),
        resolvedAt: winnerIsRevertedPending
          ? winner.resolvedAt
          : (winner.resolvedAt || runnerUp.resolvedAt),
        resolvedBy: winnerIsRevertedPending
          ? winner.resolvedBy
          : (winner.resolvedBy || runnerUp.resolvedBy),
        resolutionNotes: winnerExplicitEdit
          ? (winner.resolutionNotes ?? runnerUp.resolutionNotes)
          : (winner.resolutionNotes || runnerUp.resolutionNotes),
        proofSubmittedAt: winnerIsRevertedPending
          ? winner.proofSubmittedAt
          : (winner.proofSubmittedAt || runnerUp.proofSubmittedAt),
        proofKagawadName: winnerIsRevertedPending
          ? winner.proofKagawadName
          : (winner.proofKagawadName || runnerUp.proofKagawadName),
        cancelledAt: winnerIsRevertedPending
          ? winner.cancelledAt
          : (winner.cancelledAt || runnerUp.cancelledAt),
        cancellationReason: winnerExplicitEdit
          ? (winner.cancellationReason ?? runnerUp.cancellationReason)
          : (winner.cancellationReason || runnerUp.cancellationReason),
        photos: pickBestEdgePhotos(winner.photos, runnerUp.photos),
        proofPhotos: pickBestEdgePhotos(winner.proofPhotos, runnerUp.proofPhotos),
      });
    }
  }

  return Array.from(byId.values()).sort(
    (a, b) => new Date(b?.createdAt || 0).getTime() - new Date(a?.createdAt || 0).getTime()
  );
}

function getPhilippineDateTime(): string {
  try {
    return new Intl.DateTimeFormat('en-PH', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(new Date());
  } catch {
    return new Date().toISOString();
  }
}

async function getEdgeCloudLockState(env: EdgeEnv) {
  const cfg = await getEdgeConfig();
  return resolveLockedCloudServerState({
    envUrl: env?.PI_SERVER_URL || env?.VITE_PI_SERVER_URL || '',
    envLocked: env?.PI_SERVER_LOCKED,
    persistedUrl: cfg.piServerUrl || '',
    persistedLocked: Boolean(cfg.piServerLocked),
  });
}

async function resolveActivePiUrl(request: Request, env: EdgeEnv): Promise<string> {
  const reqUrl = new URL(request.url);
  const lockState = await getEdgeCloudLockState(env);
  if (lockState.locked && lockState.lockedUrl) {
    const cleanLocked = normalizeEdgePiUrl(lockState.lockedUrl);
    if (cleanLocked && isValidUrlSyntax(cleanLocked, reqUrl.origin)) {
      return cleanLocked;
    }
  }

  const headerUrl = normalizeEdgePiUrl(request.headers.get('X-Pi-Endpoint') || '');
  if (headerUrl && isValidUrlSyntax(headerUrl, reqUrl.origin)) {
    return headerUrl;
  }
  const queryUrl = normalizeEdgePiUrl(
    reqUrl.searchParams.get('pi') || reqUrl.searchParams.get('endpoint') || ''
  );
  if (queryUrl && isValidUrlSyntax(queryUrl, reqUrl.origin)) {
    return queryUrl;
  }
  const cfg = await getEdgeConfig();
  if (cfg.piServerUrl) {
    const clean = normalizeEdgePiUrl(cfg.piServerUrl);
    if (clean && isValidUrlSyntax(clean, reqUrl.origin)) {
      return clean;
    }
  }
  const envCandidate = normalizeEdgePiUrl(env?.PI_SERVER_URL || env?.VITE_PI_SERVER_URL || '');
  if (isValidUrlSyntax(envCandidate, reqUrl.origin)) {
    return envCandidate;
  }
  if (env?.ASSETS && typeof env.ASSETS.fetch === 'function') {
    try {
      const assetRes = await env.ASSETS.fetch(new Request(new URL('/pi-config.json', reqUrl.origin).toString()));
      if (assetRes && assetRes.ok) {
        const assetJson: any = await assetRes.json().catch(() => null);
        const assetUrl = normalizeEdgePiUrl(assetJson?.piServerUrl || '');
        if (assetUrl && isValidUrlSyntax(assetUrl, reqUrl.origin)) {
          return assetUrl;
        }
      }
    } catch {}
  }
  return '';
}

function classifyTunnelFailure(
  res: Response,
  text: string,
  isEn: boolean
): string | null {
  const ngrokErr = (res.headers.get('ngrok-error-code') || '').toUpperCase();
  if (
    ngrokErr.includes('ERR_NGROK_3200') ||
    text.includes('ERR_NGROK_3200') ||
    (text.includes('endpoint') && text.includes('is offline'))
  ) {
    return isEn
      ? 'The ngrok tunnel is offline (ERR_NGROK_3200). Make sure your Cloud Server and ngrok tunnel (e.g. ngrok http 3000 or 8000) are running.'
      : 'Naka-offline ang ngrok tunnel (ERR_NGROK_3200). Pakisiguradong tumatakbo ang iyong Cloud Server at ngrok tunnel (hal. ngrok http 3000 o 8000).';
  }
  if (
    ngrokErr.includes('ERR_NGROK_8012') ||
    text.includes('ERR_NGROK_8012') ||
    text.toLowerCase().includes('connection refused')
  ) {
    return isEn
      ? 'ngrok tunnel is open, but no server is responding on the forwarded port (e.g. port 3000 or 8000) on your Cloud Server (ERR_NGROK_8012).'
      : 'Bukas ang ngrok tunnel ngunit walang sumasagot na server sa port (hal. port 3000 o 8000) ng iyong Cloud Server (ERR_NGROK_8012).';
  }
  if (ngrokErr.startsWith('ERR_NGROK_')) {
    return isEn
      ? `ngrok returned tunnel error ${ngrokErr}. Verify your Forwarding URL.`
      : `Nagbalik ng tunnel error (${ngrokErr}) ang ngrok. Pakisuri ang iyong Forwarding URL.`;
  }
  if (
    res.status === 502 ||
    res.status === 503 ||
    res.status === 504 ||
    res.status === 530 ||
    text.includes('Argo Tunnel error') ||
    text.includes('Origin DNS error')
  ) {
    return isEn
      ? `Tunnel gateway error (HTTP ${res.status}). Check that your Cloud Server (port 3000 or 8000) and tunnel are running.`
      : `Hindi maabot ng tunnel ang Cloud Server (HTTP ${res.status}). Siguraduhing tumatakbo ang server (port 3000 o 8000) at tunnel.`;
  }
  return null;
}

async function probeRemotePi(
  cleanEndpoint: string,
  isEn = false,
  selfOrigin?: string
): Promise<{
  isLive: boolean;
  data: any;
  latencyMs: number;
  mode?: string;
  errorDetail?: string;
}> {
  if (!cleanEndpoint || !isValidUrlSyntax(cleanEndpoint, selfOrigin)) {
    return {
      isLive: false,
      data: null,
      latencyMs: 0,
      errorDetail: isEn
        ? 'Invalid Cloud Server link format. Please enter a valid URL (e.g. https://pi.tugon-brgy40-41.org).'
        : 'Hindi valid ang inilagay na Cloud Server link. Pakilagay ang tamang URL (hal. https://pi.tugon-brgy40-41.org).',
    };
  }

  if (isPrivateHost(cleanEndpoint)) {
    return {
      isLive: false,
      data: null,
      latencyMs: 0,
      errorDetail: isEn
        ? 'Private LAN IP cannot be reached from the public cloud unless tunneled or accessed on the same Wi-Fi.'
        : 'Pribadong Local Wi-Fi IP ito. Kailangan ng tunnel (ngrok / cloudflared) kung binubuksan mula sa internet, o buksan sa parehong Wi-Fi.',
    };
  }

  const start = Date.now();
  try {
    // 1. Primary check: /api/health
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6500);
    const res = await fetch(`${cleanEndpoint}/api/health`, {
      signal: ctrl.signal,
      headers: PI_EDGE_HEADERS,
    }).catch(() => null);
    clearTimeout(timer);

    if (res) {
      const text = await res.text().catch(() => '');
      const tunnelErr = classifyTunnelFailure(res, text, isEn);
      if (tunnelErr) {
        return { isLive: false, data: null, latencyMs: 0, errorDetail: tunnelErr };
      }

      if (res.ok) {
        let parsed: any = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }

        if (isValidPiHealthJson(parsed)) {
          return {
            isLive: true,
            data: {
              status: 'ONLINE',
              system: parsed.system || 'T.U.G.O.N. Cloud Server',
              hardware: parsed.hardware || 'Cloud Storage Server',
              storage_folder: parsed.storage_folder || 'Cloud Storage Database',
              disk_total: parsed.disk_total || '500.0 GB',
              disk_used: parsed.disk_used || '20.0 GB',
              disk_free: parsed.disk_free || '480.0 GB',
              ram: parsed.ram || 'Active (Healthy)',
              cpu_temp: parsed.cpu_temp || '42.0\u00B0C',
              cpuTempCelsius: parsed.cpuTempCelsius || parseFloat(parsed.cpu_temp) || 42.0,
              ...parsed,
            },
            latencyMs: Math.max(1, Date.now() - start),
            mode: 'PULSE_SERVER',
          };
        }
      }
    }

    // 2. Secondary check: Root '/' (for custom Python BaseHTTP/SimpleHTTP servers or root health JSON)
    const rootCtrl = new AbortController();
    const rootTimer = setTimeout(() => rootCtrl.abort(), 4500);
    const rootRes = await fetch(`${cleanEndpoint}/`, {
      signal: rootCtrl.signal,
      headers: PI_EDGE_HEADERS,
    }).catch(() => null);
    clearTimeout(rootTimer);

    if (rootRes) {
      const rootText = await rootRes.text().catch(() => '');
      const rootTunnelErr = classifyTunnelFailure(rootRes, rootText, isEn);
      if (rootTunnelErr) {
        return { isLive: false, data: null, latencyMs: 0, errorDetail: rootTunnelErr };
      }

      if (rootRes.ok) {
        let rootJson: any = null;
        try {
          rootJson = JSON.parse(rootText);
        } catch {
          rootJson = null;
        }

        if (isValidPiHealthJson(rootJson)) {
          return {
            isLive: true,
            data: {
              status: 'ONLINE',
              system: rootJson.system || 'T.U.G.O.N. Cloud Server',
              hardware: rootJson.hardware || 'Cloud Storage Server',
              storage_folder: rootJson.storage_folder || 'Cloud Storage Database',
              disk_total: rootJson.disk_total || '500.0 GB',
              disk_used: rootJson.disk_used || '20.0 GB',
              disk_free: rootJson.disk_free || '480.0 GB',
              ram: rootJson.ram || 'Active (Healthy)',
              cpu_temp: rootJson.cpu_temp || '42.0\u00B0C',
              ...rootJson,
            },
            latencyMs: Math.max(1, Date.now() - start),
            mode: 'PULSE_SERVER',
          };
        }

        const serverHeader = (rootRes.headers.get('server') || '').toLowerCase();
        const isPythonStorageListing =
          rootText.includes('Directory listing for') ||
          rootText.includes('pulse_reports.json') ||
          rootText.includes('saved_logbooks') ||
          ((serverHeader.includes('python') ||
            serverHeader.includes('basehttp') ||
            serverHeader.includes('simplehttp')) &&
            !rootText.toLowerCase().includes('<script'));

        if (isPythonStorageListing) {
          return {
            isLive: true,
            data: {
              status: 'ONLINE',
              system: 'Cloud Storage Server',
              hardware: 'Cloud Storage Server',
              storage_folder: 'Cloud Storage Database',
              disk_total: '500.0 GB',
              disk_used: '20.0 GB',
              disk_free: '480.0 GB',
              ram: 'Active (Healthy)',
              cpu_temp: '42.0\u00B0C',
            },
            latencyMs: Math.max(1, Date.now() - start),
            mode: 'SIMPLE_HTTP',
          };
        }
      }
    }
  } catch (e: any) {
    return {
      isLive: false,
      data: null,
      latencyMs: 0,
      errorDetail: isEn
        ? `Cannot reach ${cleanEndpoint}. Please verify the URL and make sure your Cloud Server (port 3000 or 8000) and tunnel are running.`
        : `Hindi maabot ang ${cleanEndpoint}. Pakisuri kung tama ang link at tumatakbo ang iyong Cloud Server (port 3000 o 8000) at tunnel.`,
    };
  }

  return {
    isLive: false,
    data: null,
    latencyMs: 0,
    errorDetail: isEn
      ? `${cleanEndpoint} is not a valid or active Cloud Server.`
      : `Ang ${cleanEndpoint} ay hindi valid o hindi aktibong Cloud Server.`,
  };
}

async function syncTombstonesFromPi(activePi: string): Promise<string[]> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const cfgRes = await fetch(`${activePi}/api/config`, {
      signal: ctrl.signal,
      headers: PI_EDGE_HEADERS,
    }).catch(() => null);
    clearTimeout(timer);
    if (cfgRes && cfgRes.ok) {
      const parsed: any = await cfgRes.json().catch(() => null);
      if (typeof parsed?.portalRevision === 'number') {
        const curCfg = await getEdgeConfig();
        if (parsed.portalRevision > Number(curCfg.portalRevision || 0)) {
          await saveEdgeConfig({ portalRevision: parsed.portalRevision });
        }
      }
      if (Array.isArray(parsed?.deletedReportIds) && parsed.deletedReportIds.length > 0) {
        return await recordEdgeDeletedKeys(parsed.deletedReportIds);
      }
    }
  } catch {}
  const cfg = await getEdgeConfig();
  return Array.isArray(cfg.deletedReportIds) ? cfg.deletedReportIds : [];
}

async function fetchPiReportsArray(
  activePi: string,
  timeoutMs = 14000,
  summaryOnly = false
): Promise<{ ok: boolean; isArray: boolean; list: any[]; revision?: number }> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const suffix = summaryOnly ? '?summary=1' : '';
    const piRes = await fetch(`${activePi}/api/reports${suffix}`, {
      signal: ctrl.signal,
      headers: PI_EDGE_HEADERS,
    });
    clearTimeout(timer);
    if (!piRes.ok) return { ok: false, isArray: false, list: [] };
    const revHeader = Number(piRes.headers.get('X-Portal-Revision') || 0);
    const parsed: any = await piRes.json().catch(() => null);
    if (Array.isArray(parsed)) {
      return { ok: true, isArray: true, list: parsed, revision: revHeader || undefined };
    }
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.reports)) {
      return { ok: true, isArray: true, list: parsed.reports, revision: revHeader || undefined };
    }
    if (isValidPiHealthJson(parsed)) {
      // Lightweight custom Python server on Pi (e.g. {"status": "active"})
      return { ok: true, isArray: false, list: [], revision: revHeader || undefined };
    }
    return { ok: false, isArray: false, list: [] };
  } catch {
    return { ok: false, isArray: false, list: [] };
  }
}

async function pushReportsToRemotePi(activePi: string, mergedReports: any[], singleReport?: any): Promise<boolean> {
  try {
    // Prefer small, atomic single-report POST when submitting a single concern so large photo history never times out Worker execution
    if (singleReport) {
      const ctrl1 = new AbortController();
      const timer1 = setTimeout(() => ctrl1.abort(), 14000);
      const postRes = await fetch(`${activePi}/api/reports`, {
        method: 'POST',
        signal: ctrl1.signal,
        headers: { ...PI_EDGE_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(singleReport),
      }).catch(() => null);
      clearTimeout(timer1);
      if (postRes && postRes.ok) return true;
    }

    const ctrl2 = new AbortController();
    const timer2 = setTimeout(() => ctrl2.abort(), 15000);
    const syncRes = await fetch(`${activePi}/api/reports/sync`, {
      method: 'POST',
      signal: ctrl2.signal,
      headers: { ...PI_EDGE_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify(mergedReports),
    }).catch(() => null);
    clearTimeout(timer2);

    if (syncRes && syncRes.ok) {
      const syncJson: any = await syncRes.json().catch(() => null);
      if (Array.isArray(syncJson?.deletedReportIds)) {
        await recordEdgeDeletedKeys(syncJson.deletedReportIds);
      }
      return true;
    }
  } catch {}
  return false;
}

async function resolveEdgeTelegramCreds(
  request: Request,
  env: EdgeEnv,
  cfg: PersistedEdgeConfig,
  activePi: string,
  body?: any
): Promise<{ token: string; chatId: string }> {
  let token = String(
    body?.telegramBotToken ||
      request.headers.get('X-Telegram-Token') ||
      cfg.telegramBotToken ||
      env?.TELEGRAM_BOT_TOKEN ||
      ''
  ).trim();
  let chatId = String(
    body?.telegramChatId ||
      request.headers.get('X-Telegram-Chat-Id') ||
      cfg.telegramChatId ||
      env?.TELEGRAM_CHAT_ID ||
      ''
  ).trim();

  // Cold-isolate fallback: check connected Pi /api/config so resident phones work across workers
  if ((!token || !chatId) && activePi && !isPrivateHost(activePi)) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2500);
      const piCfgRes = await fetch(`${activePi}/api/config`, {
        signal: ctrl.signal,
        headers: PI_EDGE_HEADERS,
      }).catch(() => null);
      clearTimeout(t);
      if (piCfgRes && piCfgRes.ok) {
        const piCfg: any = await piCfgRes.json().catch(() => null);
        if (!token && piCfg?.telegramBotToken) token = String(piCfg.telegramBotToken).trim();
        if (!chatId && piCfg?.telegramChatId) chatId = String(piCfg.telegramChatId).trim();
      }
    } catch {}
  }

  if (token && chatId && (cfg.telegramBotToken !== token || cfg.telegramChatId !== chatId)) {
    await saveEdgeConfig({
      telegramBotToken: token,
      telegramChatId: chatId,
      telegramSetupComplete: true,
    });
  }

  return { token, chatId };
}

async function sendEdgeTelegramMessage(
  botToken: string,
  chatId: string,
  htmlText: string,
  replyMarkup?: any,
  opts?: { replyToMessageId?: number; messageThreadId?: number }
): Promise<{ ok: boolean; description?: string }> {
  if (!botToken || !chatId) return { ok: false, description: 'Not configured' };
  const postSend = async (bodyObj: Record<string, any>) => {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj),
    });
    const data: any = await res.json().catch(() => ({}));
    return { ok: Boolean(res.ok && data?.ok), description: String(data?.description || '') };
  };

  try {
    const basePayload: Record<string, any> = {
      chat_id: chatId,
      text: htmlText.length > 4050 ? htmlToPlainTelegramText(htmlText).slice(0, 3900) : htmlText,
      parse_mode: htmlText.length > 4050 ? undefined : 'HTML',
      disable_web_page_preview: true,
    };
    if (!basePayload.parse_mode) delete basePayload.parse_mode;
    if (replyMarkup) basePayload.reply_markup = replyMarkup;
    if (typeof opts?.messageThreadId === 'number' && opts.messageThreadId > 0) {
      basePayload.message_thread_id = opts.messageThreadId;
    }
    if (typeof opts?.replyToMessageId === 'number' && opts.replyToMessageId > 0) {
      basePayload.reply_parameters = {
        message_id: opts.replyToMessageId,
        allow_sending_without_reply: true,
      };
    }

    let attempt = await postSend(basePayload);
    if (attempt.ok) return { ok: true };

    const errLower = attempt.description.toLowerCase();
    // Retry without reply_parameters / message_thread_id if Telegram rejects reply context
    if (
      (errLower.includes('reply') || errLower.includes('thread')) &&
      (basePayload.reply_parameters || basePayload.message_thread_id)
    ) {
      const noReplyPayload = { ...basePayload };
      delete noReplyPayload.reply_parameters;
      delete noReplyPayload.message_thread_id;
      attempt = await postSend(noReplyPayload);
      if (attempt.ok) return { ok: true };
    }

    // Retry as truncated plain text if HTML parsing or message length caused failure
    const errRetryLower = attempt.description.toLowerCase();
    if (errRetryLower.includes('parse') || errRetryLower.includes('too long') || errRetryLower.includes('entities')) {
      const plainPayload: Record<string, any> = {
        chat_id: chatId,
        text: htmlToPlainTelegramText(htmlText).slice(0, 3900),
        disable_web_page_preview: true,
      };
      if (replyMarkup) plainPayload.reply_markup = replyMarkup;
      attempt = await postSend(plainPayload);
      if (attempt.ok) return { ok: true };
    }

    return { ok: false, description: attempt.description };
  } catch (e: any) {
    return { ok: false, description: e?.message };
  }
}

async function sendEdgeTelegramPhoto(
  botToken: string,
  chatId: string,
  dataUrl: string,
  captionText: string,
  replyMarkup?: any,
  useHtml = false
): Promise<{ ok: boolean }> {
  if (!botToken || !chatId || !dataUrl || !dataUrl.startsWith('data:image/')) {
    return { ok: false };
  }
  try {
    const commaIdx = dataUrl.indexOf(',');
    if (commaIdx === -1) return { ok: false };
    const header = dataUrl.slice(0, commaIdx);
    const base64Data = dataUrl.slice(commaIdx + 1);
    const mimeMatch = header.match(/data:(image\/[a-zA-Z0-9.+-]+);base64/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
    const ext = mimeType.includes('png') ? 'png' : 'jpg';
    const binaryStr = atob(base64Data);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('caption', captionText.slice(0, 950));
    if (useHtml) formData.append('parse_mode', 'HTML');
    if (replyMarkup) formData.append('reply_markup', JSON.stringify(replyMarkup));
    formData.append('photo', new Blob([bytes], { type: mimeType }), `tugon_report.${ext}`);

    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: 'POST',
      body: formData,
    });
    const parsed: any = await res.json().catch(() => ({ ok: false }));
    return { ok: Boolean(res.ok && parsed?.ok) };
  } catch {
    return { ok: false };
  }
}

async function dispatchEdgeNewConcern2Messages(
  token: string,
  chatId: string,
  report: any,
  allReports: any[],
  lang: 'tl' | 'en',
  cfg: PersistedEdgeConfig
): Promise<{ notified: boolean; count: number }> {
  if (!token || !chatId) return { notified: false, count: 0 };
  const phTime = getPhilippineDateTime();
  const msg1Html = buildNewConcernMessage1Html(report, lang, phTime);
  const inlineKb = buildNewConcernInlineKeyboard(report, lang);

  let m1Ok = false;
  if (Array.isArray(report.photos) && typeof report.photos[0] === 'string' && report.photos[0].startsWith('data:image/')) {
    const captionHtml = buildNewConcernPhotoCaptionHtml(report, lang, phTime);
    const photoRes = await sendEdgeTelegramPhoto(token, chatId, report.photos[0], captionHtml, inlineKb, true);
    m1Ok = photoRes.ok;
  }
  if (!m1Ok) {
    const txtRes = await sendEdgeTelegramMessage(token, chatId, msg1Html, inlineKb);
    m1Ok = txtRes.ok;
  }

  const msg2Html = buildActiveUnresolvedConcernsMessage2Html(allReports, lang, 'ACTIVE');
  const m2Res = await sendEdgeTelegramMessage(
    token,
    chatId,
    msg2Html,
    buildTelegramReplyMarkupForChat(lang, chatId)
  );
  const m2Ok = m2Res.ok;

  if (m1Ok || m2Ok) {
    const prevHist = Array.isArray(cfg.broadcastHistory) ? cfg.broadcastHistory : [];
    const newEntries = [
      m2Ok ? `[${phTime}] ${htmlToPlainTelegramText(msg2Html).replace(/\n+/g, ' • ')}` : '',
      m1Ok ? `[${phTime}] ${htmlToPlainTelegramText(msg1Html).replace(/\n+/g, ' • ')}` : '',
    ].filter(Boolean);
    await saveEdgeConfig({
      lastBroadcastMessage: htmlToPlainTelegramText(msg1Html),
      lastBroadcastTime: phTime,
      broadcastHistory: [...newEntries, ...prevHist].slice(0, 20),
    });
  }

  return { notified: m1Ok || m2Ok, count: (m1Ok ? 1 : 0) + (m2Ok ? 1 : 0) };
}

async function getLiveReportsForTelegramBot(
  activePi: string,
  timeoutMs = 14000
): Promise<any[]> {
  const cached = await getEdgeReports();
  const cfg = await getEdgeConfig();
  let tombstones = new Set(Array.isArray(cfg.deletedReportIds) ? cfg.deletedReportIds : []);

  if (activePi && !isPrivateHost(activePi)) {
    // Query lightweight ?summary=1 and /api/config (deleted IDs + compact telegramActiveSnapshot) concurrently
    const configPromise = (async (): Promise<any | null> => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 3800);
        const r = await fetch(`${activePi}/api/config`, {
          signal: ctrl.signal,
          headers: PI_EDGE_HEADERS,
        }).catch(() => null);
        clearTimeout(t);
        if (r && r.ok) return await r.json().catch(() => null);
      } catch {}
      return null;
    })();

    let [piCfg, piRes] = await Promise.all([
      configPromise,
      fetchPiReportsArray(activePi, timeoutMs, true),
    ]);

    if (Array.isArray(piCfg?.deletedReportIds) && piCfg.deletedReportIds.length > 0) {
      const updatedTombstones = await recordEdgeDeletedKeys(piCfg.deletedReportIds);
      tombstones = new Set(updatedTombstones);
    }

    if (!piRes.ok || !piRes.isArray) {
      piRes = await fetchPiReportsArray(activePi, Math.max(timeoutMs, 18000), false);
    }

    let sourceList: any[] | null = null;
    if (piRes.ok && piRes.isArray) {
      sourceList = piRes.list;
    } else if (Array.isArray(piCfg?.telegramActiveSnapshot) && piCfg.telegramActiveSnapshot.length > 0) {
      sourceList = piCfg.telegramActiveSnapshot;
    }

    if (sourceList) {
      // Non-destructive merge preserves cached photos if sourceList is summary/snapshot AND preserves cached items unless tombstoned
      const merged =
        sourceList.length > 0
          ? mergeReportsLists(cached, sourceList, Array.from(tombstones))
          : cached.filter((r) => !isEdgeReportTombstoned(r, tombstones));
      if (merged.length > 0) {
        await saveEdgeReports(merged);
      }
      return merged;
    }
  }

  return cached.filter((r) => !isEdgeReportTombstoned(r, tombstones));
}

function buildEdgeTelegramWebhookUrl(cleanOrigin: string, activePi = ''): string {
  const cleanPi = activePi && !isPrivateHost(activePi) ? normalizeEdgePiUrl(activePi) : '';
  const baseUrl = `${cleanOrigin.replace(/\/+$/, '')}/api/telegram/webhook`;
  if (!cleanPi) return baseUrl;
  const withPi = `${baseUrl}?pi=${encodeURIComponent(cleanPi)}`;
  return withPi.length <= 255 ? withPi : baseUrl;
}

async function registerEdgeTelegramWebhook(
  token: string,
  reqOrigin: string,
  chatId = '',
  activePi = ''
): Promise<{ ok: boolean; webhookUrl?: string; secretTag?: string }> {
  if (!token || !reqOrigin || !reqOrigin.startsWith('https://') || isPrivateHost(reqOrigin)) {
    return { ok: false };
  }
  const cleanPi = activePi && !isPrivateHost(activePi) ? normalizeEdgePiUrl(activePi) : '';
  const webhookUrl = buildEdgeTelegramWebhookUrl(reqOrigin, cleanPi);
  const secretToken = encodeTelegramWebhookSecret(token, chatId, cleanPi);
  try {
    const bodyPayload: Record<string, any> = {
      url: webhookUrl,
      allowed_updates: ['message', 'edited_message', 'callback_query', 'channel_post'],
      drop_pending_updates: false,
    };
    if (secretToken) {
      bodyPayload.secret_token = secretToken;
    }
    const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyPayload),
    });
    const parsed: any = await res.json().catch(() => null);
    if (res.ok && parsed?.ok) {
      return { ok: true, webhookUrl, secretTag: secretToken };
    }
  } catch {}
  return { ok: false };
}

async function ensureEdgeTelegramWebhook(
  token: string,
  reqOrigin: string,
  chatId: string,
  activePi: string,
  cfg: PersistedEdgeConfig,
  forceRefresh = false
): Promise<{ webhookUrl: string; secretTag: string }> {
  if (!token || !reqOrigin || !reqOrigin.startsWith('https://') || isPrivateHost(reqOrigin)) {
    return {
      webhookUrl: cfg.telegramWebhookUrl || '',
      secretTag: cfg.telegramWebhookSecretTag || '',
    };
  }
  const cleanPi = activePi && !isPrivateHost(activePi) ? normalizeEdgePiUrl(activePi) : '';
  const expectedUrl = buildEdgeTelegramWebhookUrl(reqOrigin, cleanPi);
  const expectedSecret = encodeTelegramWebhookSecret(token, chatId, cleanPi);
  if (!forceRefresh && cfg.telegramWebhookUrl === expectedUrl && cfg.telegramWebhookSecretTag === expectedSecret) {
    return { webhookUrl: expectedUrl, secretTag: expectedSecret };
  }
  const reg = await registerEdgeTelegramWebhook(token, reqOrigin, chatId, cleanPi);
  if (reg.ok && reg.webhookUrl) {
    await saveEdgeConfig({
      telegramWebhookUrl: reg.webhookUrl,
      telegramWebhookSecretTag: reg.secretTag || '',
    });
    return { webhookUrl: reg.webhookUrl, secretTag: reg.secretTag || '' };
  }
  return {
    webhookUrl: cfg.telegramWebhookUrl || '',
    secretTag: cfg.telegramWebhookSecretTag || '',
  };
}

async function syncEdgePiAndTelegramContext(
  request: Request,
  env: EdgeEnv,
  origin: string,
  activePi: string,
  body?: any,
  forceWebhookRefresh = false
): Promise<void> {
  try {
    let cfg = await getEdgeConfig();
    const lockState = await getEdgeCloudLockState(env);
    const canPersistPi =
      Boolean(activePi) &&
      !isPrivateHost(activePi) &&
      (!lockState.locked || isUrlAllowedUnderLock(activePi, lockState));

    const reqToken = String(
      body?.telegramBotToken ||
        request.headers.get('X-Telegram-Token') ||
        cfg.telegramBotToken ||
        env?.TELEGRAM_BOT_TOKEN ||
        ''
    ).trim();
    const reqChat = String(
      body?.telegramChatId ||
        request.headers.get('X-Telegram-Chat-Id') ||
        cfg.telegramChatId ||
        env?.TELEGRAM_CHAT_ID ||
        ''
    ).trim();

    const patch: Partial<PersistedEdgeConfig> = {};
    if (canPersistPi && cfg.piServerUrl !== activePi) {
      patch.piServerUrl = activePi;
    }
    if (
      !cfg.telegramLocked &&
      reqToken &&
      reqChat &&
      (cfg.telegramBotToken !== reqToken || cfg.telegramChatId !== reqChat)
    ) {
      patch.telegramBotToken = reqToken;
      patch.telegramChatId = reqChat;
      patch.telegramSetupComplete = true;
    }
    if (Object.keys(patch).length > 0) {
      cfg = await saveEdgeConfig(patch);
    }

    const finalToken = cfg.telegramBotToken || reqToken;
    const finalChat = cfg.telegramChatId || reqChat;
    const finalPi = (canPersistPi ? activePi : cfg.piServerUrl) || '';
    if (finalToken && finalChat) {
      await ensureEdgeTelegramWebhook(finalToken, origin, finalChat, finalPi, cfg, forceWebhookRefresh);
    }
  } catch {}
}

async function answerEdgeCallbackQueryFast(
  token: string,
  cbQueryId: string,
  lang: 'tl' | 'en'
): Promise<void> {
  if (!token || !cbQueryId) return;
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: cbQueryId,
      text: lang === 'en' ? 'Fetching live T.U.G.O.N. records...' : 'Kinukuha ang live records...',
    }),
  }).catch(() => null);
}

async function processEdgeTelegramUpdate(
  u: any,
  token: string,
  defaultChatId: string,
  allReports: any[],
  existingHistory: any[],
  knownChats: { id: string; title: string; type: string }[],
  allowReply: boolean,
  opts?: { callbackAlreadyAnswered?: boolean }
): Promise<boolean> {
  let mutated = false;

  const chat =
    u?.message?.chat ||
    u?.edited_message?.chat ||
    u?.callback_query?.message?.chat ||
    u?.my_chat_member?.chat ||
    u?.chat_member?.chat ||
    u?.channel_post?.chat;
  if (chat && chat.id !== undefined) {
    const idStr = String(chat.id);
    if (!knownChats.some((c) => c.id === idStr)) {
      const title =
        chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || idStr;
      knownChats.unshift({ id: idStr, title, type: chat.type || 'private' });
      mutated = true;
    }
  }

  if (!allowReply) return mutated;

  const phTime = getPhilippineDateTime();

  // 1. Handle Inline Cloud Bubble callback_query (e.g. tg_cmd:active, tg_cmd:summary, cloud_bubble:*, JSON payloads)
  const cbQuery = u?.callback_query;
  if (cbQuery?.id) {
    const rawCbData = String(cbQuery.data || '/active').trim();
    const parsedBubble = parseTelegramCloudBubblePayload(rawCbData);
    const bubbleLang: 'tl' | 'en' =
      parsedBubble.detectedLang || detectTelegramLanguage(parsedBubble.normalizedCommand, 'tl');

    if (!opts?.callbackAlreadyAnswered) {
      await answerEdgeCallbackQueryFast(token, cbQuery.id, bubbleLang);
    }

    const cbChat = cbQuery.message?.chat?.id !== undefined ? String(cbQuery.message.chat.id) : defaultChatId;
    if (cbChat) {
      const reply = generateBotChatReply(rawCbData || '/active', allReports, bubbleLang);
      const replyToMessageId =
        typeof cbQuery.message?.message_id === 'number' ? cbQuery.message.message_id : undefined;
      const messageThreadId =
        cbQuery.message?.is_topic_message && typeof cbQuery.message?.message_thread_id === 'number'
          ? cbQuery.message.message_thread_id
          : undefined;

      existingHistory.push({
        id: `tg-u-${u.update_id || Date.now()}`,
        sender: 'user',
        text: parsedBubble.displayLabel || '📋 Check Active Concerns / Unresolved',
        timestamp: phTime,
        source: 'telegram',
      });
      await sendEdgeTelegramMessage(
        token,
        cbChat,
        reply.textHtml,
        buildTelegramReplyMarkupForChat(bubbleLang, cbChat),
        { replyToMessageId, messageThreadId }
      );
      existingHistory.push({
        id: `tg-b-${u.update_id || Date.now()}`,
        sender: 'bot',
        text: reply.textPlain,
        timestamp: phTime,
        source: 'telegram',
        matchedIntent: reply.matchedIntent,
      });
      mutated = true;
    }
    return mutated;
  }

  // 2. Handle Persistent Reply Keyboard bubble taps, slash commands, JSON cloud bubble payloads, or chat text
  const incomingMsg = u?.message || u?.edited_message || u?.channel_post;
  const msgText = String(incomingMsg?.text || incomingMsg?.caption || '').trim();
  const msgChat = incomingMsg?.chat?.id !== undefined ? String(incomingMsg.chat.id) : '';
  const isFromBot = Boolean(u?.message?.from?.is_bot || u?.edited_message?.from?.is_bot);

  if (msgText && msgChat && !isFromBot) {
    const parsedBubble = parseTelegramCloudBubblePayload(msgText);
    const lang: 'tl' | 'en' =
      parsedBubble.detectedLang || detectTelegramLanguage(parsedBubble.normalizedCommand, 'tl');
    const reply = generateBotChatReply(msgText, allReports, lang);
    const replyToMessageId =
      typeof incomingMsg?.message_id === 'number' ? incomingMsg.message_id : undefined;
    const messageThreadId =
      incomingMsg?.is_topic_message && typeof incomingMsg?.message_thread_id === 'number'
        ? incomingMsg.message_thread_id
        : undefined;

    existingHistory.push({
      id: `tg-u-${u.update_id || Date.now()}`,
      sender: 'user',
      text: parsedBubble.displayLabel || msgText,
      timestamp: phTime,
      source: 'telegram',
    });
    await sendEdgeTelegramMessage(
      token,
      msgChat,
      reply.textHtml,
      buildTelegramReplyMarkupForChat(lang, msgChat),
      { replyToMessageId, messageThreadId }
    );
    existingHistory.push({
      id: `tg-b-${u.update_id || Date.now()}`,
      sender: 'bot',
      text: reply.textPlain,
      timestamp: phTime,
      source: 'telegram',
      matchedIntent: reply.matchedIntent,
    });
    mutated = true;
  }

  return mutated;
}

async function pollEdgeTelegramUpdatesOnce(
  token: string,
  defaultChatId: string,
  allReports: any[],
  cfg: PersistedEdgeConfig
): Promise<{ history: any[]; knownChats: { id: string; title: string; type: string }[] }> {
  const existingHistory = Array.isArray(cfg.telegramChatHistory) ? [...cfg.telegramChatHistory] : [];
  const knownChats = Array.isArray(cfg.knownTelegramChats) ? [...cfg.knownTelegramChats] : [];
  let offset = typeof cfg.telegramUpdateOffset === 'number' ? cfg.telegramUpdateOffset : 0;

  if (!token) return { history: existingHistory, knownChats };

  // If Telegram webhook is actively registered, do NOT call getUpdates (which returns 409)
  // or delete the webhook — webhook pushes updates in real time to POST /api/telegram/webhook.
  if (cfg.telegramWebhookUrl && cfg.telegramWebhookUrl.startsWith('https://')) {
    return { history: existingHistory, knownChats };
  }

  try {
    const offsetParam = offset > 0 ? `&offset=${offset}` : '';
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=25&timeout=0${offsetParam}`).catch(() => null);
    const data: any = res ? await res.json().catch(() => null) : null;

    if (res && (res.status === 409 || String(data?.description || '').toLowerCase().includes('webhook'))) {
      // Respect active Telegram webhook instead of tearing it down
      return { history: existingHistory, knownChats };
    }

    if (!res || !res.ok || !data?.ok || !Array.isArray(data.result) || data.result.length === 0) {
      return { history: existingHistory, knownChats };
    }

    const isBootstrap = offset === 0;
    const nowEpochSec = Math.floor(Date.now() / 1000);
    let mutated = false;

    for (const u of data.result) {
      if (typeof u?.update_id === 'number' && u.update_id >= offset) {
        offset = u.update_id + 1;
        mutated = true;
      }

      // On cold isolate restart (offset === 0), ALWAYS process inline cloud bubble callback_query
      // or recent messages (< 15 mins old), only skipping stale pre-existing backlog!
      const msgUnix = Number(
        u?.message?.date ||
          u?.edited_message?.date ||
          u?.channel_post?.date ||
          u?.callback_query?.message?.date ||
          0
      );
      const isRecentOrCallback = Boolean(u?.callback_query) || (msgUnix > 0 && nowEpochSec - msgUnix <= 900);
      const allowReply = !isBootstrap || isRecentOrCallback;

      const didMutate = await processEdgeTelegramUpdate(
        u,
        token,
        defaultChatId,
        allReports,
        existingHistory,
        knownChats,
        allowReply
      );
      if (didMutate) mutated = true;
    }

    if (mutated) {
      const capped = existingHistory.slice(-80);
      await saveEdgeConfig({
        telegramUpdateOffset: offset,
        telegramChatHistory: capped,
        knownTelegramChats: knownChats.slice(0, 20),
      });
      return { history: capped, knownChats };
    }
  } catch {}
  return { history: existingHistory, knownChats };
}

export const onRequest = async (context: PagesContext): Promise<Response> => {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers':
          'Content-Type, Authorization, X-Pi-Endpoint, X-Telegram-Token, X-Telegram-Chat-Id, ngrok-skip-browser-warning, Accept',
      },
    });
  }

  const reqUrl = new URL(request.url);
  const path = reqUrl.pathname;

  // 1. System Config Hydration
  if (path === '/api/config' && request.method === 'GET') {
    const cfg = await getEdgeConfig();
    const lockState = await getEdgeCloudLockState(env);
    const activePi =
      (lockState.locked && normalizeEdgePiUrl(lockState.lockedUrl)) ||
      (await resolveActivePiUrl(request, env));
    await syncEdgePiAndTelegramContext(request, env, reqUrl.origin, activePi);
    const updatedCfg = await getEdgeConfig();
    const tgToken = updatedCfg.telegramBotToken || env?.TELEGRAM_BOT_TOKEN || '';
    const tgChat = updatedCfg.telegramChatId || env?.TELEGRAM_CHAT_ID || '';
    const probe =
      activePi && !isPrivateHost(activePi)
        ? await probeRemotePi(activePi, false, reqUrl.origin)
        : { isLive: false };
    return jsonResponse({
      success: true,
      edgeMode: true,
      piServerUrl: activePi,
      piServerLocked: lockState.locked,
      piServerLockSource: lockState.source,
      piOnline: probe.isLive,
      telegramConfigured: Boolean(tgToken && tgChat),
      telegramSetupComplete: Boolean(tgToken && tgChat),
      telegramLocked: Boolean(updatedCfg.telegramLocked),
      telegramChatId: tgChat,
      hasCustomPassword: Boolean(updatedCfg.kagawadCustomPassword),
      ...(() => {
        const aiKeys = resolveEdgeAiProviderKeys(env);
        return {
          geminiConfigured: Boolean(aiKeys.geminiKey || aiKeys.openRouterKey || aiKeys.groqKey),
          geminiEnvKeysDetected: aiKeys.detectedKeyNames,
        };
      })(),
      portalRevision: Number(updatedCfg.portalRevision || 0),
    });
  }

  // 1b. Auth Verification & Password Change
  if (path === '/api/auth/verify' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const cfg = await getEdgeConfig();
    const result = verifyTugonCredentials(
      body?.username,
      body?.password,
      cfg.kagawadCustomPassword
    );
    return jsonResponse({
      success: result.valid,
      username: result.username,
      role: result.role,
      label: result.label,
      isAdmin: result.isAdmin,
    });
  }

  if (path === '/api/auth/password' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const isEn = body?.lang === 'en';
    const cleanOld = String(body?.oldPassword || '').trim();
    const cleanNew = String(body?.newPassword || '').trim();
    const cfg = await getEdgeConfig();
    const isOldValid = verifyTugonCredentials(
      body?.username || undefined,
      cleanOld,
      cfg.kagawadCustomPassword
    ).valid;

    if (!isOldValid) {
      return jsonResponse(
        {
          success: false,
          error: isEn ? 'Incorrect current password.' : 'Mali ang kasalukuyang lumang password.',
        },
        400
      );
    }
    if (cleanNew.length < 8) {
      return jsonResponse(
        {
          success: false,
          error: isEn
            ? 'New password must be at least 8 characters long.'
            : 'Ang bagong password ay dapat hindi bababa sa 8 characters.',
        },
        400
      );
    }
    await saveEdgeConfig({ kagawadCustomPassword: cleanNew });
    return jsonResponse({ success: true });
  }

  // 2. Ping & Bind Raspberry Pi Cloud Server URL
  if (path === '/api/pi/ping' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const isEn = body?.lang === 'en';
    const rawUrl = String(body?.url || '').trim();

    if (isBareTunnelRoot(rawUrl)) {
      return jsonResponse(
        {
          success: false,
          online: false,
          error: isEn
            ? 'Missing full Cloud Server subdomain (e.g. https://pi.tugon-brgy40-41.org). Please enter the full server URL.'
            : 'Kulang ng sariling subdomain ang link (hal. https://pi.tugon-brgy40-41.org). Pakilagay ang buong server URL.',
        },
        400
      );
    }

    const target = normalizeEdgePiUrl(rawUrl);
    if (!target || !isValidUrlSyntax(target, reqUrl.origin)) {
      return jsonResponse(
        {
          success: false,
          online: false,
          error: isEn
            ? 'Invalid Cloud Server link. Please enter a valid server URL.'
            : 'Hindi valid ang inilagay na Cloud Server link. Pakisuri ang URL.',
        },
        400
      );
    }

    const lockState = await getEdgeCloudLockState(env);
    if (lockState.locked && !isUrlAllowedUnderLock(target, lockState)) {
      return jsonResponse(
        {
          success: false,
          online: false,
          locked: true,
          error: isEn
            ? `Cloud Server binding is locked to ${lockState.lockedUrl}. Unlock with Admin credentials first.`
            : `Naka-LOCK ang Cloud Server link sa ${lockState.lockedUrl}. I-unlock muna gamit ang Admin password.`,
        },
        403
      );
    }

    const probe = await probeRemotePi(target, isEn, reqUrl.origin);
    if (probe.isLive) {
      await saveEdgeConfig({ piServerUrl: target });
      // Sync any cached reports with Pi honoring tombstones
      const deletedIds = await syncTombstonesFromPi(target);
      const cachedReports = await getEdgeReports();
      const piReportsRes = await fetchPiReportsArray(target);
      if (piReportsRes.isArray) {
        const merged = mergeReportsLists(cachedReports, piReportsRes.list, deletedIds);
        await saveEdgeReports(merged);
      }
      await syncEdgePiAndTelegramContext(request, env, reqUrl.origin, target, body, true);

      return jsonResponse({
        success: true,
        online: true,
        normalizedUrl: target,
        latencyMs: probe.latencyMs,
        url: target,
        lastPingAt: new Date().toISOString(),
        method: detectMethod(target),
        mode: probe.mode || 'PULSE_SERVER',
        piData: probe.data,
        message: isEn
          ? `Connected to Cloud Server! (${probe.latencyMs}ms)`
          : `Konektado sa Cloud Server! (${probe.latencyMs}ms)`,
      });
    }

    return jsonResponse({
      success: false,
      online: false,
      normalizedUrl: target,
      isPrivateLanIp: isPrivateHost(target),
      error:
        probe.errorDetail ||
        (isEn
          ? `Cannot reach Cloud Server at ${target}.`
          : `Hindi maabot ang Cloud Server sa ${target}.`),
    });
  }

  // 2b. Client LAN Bridge
  if (path === '/api/pi/client-bridge' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const cleanUrl = normalizeEdgePiUrl(body?.url || '');
    if (!cleanUrl) {
      return jsonResponse({ success: false, error: 'Invalid bridge URL' }, 400);
    }
    const lockState = await getEdgeCloudLockState(env);
    if (lockState.locked && !isUrlAllowedUnderLock(cleanUrl, lockState)) {
      return jsonResponse(
        { success: false, error: 'Cloud Server binding is locked. External bridge override rejected.' },
        403
      );
    }
    await saveEdgeConfig({ piServerUrl: cleanUrl });
    const deletedIds = Array.isArray(body?.piData?.deletedReportIds)
      ? await recordEdgeDeletedKeys(body.piData.deletedReportIds)
      : (await getEdgeConfig()).deletedReportIds;
    const existing = await getEdgeReports();
    const merged = Array.isArray(body?.piReports)
      ? mergeReportsLists(existing, body.piReports, deletedIds)
      : existing.filter((r) => !isEdgeReportTombstoned(r, new Set(deletedIds || [])));
    await saveEdgeReports(merged);
    await syncTelegramSnapshotToPi(cleanUrl, merged);
    await syncEdgePiAndTelegramContext(request, env, reqUrl.origin, cleanUrl, body, true);
    const rev = await bumpEdgePortalRevision(Number(body?.piData?.portalRevision || 0));
    return jsonResponse(
      {
        success: true,
        online: true,
        normalizedUrl: cleanUrl,
        reports: merged,
        reportsCount: merged.length,
        revision: rev,
      },
      200,
      { 'X-Portal-Revision': String(rev) }
    );
  }

  // 2c. Lock or Unlock Cloud Server Binding (Admin protected)
  if (path === '/api/pi/lock' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const isEn = body?.lang === 'en';
    const wantLock = Boolean(body?.lock);
    const adminPassword = String(body?.adminPassword || '').trim();
    const cfg = await getEdgeConfig();
    const candidateUrl = normalizeEdgePiUrl(
      body?.url || cfg.piServerUrl || env?.PI_SERVER_URL || env?.VITE_PI_SERVER_URL || ''
    );

    if (!isAuthorizedAdminPassword(adminPassword)) {
      return jsonResponse(
        {
          success: false,
          error: isEn
            ? 'Valid Admin password is required to modify Cloud Server Lock.'
            : 'Kailangan ng wastong Admin password upang baguhin ang Cloud Server Lock.',
        },
        403
      );
    }

    const currentLock = await getEdgeCloudLockState(env);
    if (
      !wantLock &&
      (currentLock.source === 'hardcoded' ||
        currentLock.source === 'config_file' ||
        currentLock.source === 'env')
    ) {
      return jsonResponse(
        {
          success: false,
          error: isEn
            ? 'Cloud Server link is permanently locked in system configuration.'
            : 'Ang Cloud Server link ay permanenteng naka-lock sa configuration ng system.',
        },
        403
      );
    }

    if (wantLock && !candidateUrl) {
      return jsonResponse(
        {
          success: false,
          error: isEn
            ? 'Connect a valid Cloud Server URL before locking.'
            : 'Ikonekta muna ang isang valid na Cloud Server URL bago i-lock.',
        },
        400
      );
    }

    await saveEdgeConfig({
      ...(wantLock && candidateUrl ? { piServerUrl: candidateUrl } : {}),
      piServerLocked: wantLock,
    });

    const updated = await getEdgeCloudLockState(env);
    return jsonResponse({
      success: true,
      locked: updated.locked,
      lockedUrl: updated.lockedUrl,
      source: updated.source,
      message: wantLock
        ? isEn
          ? `Cloud Server binding locked to ${updated.lockedUrl}.`
          : `Nai-lock na ang Cloud Server link sa ${updated.lockedUrl}.`
        : isEn
          ? 'Cloud Server binding unlocked.'
          : 'Na-unlock na ang Cloud Server binding.',
    });
  }

  // 3. Disconnect Raspberry Pi Link
  if (path === '/api/pi/disconnect' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const isEn = body?.lang === 'en';
    const lockState = await getEdgeCloudLockState(env);
    if (lockState.locked && !isAuthorizedAdminPassword(body?.adminPassword)) {
      return jsonResponse(
        {
          success: false,
          error: isEn
            ? 'Cloud Server binding is locked. Unlock with Admin credentials first.'
            : 'Naka-lock ang Cloud Server binding. I-unlock muna gamit ang Admin password.',
        },
        403
      );
    }
    await saveEdgeConfig({ piServerUrl: '', piServerLocked: false });
    return jsonResponse({ success: true });
  }

  // 4. Live Pi Status
  if (path === '/api/pi-status' && request.method === 'GET') {
    const isEn = reqUrl.searchParams.get('lang') === 'en';
    const activePi = await resolveActivePiUrl(request, env);
    const cachedReports = await getEdgeReports();
    const cachedLogs = await getEdgeLogbooks();

    if (!activePi) {
      return jsonResponse({
        hardware: 'Cloud Storage Server',
        ram: 'Standby',
        storageUsedMb: 0,
        storage_folder: isEn ? 'No Cloud Server Configured' : 'Walang Naka-set na Cloud Server',
        disk_total: '0 GB',
        disk_used: '0 GB',
        disk_free: '0 GB',
        pulseFolderMb: 0,
        pulseFolderKb: 0,
        residentPhotosCount: 0,
        residentPhotosMb: 0,
        proofPhotosCount: 0,
        proofPhotosMb: 0,
        cachedImagesCount: 0,
        activeTicketsCount: cachedReports.length,
        pendingTicketsCount: cachedReports.filter((r) => r?.status === 'PENDING').length,
        autoPurgeTtlDays: AUTO_PURGE_TTL_DAYS,
        cpuTempCelsius: 0,
        ipAddress: 'Not Set',
        localHostname: 'cloud-server.local',
        lastPurgeRun: '',
        savedLogbooksCount: cachedLogs.length,
        online: false,
        isConfigured: false,
        configuredUrl: '',
        latencyMs: 0,
        connectionMethod: isEn ? 'Not Set' : 'Walang Naka-set',
      });
    }

    const probe = await probeRemotePi(activePi, isEn, reqUrl.origin);
    if (!probe.isLive) {
      return jsonResponse({
        hardware: 'Cloud Storage Server',
        ram: 'Offline',
        storageUsedMb: 0,
        storage_folder: `DISCONNECTED (${activePi})`,
        disk_total: '0 GB',
        disk_used: '0 GB',
        disk_free: '0 GB',
        pulseFolderMb: 0,
        pulseFolderKb: 0,
        residentPhotosCount: 0,
        residentPhotosMb: 0,
        proofPhotosCount: 0,
        proofPhotosMb: 0,
        cachedImagesCount: 0,
        activeTicketsCount: cachedReports.length,
        pendingTicketsCount: cachedReports.filter((r) => r?.status === 'PENDING').length,
        autoPurgeTtlDays: AUTO_PURGE_TTL_DAYS,
        cpuTempCelsius: 0,
        ipAddress: activePi,
        localHostname: 'cloud-server.local',
        lastPurgeRun: '',
        savedLogbooksCount: cachedLogs.length,
        online: false,
        isConfigured: true,
        configuredUrl: activePi,
        latencyMs: 0,
        connectionMethod: 'Disconnected',
        errorDetail: probe.errorDetail,
      });
    }

    const d = probe.data || {};
    const resPhotos = cachedReports.reduce((acc, r) => acc + (r?.photos?.length || 0), 0);
    const prfPhotos = cachedReports.reduce((acc, r) => acc + (r?.proofPhotos?.length || 0), 0);
    const estMb = +(resPhotos * 0.8 + prfPhotos * 0.75 + cachedReports.length * 0.02).toFixed(2);
    const folderMb = d.pulse_folder_mb ?? estMb;

    return jsonResponse({
      hardware: d.hardware || 'Cloud Storage Server',
      ram: d.ram || 'Active (Healthy)',
      storageUsedMb: folderMb,
      storage_folder: d.storage_folder || 'Cloud Storage Database',
      disk_total: d.disk_total || '500.0 GB',
      disk_used: d.disk_used || '20.0 GB',
      disk_free: d.disk_free || '480.0 GB',
      pulseFolderMb: folderMb,
      pulseFolderKb: d.pulse_folder_kb ?? Math.round(folderMb * 1024),
      residentPhotosCount: d.resident_photos_count ?? resPhotos,
      residentPhotosMb: +(resPhotos * 0.8).toFixed(2),
      proofPhotosCount: d.proof_photos_count ?? prfPhotos,
      proofPhotosMb: +(prfPhotos * 0.75).toFixed(2),
      cachedImagesCount: resPhotos + prfPhotos,
      activeTicketsCount: d.reports_count ?? cachedReports.length,
      pendingTicketsCount: cachedReports.filter((r) => r?.status === 'PENDING').length,
      autoPurgeTtlDays: Number(d.autoPurgeTtlDays ?? AUTO_PURGE_TTL_DAYS),
      cpu_temp: d.cpu_temp || '42.0\u00B0C',
      cpuTempCelsius: d.cpuTempCelsius || parseFloat(d.cpu_temp) || 42,
      ipAddress: d.lan_ip || activePi,
      localHostname: d.hostname || 'raspberrypi.local',
      lastPurgeRun: new Date().toISOString(),
      savedLogbooksCount: Math.max(cachedLogs.length, Number(d.logbooks_count || d.saved_logbooks_count || 0)),
      online: true,
      isConfigured: true,
      configuredUrl: activePi,
      latencyMs: probe.latencyMs,
      connectionMethod: detectMethod(activePi),
      serverMode: probe.mode || 'PULSE_SERVER',
    });
  }

  // 5. Reports, Sync, Logbooks, Power, and Telegram
  const activePi = await resolveActivePiUrl(request, env);

  if (path === '/api/portal/events' && request.method === 'GET') {
    if (activePi && !isPrivateHost(activePi)) {
      try {
        const piSseRes = await fetch(`${activePi}/api/portal/events`, {
          headers: {
            ...PI_EDGE_HEADERS,
            Accept: 'text/event-stream',
          },
        });
        if (piSseRes.ok && piSseRes.body) {
          return new Response(piSseRes.body, {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache, no-store, must-revalidate',
              'Access-Control-Allow-Origin': '*',
            },
          });
        }
      } catch {}
    }
    const cfg = await getEdgeConfig();
    const rev = Number(cfg.portalRevision || 0);
    const initPayload = `retry: 4000\nevent: portal-sync\ndata: ${JSON.stringify({
      type: 'portal:init',
      revision: rev,
      updatedAt: new Date().toISOString(),
    })}\n\n`;
    return new Response(initPayload, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  if (path === '/api/reports' && request.method === 'GET') {
    const reqLang: 'tl' | 'en' = reqUrl.searchParams.get('lang') === 'en' ? 'en' : 'tl';
    const feedFilter = reqUrl.searchParams.get('feed');
    await syncEdgePiAndTelegramContext(request, env, reqUrl.origin, activePi);
    let cfg = await getEdgeConfig();
    const cachedReports = await getEdgeReports();
    let piOnline = false;
    let combined = cachedReports;
    let currentRevision = Number(cfg.portalRevision || 0);

    // Raspberry Pi is the authoritative Barangay Portal database when reachable —
    // pull Pi tombstones + Pi reports so edits, statuses, and deletes sync cleanly across all devices.
    if (activePi && !isPrivateHost(activePi)) {
      const [piTombstones, piRes] = await Promise.all([
        syncTombstonesFromPi(activePi),
        fetchPiReportsArray(activePi),
      ]);
      cfg = await getEdgeConfig();
      currentRevision = Math.max(
        currentRevision,
        Number(cfg.portalRevision || 0),
        Number(piRes.revision || 0)
      );
      if (piRes.ok) {
        piOnline = true;
        if (piRes.isArray) {
          const tombstones = new Set(Array.isArray(piTombstones) ? piTombstones : cfg.deletedReportIds || []);
          combined = piRes.list.filter((r) => !isEdgeReportTombstoned(r, tombstones));
          await saveEdgeReports(combined);
          if (currentRevision > Number(cfg.portalRevision || 0)) {
            await saveEdgeConfig({ portalRevision: currentRevision });
          }
        }
      }
    }

    let output = combined.map((r) => {
      const purgeInfo = computeUnifiedPurgeInfo(r, reqLang);
      return {
        ...r,
        ticketNumber: formatEdgeTicket(r?.ticketNumber) || r?.ticketNumber,
        ...purgeInfo,
      };
    });
    const idsParam = reqUrl.searchParams.get('ids');
    if (idsParam !== null) {
      const rawIds = idsParam.split(',').map((s) => s.trim()).filter(Boolean);
      const ids = new Set(rawIds);
      const normalizedIds = new Set(rawIds.map((s) => formatEdgeTicket(s).toUpperCase()).filter(Boolean));
      output =
        ids.size === 0
          ? []
          : output.filter(
              (r) =>
                ids.has(String(r?.id)) ||
                ids.has(String(r?.ticketNumber)) ||
                normalizedIds.has(formatEdgeTicket(r?.ticketNumber).toUpperCase())
            );
    } else if (feedFilter === 'active') {
      output = output.filter((r) => !r.isPurgedFromFeed);
    } else if (feedFilter === 'purged') {
      output = output.filter((r) => r.isPurgedFromFeed);
    }

    return jsonResponse(output, 200, {
      'X-Pi-Online': piOnline ? 'true' : 'false',
      'X-Portal-Revision': String(currentRevision),
    });
  }

  if (path === '/api/reports' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const isEn = body?.lang === 'en';
    if (!activePi || isPrivateHost(activePi)) {
      return jsonResponse(
        {
          success: false,
          piOffline: true,
          edgeNeedsDirectClient: isPrivateHost(activePi),
          error: isEn
            ? 'Cloud Server is not connected.'
            : 'Hindi pa nakakonekta ang Cloud Server.',
        },
        503
      );
    }

    const probe = await probeRemotePi(activePi, isEn, reqUrl.origin);
    if (!probe.isLive) {
      return jsonResponse(
        {
          success: false,
          piOffline: true,
          error:
            probe.errorDetail ||
            (isEn
              ? 'Cloud Server is currently offline.'
              : 'Offline ngayon ang Cloud Server.'),
        },
        503
      );
    }

    const cached = await getEdgeReports();
    const piRes = await fetchPiReportsArray(activePi);
    const existing = piRes.ok && piRes.isArray ? piRes.list : cached;
    const nowIso = new Date().toISOString();
    const nextRevision = await bumpEdgePortalRevision(piRes.revision);

    const newReport = {
      ...body,
      id: body.id || `rep-${Date.now()}`,
      ticketNumber: formatEdgeTicket(body.ticketNumber) || `TUGON-CAV-${String(Date.now()).slice(-4)}`,
      localSyncStatus: 'SENT_TO_PI',
      status: body.status || 'PENDING',
      createdAt: body.createdAt || nowIso,
      updatedAt: body.updatedAt || nowIso,
      portalRevision: nextRevision,
      sourceStorage: 'Cloud Storage',
    };
    delete newReport.clientSyncedToPi;
    delete newReport.lang;

    const merged = mergeReportsLists([newReport], existing);
    const pushed = await pushReportsToRemotePi(activePi, merged, newReport);
    if (!pushed) {
      return jsonResponse({ success: false, piOffline: true }, 503);
    }

    await saveEdgeReports(merged);
    await syncTelegramSnapshotToPi(activePi, merged);
    await syncEdgePiAndTelegramContext(request, env, reqUrl.origin, activePi, body);

    // Strictly send 2 Telegram messages (Message 1: New Concern Info, Message 2: Active & Unresolved List)
    // Always awaited so Cloudflare Workers never aborts the dispatch!
    const cfg = await getEdgeConfig();
    const { token: tgToken, chatId: tgChat } = await resolveEdgeTelegramCreds(
      request,
      env,
      cfg,
      activePi,
      body
    );
    const tgDelivery = await dispatchEdgeNewConcern2Messages(
      tgToken,
      tgChat,
      newReport,
      merged,
      isEn ? 'en' : 'tl',
      cfg
    );

    return jsonResponse(
      {
        success: true,
        report: newReport,
        revision: nextRevision,
        telegramNotified: tgDelivery.notified,
        telegramMessagesSent: tgDelivery.count,
      },
      201,
      { 'X-Portal-Revision': String(nextRevision) }
    );
  }

  if (path.startsWith('/api/reports/') && (request.method === 'PATCH' || request.method === 'DELETE')) {
    const remainder = path.slice('/api/reports/'.length).replace(/\/status$/, '').replace(/\/+$/, '');
    const targetId = decodeURIComponent(remainder);
    const targetTicket = formatEdgeTicket(targetId).toUpperCase();
    await syncEdgePiAndTelegramContext(request, env, reqUrl.origin, activePi);
    const cached = await getEdgeReports();
    const piRes = activePi && !isPrivateHost(activePi) ? await fetchPiReportsArray(activePi) : { ok: false, isArray: false, list: [], revision: 0 };
    const currentList = piRes.ok && piRes.isArray ? piRes.list : cached;

    if (request.method === 'DELETE') {
      const keysToTombstone = new Set(extractEdgeKeys(targetId));
      const filtered = currentList.filter((r) => {
        const isMatch =
          r?.id === targetId ||
          r?.ticketNumber === targetId ||
          (targetTicket && formatEdgeTicket(r?.ticketNumber).toUpperCase() === targetTicket);
        if (isMatch) {
          for (const k of extractEdgeKeys(r)) keysToTombstone.add(k);
          return false;
        }
        return true;
      });
      await recordEdgeDeletedKeys(Array.from(keysToTombstone));
      await saveEdgeReports(filtered);
      const nextRevision = await bumpEdgePortalRevision(piRes.revision);
      if (activePi && !isPrivateHost(activePi)) {
        await fetch(`${activePi}/api/reports?id=${encodeURIComponent(targetId)}`, {
          method: 'DELETE',
          headers: PI_EDGE_HEADERS,
        }).catch(() => null);
      }
      return jsonResponse(
        { success: true, deletedId: targetId, revision: nextRevision },
        200,
        { 'X-Portal-Revision': String(nextRevision) }
      );
    }

    const patchBody: any = await request.json().catch(() => ({}));
    const nowIso = new Date().toISOString();
    const nextRevision = await bumpEdgePortalRevision(piRes.revision);
    let updatedReport: any = null;

    const editableStringFields = [
      'residentName',
      'residentPhone',
      'barangay',
      'purok',
      'streetAddress',
      'houseNumber',
      'landmark',
      'notes',
      'extraMessage',
      'severityLevel',
      'urgency',
      'dispatchedKagawad',
      'resolvedBy',
      'resolutionNotes',
      'proofKagawadName',
      'cancellationReason',
    ];
    const editableBoolFields = [
      'isElderly',
      'isWithinJurisdiction',
      'needsAssistanceOutside',
      'isWithinBrgy41',
    ];

    const nextList = currentList.map((r) => {
      if (
        r?.id === targetId ||
        r?.ticketNumber === targetId ||
        (targetTicket && formatEdgeTicket(r?.ticketNumber).toUpperCase() === targetTicket)
      ) {
        const next: Record<string, any> = {
          ...r,
          ticketNumber: formatEdgeTicket(r?.ticketNumber) || r?.ticketNumber,
          updatedAt: nowIso,
          portalRevision: nextRevision,
        };
        for (const field of editableStringFields) {
          if (patchBody[field] !== undefined) next[field] = patchBody[field];
        }
        for (const bField of editableBoolFields) {
          if (typeof patchBody[bField] === 'boolean') next[bField] = patchBody[bField];
        }
        if (Array.isArray(patchBody.proofPhotos)) next.proofPhotos = patchBody.proofPhotos;

        if (patchBody.status) {
          next.status = patchBody.status;
          if (patchBody.status === 'PENDING') {
            delete next.dispatchedAt;
            if (patchBody.dispatchedKagawad === undefined) delete next.dispatchedKagawad;
          } else if (patchBody.status === 'DISPATCHED') {
            next.dispatchedAt = patchBody.dispatchedAt || next.dispatchedAt || nowIso;
            next.dispatchedKagawad = patchBody.dispatchedKagawad || next.dispatchedKagawad || 'Barangay Official';
          } else if (patchBody.status === 'RESOLVED') {
            next.resolvedAt = patchBody.resolvedAt || nowIso;
            next.resolvedBy = patchBody.resolvedBy || next.resolvedBy || 'Barangay Official';
            next.proofSubmittedAt = patchBody.proofSubmittedAt || nowIso;
          } else if (patchBody.status === 'CANCELLED') {
            next.cancelledAt = patchBody.cancelledAt || nowIso;
            next.cancellationReason = patchBody.cancellationReason || next.cancellationReason || 'Cancelled';
          }
        }
        updatedReport = next;
        return next;
      }
      return r;
    });

    if (!updatedReport) {
      return jsonResponse({ success: false, error: 'Report not found' }, 404);
    }

    await saveEdgeReports(nextList);
    if (activePi && !isPrivateHost(activePi)) {
      const piPatchRes = await fetch(`${activePi}/api/reports/${encodeURIComponent(targetId)}/status`, {
        method: 'PATCH',
        headers: { ...PI_EDGE_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...patchBody,
          updatedAt: nowIso,
          portalRevision: nextRevision,
        }),
      }).catch(() => null);
      if (!piPatchRes || !piPatchRes.ok) {
        await pushReportsToRemotePi(activePi, nextList, updatedReport);
      }
    }

    let telegramNotified = false;
    if (patchBody?.status === 'RESOLVED') {
      const cfg = await getEdgeConfig();
      const { token: tgToken, chatId: tgChat } = await resolveEdgeTelegramCreds(
        request,
        env,
        cfg,
        activePi,
        patchBody
      );
      if (tgToken && tgChat) {
        const reqLang: 'tl' | 'en' = patchBody?.lang === 'en' ? 'en' : 'tl';
        const phTime = getPhilippineDateTime();
        const msg1 = buildResolvedConcernMessage1Html(updatedReport, reqLang, phTime);
        const msg2 = buildActiveUnresolvedConcernsMessage2Html(nextList, reqLang, 'ACTIVE');
        const m1 = await sendEdgeTelegramMessage(tgToken, tgChat, msg1);
        const m2 = await sendEdgeTelegramMessage(
          tgToken,
          tgChat,
          msg2,
          buildTelegramReplyMarkupForChat(reqLang, tgChat)
        );
        telegramNotified = m1.ok || m2.ok;
      }
    }
    await syncTelegramSnapshotToPi(activePi, nextList);

    return jsonResponse(
      { success: true, report: updatedReport, revision: nextRevision, telegramNotified },
      200,
      { 'X-Portal-Revision': String(nextRevision) }
    );
  }

  if (path === '/api/reports/clear-all' && request.method === 'POST') {
    const existing = await getEdgeReports();
    const keys = existing.flatMap((r) => extractEdgeKeys(r));
    if (keys.length > 0) await recordEdgeDeletedKeys(keys);
    await saveEdgeReports([]);
    const nextRevision = await bumpEdgePortalRevision();
    if (activePi && !isPrivateHost(activePi)) {
      await fetch(`${activePi}/api/reports/clear-all`, {
        method: 'POST',
        headers: { ...PI_EDGE_HEADERS, 'Content-Type': 'application/json' },
      }).catch(() => null);
    }
    return jsonResponse(
      { success: true, revision: nextRevision },
      200,
      { 'X-Portal-Revision': String(nextRevision) }
    );
  }

  if (path === '/api/pi/sync' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const isEn = body?.lang === 'en';
    const target = normalizeEdgePiUrl(body?.url || activePi);
    const probe = await probeRemotePi(target, isEn, reqUrl.origin);
    if (!probe.isLive) {
      return jsonResponse({
        success: false,
        online: false,
        error: probe.errorDetail || (isEn ? 'Cannot reach Cloud Server.' : 'Hindi maabot ang Cloud Server.'),
      });
    }
    const deletedIds = await syncTombstonesFromPi(target);
    const cached = await getEdgeReports();
    const piRes = await fetchPiReportsArray(target);
    const merged = piRes.isArray ? mergeReportsLists(cached, piRes.list, deletedIds) : cached;
    await saveEdgeReports(merged);
    await pushReportsToRemotePi(target, merged);

    return jsonResponse({
      success: true,
      online: true,
      synced: true,
      count: merged.length,
      message: isEn
        ? `Successfully synced ${merged.length} report(s) with Cloud Storage!`
        : `Matagumpay na na-sync ang ${merged.length} ulat sa Cloud Storage!`,
    });
  }

  // Logbook Endpoints
  if (path === '/api/pi/save-logbook' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const isEn = body?.lang === 'en';
    const phTime = getPhilippineDateTime();
    const nowIso = new Date().toISOString();
    const reports = await getEdgeReports();
    const targetUrl = normalizeEdgePiUrl(body?.piEndpoint || activePi);

    const logbookId = `LOG-${Date.now()}`;
    const filename = `TUGON_Logbook_Brgy40_41_${nowIso.slice(0, 10)}_${Date.now().toString().slice(-4)}.json`;
    let syncStatus: 'SYNCED' | 'LOCAL_ONLY' = body?.clientSyncedToPi ? 'SYNCED' : 'LOCAL_ONLY';

    if (!body?.clientSyncedToPi && targetUrl && !isPrivateHost(targetUrl)) {
      const piSave = await fetch(`${targetUrl}/api/logbook/save`, {
        method: 'POST',
        headers: { ...PI_EDGE_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          logbookId,
          filename,
          savedAt: nowIso,
          savedAtPhilippineTime: phTime,
          savedBy: body?.savedBy || 'Barangay 40 & 41 Official',
          totalRecords: reports.length,
          reports,
        }),
      }).catch(() => null);
      if (piSave && piSave.ok) syncStatus = 'SYNCED';
    }

    const pendingRecords = reports.filter((r) => r?.status === 'PENDING').length;
    const dispatchedRecords = reports.filter((r) => r?.status === 'DISPATCHED').length;
    const resolvedRecords = reports.filter((r) => r?.status === 'RESOLVED').length;
    const cancelledRecords = reports.filter((r) => r?.status === 'CANCELLED').length;
    const brgy40Count = reports.filter((r) => r?.barangay?.includes('40') || r?.purok?.includes('40')).length;
    const brgy41Count = reports.length - brgy40Count;

    const newLogBook = {
      id: logbookId,
      filename,
      savedAt: nowIso,
      savedAtPhilippineTime: phTime,
      totalRecords: reports.length,
      pendingRecords,
      dispatchedRecords,
      resolvedRecords,
      cancelledRecords,
      brgy40Count,
      brgy41Count,
      storageUsedMb: +(reports.length * 0.5).toFixed(2),
      savedBy: body?.savedBy || (isEn ? 'Barangay 40 & 41 Official' : 'Barangay 40 & 41 Kagawad'),
      destination: 'Cloud Storage Server',
      syncStatus,
      recordsSummary: isEn
        ? `${reports.length} total records (Pending: ${pendingRecords}, Resolved: ${resolvedRecords})`
        : `${reports.length} kabuuang tala (Pending: ${pendingRecords}, Resolved: ${resolvedRecords})`,
      recordsSnapshot: reports,
    };

    const existingLogs = await getEdgeLogbooks();
    await saveEdgeLogbooks([newLogBook, ...existingLogs]);

    return jsonResponse({
      success: true,
      logbook: newLogBook,
      message: isEn
        ? `Log Book saved and synced! (${phTime})`
        : `Matagumpay na na-save at na-sync ang Log Book! (${phTime})`,
    });
  }

  if (path === '/api/pi/saved-logbooks' && request.method === 'GET') {
    const logs = await getEdgeLogbooks();
    return jsonResponse({
      success: true,
      count: logs.length,
      logbooks: logs.map((l) => ({ ...l, recordsSnapshot: undefined })),
    });
  }

  if (path.startsWith('/api/pi/download-logbook/') && request.method === 'GET') {
    const id = decodeURIComponent(path.slice('/api/pi/download-logbook/'.length));
    const logs = await getEdgeLogbooks();
    const found = logs.find((l) => l.id === id || l.filename === id);
    if (!found) return jsonResponse({ error: 'Logbook not found' }, 404);
    return jsonResponse(found, 200, {
      'Content-Disposition': `attachment; filename="${found.filename}"`,
    });
  }

  if (path.startsWith('/api/pi/logbooks/') && request.method === 'DELETE') {
    const id = decodeURIComponent(path.slice('/api/pi/logbooks/'.length));
    const logs = await getEdgeLogbooks();
    const next = logs.filter((l) => l.id !== id && l.filename !== id);
    await saveEdgeLogbooks(next);
    return jsonResponse({ success: true, deletedId: id });
  }

  // Telegram Bot Endpoints on Edge
  if (path === '/api/telegram/status' && request.method === 'GET') {
    await syncEdgePiAndTelegramContext(request, env, reqUrl.origin, activePi);
    const cfg = await getEdgeConfig();
    const qToken = (reqUrl.searchParams.get('token') || '').trim();
    const qChat = (reqUrl.searchParams.get('chatId') || '').trim();
    const token = qToken || cfg.telegramBotToken || env?.TELEGRAM_BOT_TOKEN || '';
    const chatId = qChat || cfg.telegramChatId || env?.TELEGRAM_CHAT_ID || '';
    let isLocked = Boolean(cfg.telegramLocked);
    if (!cfg.telegramLocked && activePi && !isPrivateHost(activePi)) {
      try {
        const piCfgRes = await fetch(`${activePi}/api/config`, { headers: PI_EDGE_HEADERS }).catch(() => null);
        if (piCfgRes && piCfgRes.ok) {
          const piCfg: any = await piCfgRes.json().catch(() => null);
          if (typeof piCfg?.telegramLocked === 'boolean') {
            isLocked = piCfg.telegramLocked;
            if (isLocked) await saveEdgeConfig({ telegramLocked: true });
          }
        }
      } catch {}
    }
    const reports = await getLiveReportsForTelegramBot(activePi, 5500);
    const phTime = getPhilippineDateTime();

    if (token && chatId && !isLocked && (cfg.telegramBotToken !== token || cfg.telegramChatId !== chatId || (activePi && !isPrivateHost(activePi) && cfg.piServerUrl !== activePi))) {
      await saveEdgeConfig({
        telegramBotToken: token,
        telegramChatId: chatId,
        telegramSetupComplete: true,
        ...(activePi && !isPrivateHost(activePi) ? { piServerUrl: activePi } : {}),
      });
    }

    if (!token) {
      return jsonResponse({
        online: false,
        status: 'NOT_CONFIGURED',
        botConfigured: false,
        setupComplete: false,
        locked: isLocked,
        chatId: '',
        botUsername: '',
        botFirstName: '',
        autoRestartCount: 0,
        reconnectAttempts: 0,
        lastCheckedAt: phTime,
        lastSeenOnline: '',
        lastError: '',
        watchdogActive: true,
        lastBroadcastMessage: cfg.lastBroadcastMessage || '',
        lastBroadcastTime: cfg.lastBroadcastTime || '',
        broadcastHistory: cfg.broadcastHistory || [],
        philippineTime: phTime,
        pendingCount: reports.filter((r) => String(r?.status || 'PENDING').toUpperCase() === 'PENDING').length,
        activeUnfinishedCount: reports.filter((r) => {
          const st = String(r?.status || 'PENDING').toUpperCase();
          return st === 'PENDING' || st === 'DISPATCHED';
        }).length,
      });
    }

    const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`).catch(() => null);
    const meJson: any = meRes ? await meRes.json().catch(() => null) : null;
    const isOnline = Boolean(meRes?.ok && meJson?.ok);

    if (isOnline && chatId) {
      await ensureEdgeTelegramWebhook(token, reqUrl.origin, chatId, activePi, await getEdgeConfig());
    }

    return jsonResponse({
      online: isOnline,
      status: isOnline ? 'ONLINE' : 'OFFLINE',
      botConfigured: Boolean(token && chatId),
      setupComplete: Boolean(isOnline && chatId),
      locked: isLocked,
      chatId,
      botUsername: meJson?.result?.username || '',
      botFirstName: meJson?.result?.first_name || '',
      autoRestartCount: 0,
      reconnectAttempts: 0,
      lastCheckedAt: phTime,
      lastSeenOnline: isOnline ? phTime : '',
      lastError: isOnline ? '' : meJson?.description || 'Invalid Bot Token',
      watchdogActive: true,
      lastBroadcastMessage: cfg.lastBroadcastMessage || '',
      lastBroadcastTime: cfg.lastBroadcastTime || '',
      broadcastHistory: cfg.broadcastHistory || [],
      philippineTime: phTime,
      pendingCount: reports.filter((r) => String(r?.status || 'PENDING').toUpperCase() === 'PENDING').length,
      activeUnfinishedCount: reports.filter((r) => {
        const st = String(r?.status || 'PENDING').toUpperCase();
        return st === 'PENDING' || st === 'DISPATCHED';
      }).length,
    });
  }

  if (path === '/api/telegram/lock' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const isEn = body?.lang === 'en';
    const wantLock = Boolean(body?.lock);
    const adminPassword = String(body?.adminPassword || '').trim();
    const cfg = await getEdgeConfig();
    const { token: resolvedTok, chatId: resolvedCh } = await resolveEdgeTelegramCreds(
      request,
      env,
      cfg,
      activePi,
      body
    );
    const finalTok = String(body?.botToken || resolvedTok || '').trim();
    const finalCh = String(body?.chatId || resolvedCh || '').trim();

    if (!isAuthorizedAdminPassword(adminPassword)) {
      return jsonResponse(
        {
          success: false,
          locked: Boolean(cfg.telegramLocked),
          error: isEn
            ? 'Valid Admin password is required to modify Telegram Lock.'
            : 'Kailangan ng wastong Admin password upang baguhin ang Telegram Lock.',
        },
        403
      );
    }

    if (wantLock && (!finalTok || !finalCh)) {
      return jsonResponse(
        {
          success: false,
          locked: false,
          error: isEn
            ? 'Connect and save a valid Bot Token and Chat ID before locking.'
            : 'Ikonekta at i-save muna ang wastong Bot Token at Chat ID bago i-lock.',
        },
        400
      );
    }

    await saveEdgeConfig({
      telegramLocked: wantLock,
      ...(finalTok && finalCh ? { telegramBotToken: finalTok, telegramChatId: finalCh, telegramSetupComplete: true } : {}),
    });

    if (activePi && !isPrivateHost(activePi)) {
      await fetch(`${activePi}/api/config`, {
        method: 'POST',
        headers: { ...PI_EDGE_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegramLocked: wantLock,
          ...(finalTok && finalCh ? { telegramBotToken: finalTok, telegramChatId: finalCh, telegramSetupComplete: true } : {}),
        }),
      }).catch(() => null);
    }

    return jsonResponse({
      success: true,
      locked: wantLock,
      message: wantLock
        ? isEn
          ? 'Telegram Bot settings locked (Admin protected).'
          : 'Nai-lock na ang Telegram Bot settings (protektado ng Admin password).'
        : isEn
          ? 'Telegram Bot settings unlocked.'
          : 'Na-unlock na ang Telegram Bot settings.',
    });
  }

  if (path === '/api/telegram/detect-chat' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const cfg = await getEdgeConfig();
    const token = String(body?.botToken || cfg.telegramBotToken || env?.TELEGRAM_BOT_TOKEN || '').trim();
    const isEn = body?.lang === 'en';
    if (!token) {
      return jsonResponse(
        {
          success: false,
          error: isEn ? 'Enter your Telegram Bot Token first.' : 'Pakilagay muna ang iyong Telegram Bot Token.',
        },
        400
      );
    }

    let r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=30`).catch(() => null);
    let data: any = r ? await r.json().catch(() => null) : null;
    let deletedWebhookForDetect = false;

    if (r && (r.status === 409 || String(data?.description || '').toLowerCase().includes('webhook'))) {
      await fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=false`, {
        method: 'POST',
      }).catch(() => null);
      deletedWebhookForDetect = true;
      r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=30`).catch(() => null);
      data = r ? await r.json().catch(() => null) : null;
    }

    // Re-register webhook right away if bot was already configured so bubble taps keep working
    if (deletedWebhookForDetect && cfg.telegramSetupComplete && cfg.telegramChatId && cfg.telegramBotToken === token) {
      await registerEdgeTelegramWebhook(token, reqUrl.origin, cfg.telegramChatId, activePi).catch(() => null);
    }

    if (!r || !r.ok || !data?.ok) {
      return jsonResponse(
        {
          success: false,
          error: data?.description || (isEn ? 'Invalid Bot Token.' : 'Invalid ang Bot Token.'),
        },
        400
      );
    }

    const updates = Array.isArray(data.result) ? data.result : [];
    const known = Array.isArray(cfg.knownTelegramChats) ? cfg.knownTelegramChats : [];
    const chats: { id: string; title: string; type: string }[] = [...known];
    for (let i = updates.length - 1; i >= 0; i--) {
      const u = updates[i];
      const chat =
        u?.message?.chat ||
        u?.edited_message?.chat ||
        u?.callback_query?.message?.chat ||
        u?.my_chat_member?.chat ||
        u?.chat_member?.chat ||
        u?.channel_post?.chat;
      if (chat && chat.id !== undefined) {
        const idStr = String(chat.id);
        if (!chats.some((c) => c.id === idStr)) {
          const title =
            chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || idStr;
          chats.push({ id: idStr, title, type: chat.type || 'private' });
        }
      }
    }

    if (chats.length === 0) {
      return jsonResponse({
        success: false,
        chats: [],
        error: isEn
          ? 'No messages received yet. Open your bot in Telegram, send /start, then click Auto-Detect again!'
          : 'Wala pang mensahe ang bot. Buksan ang bot sa Telegram, mag-send ng /start, saka pindutin muli ang Auto-Detect!',
      });
    }

    return jsonResponse({
      success: true,
      chatId: chats[0].id,
      chatTitle: chats[0].title,
      chats,
    });
  }

  if (path === '/api/telegram/configure' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const isEn = body?.lang === 'en';
    const cleanToken = String(body?.botToken || '').trim();
    const cleanChat = String(body?.chatId || '').trim();
    const cfg = await getEdgeConfig();

    if (
      cfg.telegramLocked &&
      !isAuthorizedAdminPassword(body?.adminPassword) &&
      (cleanToken !== (cfg.telegramBotToken || '') || cleanChat !== (cfg.telegramChatId || ''))
    ) {
      return jsonResponse(
        {
          success: false,
          online: true,
          locked: true,
          error: isEn
            ? 'Telegram Bot settings are locked. Unlock with Admin credentials first.'
            : 'Naka-LOCK ang Telegram Bot settings. I-unlock muna gamit ang Admin password.',
        },
        403
      );
    }

    const meRes = await fetch(`https://api.telegram.org/bot${cleanToken}/getMe`).catch(() => null);
    const meJson: any = meRes ? await meRes.json().catch(() => null) : null;
    const isOnline = Boolean(meRes?.ok && meJson?.ok);

    let registeredWebhookUrl = '';
    let registeredSecretTag = '';
    if (isOnline && cleanChat) {
      const webhookRes = await registerEdgeTelegramWebhook(cleanToken, reqUrl.origin, cleanChat, activePi);
      if (webhookRes.ok && webhookRes.webhookUrl) {
        registeredWebhookUrl = webhookRes.webhookUrl;
        registeredSecretTag = webhookRes.secretTag || '';
      }
      await saveEdgeConfig({
        telegramBotToken: cleanToken,
        telegramChatId: cleanChat,
        telegramSetupComplete: true,
        telegramWebhookUrl: registeredWebhookUrl || '',
        telegramWebhookSecretTag: registeredSecretTag || '',
        ...(activePi && !isPrivateHost(activePi) ? { piServerUrl: activePi } : {}),
      });
      if (activePi && !isPrivateHost(activePi)) {
        await fetch(`${activePi}/api/config`, {
          method: 'POST',
          headers: { ...PI_EDGE_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            telegramBotToken: cleanToken,
            telegramChatId: cleanChat,
            telegramSetupComplete: true,
          }),
        }).catch(() => null);
      }
      await fetch(`https://api.telegram.org/bot${cleanToken}/setMyCommands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commands: [
            { command: 'active', description: 'Check active & unresolved concerns (Senior/Pending/Dispatched)' },
            { command: 'summary', description: 'Show Barangay 40 & 41 live counts' },
            { command: 'help', description: 'Show bot commands & quick bubble buttons' },
          ],
        }),
      }).catch(() => null);
    }

    return jsonResponse({
      success: isOnline && Boolean(cleanChat),
      status: isOnline ? 'ONLINE' : 'OFFLINE',
      online: isOnline,
      botUsername: meJson?.result?.username || '',
      chatId: cleanChat,
      webhookActive: Boolean(registeredWebhookUrl),
      webhookUrl: registeredWebhookUrl || undefined,
      error: !isOnline ? meJson?.description || 'Invalid Bot Token' : !cleanChat ? 'Missing Chat ID' : undefined,
      message:
        isOnline && cleanChat
          ? isEn
            ? `Telegram Bot @${meJson?.result?.username} connected & saved!`
            : `Konektado at nai-save na ang Telegram Bot @${meJson?.result?.username}!`
          : meJson?.description || (isEn ? 'Check Bot Token and Chat ID.' : 'Pakisuri ang Bot Token at Chat ID.'),
    });
  }

  // Dedicated Telegram Cloud Bubble & Bot Webhook Endpoint (Real-time Serverless Handler)
  if (path === '/api/telegram/webhook' && request.method === 'POST') {
    const updatePayload: any = await request.json().catch(() => null);
    if (!updatePayload || typeof updatePayload !== 'object') {
      return jsonResponse({ ok: false, error: 'Invalid Telegram update payload' }, 400);
    }

    const secretDecoded = decodeTelegramWebhookSecret(
      request.headers.get('X-Telegram-Bot-Api-Secret-Token')
    );

    const cfg = await getEdgeConfig();
    const queryPi = normalizeEdgePiUrl(reqUrl.searchParams.get('pi') || '');
    const envPi = normalizeEdgePiUrl(env?.PI_SERVER_URL || env?.VITE_PI_SERVER_URL || '');
    const effectivePi =
      (activePi && !isPrivateHost(activePi) ? activePi : '') ||
      (queryPi && !isPrivateHost(queryPi) && isValidUrlSyntax(queryPi, reqUrl.origin) ? queryPi : '') ||
      (secretDecoded?.piUrl && !isPrivateHost(secretDecoded.piUrl) ? normalizeEdgePiUrl(secretDecoded.piUrl) : '') ||
      (envPi && !isPrivateHost(envPi) ? envPi : '') ||
      activePi;

    const resolvedCreds = await resolveEdgeTelegramCreds(request, env, cfg, effectivePi);
    const token = secretDecoded?.token || resolvedCreds.token;
    const chatId = resolvedCreds.chatId || secretDecoded?.chatId || '';

    if (!token) {
      return jsonResponse({ ok: true, ignored: true });
    }

    if (
      cfg.telegramBotToken !== token ||
      (chatId && cfg.telegramChatId !== chatId) ||
      (effectivePi && !isPrivateHost(effectivePi) && cfg.piServerUrl !== effectivePi)
    ) {
      await saveEdgeConfig({
        telegramBotToken: token,
        ...(chatId ? { telegramChatId: chatId } : {}),
        telegramSetupComplete: true,
        ...(effectivePi && !isPrivateHost(effectivePi) ? { piServerUrl: effectivePi } : {}),
      });
    }

    // Acknowledge inline bubble query immediately BEFORE waiting on Pi report fetch
    let callbackAlreadyAnswered = false;
    if (updatePayload?.callback_query?.id) {
      const rawCb = String(updatePayload.callback_query.data || '/active').trim();
      const parsed = parseTelegramCloudBubblePayload(rawCb);
      const cbLang = parsed.detectedLang || detectTelegramLanguage(parsed.normalizedCommand, 'tl');
      await answerEdgeCallbackQueryFast(token, updatePayload.callback_query.id, cbLang);
      callbackAlreadyAnswered = true;
    }

    const liveReports = await getLiveReportsForTelegramBot(effectivePi, 14000);
    const latestCfg = await getEdgeConfig();
    if (chatId && effectivePi && !isPrivateHost(effectivePi)) {
      await ensureEdgeTelegramWebhook(token, reqUrl.origin, chatId, effectivePi, latestCfg).catch(() => null);
    }

    const existingHistory = Array.isArray(latestCfg.telegramChatHistory) ? [...latestCfg.telegramChatHistory] : [];
    const knownChats = Array.isArray(latestCfg.knownTelegramChats) ? [...latestCfg.knownTelegramChats] : [];
    let nextOffset = typeof latestCfg.telegramUpdateOffset === 'number' ? latestCfg.telegramUpdateOffset : 0;
    if (typeof updatePayload.update_id === 'number' && updatePayload.update_id >= nextOffset) {
      nextOffset = updatePayload.update_id + 1;
    }

    const didMutate = await processEdgeTelegramUpdate(
      updatePayload,
      token,
      chatId,
      liveReports,
      existingHistory,
      knownChats,
      true,
      { callbackAlreadyAnswered }
    );

    if (didMutate || nextOffset !== (latestCfg.telegramUpdateOffset || 0)) {
      await saveEdgeConfig({
        telegramUpdateOffset: nextOffset,
        telegramChatHistory: existingHistory.slice(-80),
        knownTelegramChats: knownChats.slice(0, 20),
      });
    }

    return jsonResponse({ ok: true, processed: didMutate });
  }

  if (path === '/api/telegram/test-notify' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const isEn = body?.lang === 'en';
    const reqLang: 'tl' | 'en' = isEn ? 'en' : 'tl';
    const cfg = await getEdgeConfig();
    const resolvedCreds = await resolveEdgeTelegramCreds(request, env, cfg, activePi, body);
    const token = String(body?.botToken || resolvedCreds.token || '').trim();
    const chatId = String(body?.chatId || resolvedCreds.chatId || '').trim();
    const phTime = getPhilippineDateTime();
    const reports = await getLiveReportsForTelegramBot(activePi, 14000);
    const pendingLen = reports.filter((r) => String(r?.status || 'PENDING').toUpperCase() === 'PENDING' && !r?.isPurgedFromFeed).length;
    await syncTelegramSnapshotToPi(activePi, reports);

    const webhookRes = await registerEdgeTelegramWebhook(token, reqUrl.origin, chatId, activePi);
    if (webhookRes.ok && webhookRes.webhookUrl) {
      await saveEdgeConfig({
        telegramWebhookUrl: webhookRes.webhookUrl,
        telegramWebhookSecretTag: webhookRes.secretTag || '',
        ...(activePi && !isPrivateHost(activePi) ? { piServerUrl: activePi } : {}),
      });
    }

    const msg =
      body?.message ||
      (isEn
        ? `🔔 <b>[T.U.G.O.N. TEST ALERT • BRGY 40 &amp; 41]</b>\nStatus: Active &amp; Connected • 🕒 ${phTime}\nPending: <b>${pendingLen}</b> concern(s)\n💡 Tap any bubble button below to view active concerns.`
        : `🔔 <b>[T.U.G.O.N. TEST ALERT • BRGY 40 &amp; 41]</b>\nStatus: Aktibo at Konektado • 🕒 ${phTime}\nPending: <b>${pendingLen}</b> concern(s)\n💡 Pindutin ang bubble button sa ibaba para tingnan ang active concerns.`);

    const sent = await sendEdgeTelegramMessage(
      token,
      chatId,
      msg,
      buildTelegramReplyMarkupForChat(reqLang, chatId)
    );
    if (sent.ok) {
      const prevHist = Array.isArray(cfg.broadcastHistory) ? cfg.broadcastHistory : [];
      await saveEdgeConfig({
        telegramBotToken: token,
        telegramChatId: chatId,
        telegramSetupComplete: true,
        telegramWebhookUrl: webhookRes.ok && webhookRes.webhookUrl ? webhookRes.webhookUrl : cfg.telegramWebhookUrl || '',
        telegramWebhookSecretTag: webhookRes.ok && webhookRes.secretTag ? webhookRes.secretTag : cfg.telegramWebhookSecretTag || '',
        ...(activePi && !isPrivateHost(activePi) ? { piServerUrl: activePi } : {}),
        lastBroadcastMessage: htmlToPlainTelegramText(msg),
        lastBroadcastTime: phTime,
        broadcastHistory: [`[${phTime}] ${htmlToPlainTelegramText(msg)}`, ...prevHist].slice(0, 20),
      });
    }

    return jsonResponse({
      success: true,
      delivered: sent.ok,
      message: sent.ok
        ? isEn
          ? `Test alert delivered to Telegram! (${phTime})`
          : `Matagumpay na naipadala ang test alert sa Telegram! (${phTime})`
        : sent.description || (isEn ? 'Could not deliver to Telegram.' : 'Hindi naipadala sa Telegram.'),
      timestamp: phTime,
    });
  }

  if (path === '/api/telegram/chat' && request.method === 'GET') {
    await syncEdgePiAndTelegramContext(request, env, reqUrl.origin, activePi);
    const cfg = await getEdgeConfig();
    const { token, chatId } = await resolveEdgeTelegramCreds(request, env, cfg, activePi);
    if (token && chatId) {
      await ensureEdgeTelegramWebhook(token, reqUrl.origin, chatId, activePi, await getEdgeConfig());
    }
    const latestCfg = await getEdgeConfig();
    const reports = await getLiveReportsForTelegramBot(activePi);
    const { history } = await pollEdgeTelegramUpdatesOnce(token, chatId, reports, latestCfg);
    return jsonResponse({
      success: true,
      messages: history,
      pendingCount: reports.filter((r) => String(r?.status || 'PENDING').toUpperCase() === 'PENDING').length,
      activeUnfinishedCount: reports.filter((r) => {
        const st = String(r?.status || 'PENDING').toUpperCase();
        return st === 'PENDING' || st === 'DISPATCHED';
      }).length,
    });
  }

  if (path === '/api/telegram/chat' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const reqLang: 'tl' | 'en' = body?.lang === 'en' ? 'en' : 'tl';
    const userText = String(body?.message || '').trim();
    if (!userText) {
      return jsonResponse({ success: false, error: 'Message is required.' }, 400);
    }

    await syncEdgePiAndTelegramContext(request, env, reqUrl.origin, activePi, body);
    const cfg = await getEdgeConfig();
    const { token, chatId } = await resolveEdgeTelegramCreds(request, env, cfg, activePi, body);
    const reports = await getLiveReportsForTelegramBot(activePi);
    const phTime = getPhilippineDateTime();
    const parsedBubble = parseTelegramCloudBubblePayload(userText);

    const userEntry = {
      id: `app-u-${Date.now()}`,
      sender: 'user',
      text: parsedBubble.displayLabel || userText,
      timestamp: phTime,
      source: 'app',
    };
    const reply = generateBotChatReply(userText, reports, reqLang);
    const botEntry = {
      id: `app-b-${Date.now() + 1}`,
      sender: 'bot',
      text: reply.textPlain,
      timestamp: phTime,
      source: 'app',
      matchedIntent: reply.matchedIntent,
    };

    const prevChat = Array.isArray(cfg.telegramChatHistory) ? cfg.telegramChatHistory : [];
    const nextChat = [...prevChat, userEntry, botEntry].slice(-80);
    await saveEdgeConfig({ telegramChatHistory: nextChat });

    let telegramDelivered = false;
    if (body?.sendToTelegram && token && chatId) {
      const sent = await sendEdgeTelegramMessage(
        token,
        chatId,
        reply.textHtml,
        buildTelegramReplyMarkupForChat(reqLang, chatId)
      );
      telegramDelivered = sent.ok;
    }

    return jsonResponse({
      success: true,
      userMessage: userEntry,
      botMessage: botEntry,
      messages: nextChat,
      telegramDelivered,
      activeUnfinishedCount: reply.activeCount,
    });
  }

  if (path === '/api/telegram/disconnect' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const isEn = body?.lang === 'en';
    const cfg = await getEdgeConfig();
    if (cfg.telegramLocked && !isAuthorizedAdminPassword(body?.adminPassword)) {
      return jsonResponse(
        {
          success: false,
          locked: true,
          error: isEn
            ? 'Telegram Bot settings are locked. Unlock with Admin credentials first.'
            : 'Naka-lock ang Telegram Bot settings. I-unlock muna gamit ang Admin password.',
        },
        403
      );
    }
    if (cfg.telegramBotToken) {
      await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/deleteWebhook?drop_pending_updates=false`, {
        method: 'POST',
      }).catch(() => null);
    }
    await saveEdgeConfig({
      telegramBotToken: '',
      telegramChatId: '',
      telegramSetupComplete: false,
      telegramLocked: false,
      telegramWebhookUrl: '',
      telegramWebhookSecretTag: '',
    });
    return jsonResponse({ success: true });
  }

  if (path === '/api/telegram/restart' && request.method === 'POST') {
    const cfg = await getEdgeConfig();
    const body: any = await request.json().catch(() => ({}));
    const token = String(body?.botToken || cfg.telegramBotToken || env?.TELEGRAM_BOT_TOKEN || '').trim();
    const chatId = String(body?.chatId || cfg.telegramChatId || env?.TELEGRAM_CHAT_ID || '').trim();
    const meRes = token ? await fetch(`https://api.telegram.org/bot${token}/getMe`).catch(() => null) : null;
    const meJson: any = meRes ? await meRes.json().catch(() => null) : null;
    const isOnline = Boolean(meRes?.ok && meJson?.ok);
    if (isOnline && token) {
      const wh = await registerEdgeTelegramWebhook(token, reqUrl.origin, chatId, activePi);
      if (wh.ok && wh.webhookUrl) {
        await saveEdgeConfig({
          telegramWebhookUrl: wh.webhookUrl,
          telegramWebhookSecretTag: wh.secretTag || '',
          ...(chatId ? { telegramChatId: chatId } : {}),
          ...(activePi && !isPrivateHost(activePi) ? { piServerUrl: activePi } : {}),
        });
      }
    }
    return jsonResponse({
      success: isOnline,
      online: isOnline,
      status: isOnline ? 'ONLINE' : 'OFFLINE',
      botUsername: meJson?.result?.username || '',
    });
  }

  const runEdgeGeminiJson = async (
    apiKey: string,
    systemInstruction: string,
    contents: any[],
    schema: any,
    options?: { preferFastest?: boolean; hasImage?: boolean }
  ): Promise<{ parsed: any; modelUsed: string }> => {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
    const candidateModels = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'];
    let lastErr: any = null;
    for (const modelName of candidateModels) {
      try {
        const perModelTimeoutMs =
          modelName === 'gemini-4-hydrogen'
            ? options?.hasImage
              ? 28000
              : 22000
            : options?.hasImage
              ? 18000
              : 14000;
        const config: any = {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: schema,
          thinkingConfig: {
            thinkingLevel:
              modelName === 'gemini-3.1-flash-lite' ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW,
          },
        };
        const response = await Promise.race([
          ai.models.generateContent({
            model: modelName,
            contents,
            config,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`${modelName} request timeout`)), perModelTimeoutMs)
          ),
        ]);
        const rawText = String(response.text || '').trim();
        if (!rawText) continue;
        const friendlyName =
          modelName === 'gemini-4-hydrogen' ? 'Gemini 4 Hydrogen' : 'Gemini 3.1 Flash Lite';
        try {
          return { parsed: JSON.parse(rawText), modelUsed: friendlyName };
        } catch {
          const cleaned = rawText.replace(/^\`\`\`json\s*/i, '').replace(/\`\`\`$/i, '').trim();
          try {
            return { parsed: JSON.parse(cleaned), modelUsed: friendlyName };
          } catch {
            return {
              parsed: { reply: rawText, wantsOfficialHandoff: false, handoffClassification: 'NONE' },
              modelUsed: friendlyName,
            };
          }
        }
      } catch (modelErr: any) {
        lastErr = modelErr;
      }
    }
    throw lastErr || new Error('Gemini unavailable');
  };

  interface EdgeCompatMessage {
    role: 'user' | 'assistant';
    text: string;
    imageBase64?: string;
    imageMimeType?: string;
  }

  const parseEdgeJsonSafely = (rawText: string): any => {
    const trimmed = String(rawText || '').trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      const cleaned = trimmed
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      try {
        return JSON.parse(cleaned);
      } catch {
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start >= 0 && end > start) {
          try {
            return JSON.parse(cleaned.slice(start, end + 1));
          } catch {}
        }
        return { reply: trimmed, wantsOfficialHandoff: false, handoffClassification: 'NONE' };
      }
    }
  };

  const runEdgeOpenAiCompatibleJson = async (
    provider: 'openrouter' | 'groq',
    apiKey: string,
    systemInstruction: string,
    messages: EdgeCompatMessage[],
    schemaHint: string,
    options?: { preferFastest?: boolean; hasImage?: boolean }
  ): Promise<{ parsed: any; modelUsed: string }> => {
    const endpoint =
      provider === 'openrouter'
        ? 'https://openrouter.ai/api/v1/chat/completions'
        : 'https://api.groq.com/openai/v1/chat/completions';

    const candidateModels =
      provider === 'openrouter'
        ? options?.hasImage
          ? ['google/gemini-2.5-flash', 'openai/gpt-4o-mini', 'meta-llama/llama-3.2-11b-vision-instruct:free']
          : options?.preferFastest
            ? ['google/gemini-2.5-flash-lite', 'openai/gpt-4o-mini', 'meta-llama/llama-3.3-70b-instruct:free', 'openrouter/auto']
            : ['google/gemini-2.5-flash', 'openai/gpt-4o-mini', 'meta-llama/llama-3.3-70b-instruct:free', 'openrouter/auto']
        : options?.hasImage
          ? ['meta-llama/llama-4-scout-17b-16e-instruct', 'meta-llama/llama-4-maverick-17b-128e-instruct']
          : options?.preferFastest
            ? ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile']
            : ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];

    const formattedMessages = [
      {
        role: 'system',
        content: `${systemInstruction}\n\nSTRICT OUTPUT FORMAT:\n${schemaHint}\nRespond with ONLY a valid JSON object (no markdown fences).`,
      },
      ...messages.map((m) => {
        if (m.imageBase64) {
          return {
            role: m.role,
            content: [
              { type: 'text', text: m.text || 'Please inspect this waste photo for Barangay 40/41 T.U.G.O.N.' },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${m.imageMimeType || 'image/jpeg'};base64,${m.imageBase64}`,
                },
              },
            ],
          };
        }
        return { role: m.role, content: m.text };
      }),
    ];

    let lastErr: any = null;
    for (const modelName of candidateModels) {
      const controller = new AbortController();
      const timeoutMs = options?.hasImage ? 24000 : options?.preferFastest ? 14000 : 20000;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        };
        if (provider === 'openrouter') {
          headers['HTTP-Referer'] = 'https://tugon.barangay';
          headers['X-Title'] = 'T.U.G.O.N.';
        }
        const payload: Record<string, any> = {
          model: modelName,
          messages: formattedMessages,
          temperature: 0.3,
        };
        if (!options?.hasImage) {
          payload.response_format = { type: 'json_object' };
        }

        const resp = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!resp.ok) {
          const errBody: any = await resp.json().catch(() => null);
          const msg = errBody?.error?.message || `${provider} HTTP ${resp.status}`;
          throw new Error(msg);
        }
        const data: any = await resp.json();
        const rawText = String(data?.choices?.[0]?.message?.content || '').trim();
        if (!rawText) continue;
        const providerLabel = provider === 'openrouter' ? 'OpenRouter' : 'Groq';
        const shortModel = modelName.split('/').pop() || modelName;
        return {
          parsed: parseEdgeJsonSafely(rawText),
          modelUsed: `${providerLabel} (${shortModel})`,
        };
      } catch (err: any) {
        lastErr = err?.name === 'AbortError' ? new Error(`${provider} ${modelName} request timeout`) : err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr || new Error(`${provider} unavailable`);
  };

  const runEdgeAiJsonWithMultiProvider = async (
    keys: { geminiKey: string; openRouterKey: string; groqKey: string },
    systemInstruction: string,
    geminiContents: any[],
    compatMessages: EdgeCompatMessage[],
    geminiSchema: any,
    schemaHint: string,
    options?: { preferFastest?: boolean; hasImage?: boolean }
  ): Promise<{ parsed: any; modelUsed: string }> => {
    let lastErr: any = null;
    if (keys.geminiKey) {
      try {
        return await runEdgeGeminiJson(
          keys.geminiKey,
          systemInstruction,
          geminiContents,
          geminiSchema,
          options
        );
      } catch (err: any) {
        lastErr = err;
      }
    }

    const fallbackOrder: Array<'openrouter' | 'groq'> = options?.hasImage
      ? ['openrouter', 'groq']
      : ['groq', 'openrouter'];

    for (const provider of fallbackOrder) {
      const key = provider === 'openrouter' ? keys.openRouterKey : keys.groqKey;
      if (!key) continue;
      try {
        return await runEdgeOpenAiCompatibleJson(
          provider,
          key,
          systemInstruction,
          compatMessages,
          schemaHint,
          options
        );
      } catch (err: any) {
        lastErr = err;
      }
    }

    throw lastErr || new Error('AI service unavailable');
  };

  // Centralized T.U.G.O.N. Domain AI Chat Endpoint (Per-Device Resident DB or All-in-One Official)
  if (path === '/api/chat/ai' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const reqLang: 'tl' | 'en' = body?.lang === 'en' ? 'en' : 'tl';
    const role: 'resident' | 'kagawad' = body?.role === 'kagawad' ? 'kagawad' : 'resident';
    const userMessage = String(body?.message || '').trim();
    const cleanImageB64 = String(body?.imageBase64 || '')
      .replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '')
      .trim();
    const cleanMimeType = /^image\/(jpeg|jpg|png|webp|gif)$/i.test(String(body?.imageMimeType || ''))
      ? String(body.imageMimeType).toLowerCase().replace('image/jpg', 'image/jpeg')
      : 'image/jpeg';

    if (!userMessage && !cleanImageB64) {
      return jsonResponse(
        {
          success: false,
          error: reqLang === 'en' ? 'Please enter a message or attach a photo.' : 'Pakilagay ang iyong tanong o mag-attach ng litrato.',
        },
        400
      );
    }

    const aiKeys = resolveEdgeAiProviderKeys(env);
    const hasAnyAiKey = Boolean(aiKeys.geminiKey || aiKeys.openRouterKey || aiKeys.groqKey);

    if (!hasAnyAiKey) {
      const bodyPi = body?.piUrl ? normalizeEdgePiUrl(String(body.piUrl)) : '';
      const piTarget = (activePi && !isPrivateHost(activePi) ? activePi : '') || (bodyPi && !isPrivateHost(bodyPi) ? bodyPi : '');
      if (piTarget) {
        try {
          const piAiRes = await fetch(`${piTarget}/api/chat/ai`, {
            method: 'POST',
            headers: { ...PI_EDGE_HEADERS, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }).catch(() => null);
          if (piAiRes && piAiRes.ok) {
            const piAiJson: any = await piAiRes.json().catch(() => null);
            if (piAiJson?.success && piAiJson?.reply) {
              return jsonResponse(piAiJson);
            }
          }
        } catch {}
      }

      return jsonResponse(
        {
          success: false,
          aiEnvKeysDetected: aiKeys.detectedKeyNames,
          error:
            reqLang === 'en'
              ? 'T.U.G.O.N. AI needs GEMINI_API_KEY, OPENROUTER_API_KEY, or GROQ_API_KEY added under Cloudflare Settings → Variables and Secrets (Runtime) as Secret (or Text) and redeployed. You can still select "Talk with Barangay Official" directly.'
              : 'Kailangan ng GEMINI_API_KEY, OPENROUTER_API_KEY, o GROQ_API_KEY sa Cloudflare Settings → Variables and Secrets (Runtime) bilang Secret (o Text) at i-redeploy. Maaari ring piliin ang "Talk with Barangay Official".',
        },
        503
      );
    }

    try {
      const cachedEdgeReports = await getEdgeReports().catch(() => []);
      let pool = cachedEdgeReports;
      if (cachedEdgeReports.length > 0) {
        getLiveReportsForTelegramBot(activePi, 1800).catch(() => null);
      } else {
        const liveReports = await Promise.race([
          getLiveReportsForTelegramBot(activePi, 350).catch(() => cachedEdgeReports),
          new Promise<any[]>((resolve) => setTimeout(() => resolve(cachedEdgeReports), 350)),
        ]);
        if (liveReports.length > 0) pool = liveReports;
      }
      const summary = computeTugonAiLiveSummary(pool);

      let scopedDeviceReports: ResidentDeviceReportContext[] = [];
      if (role === 'resident' && Array.isArray(body?.residentReports)) {
        const liveByKey = new Map<string, any>();
        for (const r of pool) {
          if (r?.id) liveByKey.set(String(r.id), r);
          if (r?.ticketNumber) liveByKey.set(formatEdgeTicket(r.ticketNumber).toUpperCase(), r);
        }
        scopedDeviceReports = body.residentReports.map((localRep: any) => {
          const tk = formatEdgeTicket(localRep?.ticketNumber).toUpperCase();
          const fresh =
            (localRep?.id && liveByKey.get(String(localRep.id))) ||
            (tk && liveByKey.get(tk)) ||
            null;
          return fresh ? { ...localRep, ...fresh } : localRep;
        });
      }

      const focusSource = role === 'kagawad' ? pool : scopedDeviceReports;
      const selectedId = body?.selectedReportId ? String(body.selectedReportId) : '';
      const normSel = selectedId ? formatEdgeTicket(selectedId).toUpperCase() : '';
      const selectedReport = selectedId
        ? focusSource.find(
            (r: any) =>
              String(r?.id) === selectedId ||
              formatEdgeTicket(r?.ticketNumber).toUpperCase() === normSel
          ) || null
        : null;

      const historyItems = Array.isArray(body?.history) ? body.history.slice(-12) : [];
      const currentParts: any[] = [];
      if (cleanImageB64) {
        currentParts.push({
          inlineData: {
            mimeType: cleanMimeType,
            data: cleanImageB64,
          },
        });
      }
      currentParts.push({
        text: userMessage || 'Please inspect this waste photo for Barangay 40/41 T.U.G.O.N.',
      });

      const validHistory = historyItems.filter(
        (h: any) => h && typeof h.text === 'string' && h.text.trim()
      );
      const contents = [
        ...validHistory.map((h: any) => ({
          role: h.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: String(h.text).trim() }],
        })),
        { role: 'user', parts: currentParts },
      ];
      const compatMessages: EdgeCompatMessage[] = [
        ...validHistory.map((h: any) => ({
          role: (h.role === 'assistant' ? 'assistant' : 'user') as 'assistant' | 'user',
          text: String(h.text).trim(),
        })),
        {
          role: 'user',
          text: userMessage || 'Please inspect this waste photo for Barangay 40/41 T.U.G.O.N.',
          ...(cleanImageB64 ? { imageBase64: cleanImageB64, imageMimeType: cleanMimeType } : {}),
        },
      ];

      const systemInstruction = buildTugonAiSystemInstruction(reqLang, role, summary, {
        residentReports: scopedDeviceReports,
        selectedReport,
      });

      const { parsed, modelUsed } = await runEdgeAiJsonWithMultiProvider(
        aiKeys,
        systemInstruction,
        contents,
        compatMessages,
        {
          type: Type.OBJECT,
          properties: {
            reply: { type: Type.STRING },
            wantsOfficialHandoff: { type: Type.BOOLEAN },
            handoffClassification: { type: Type.STRING },
            handoffSummary: { type: Type.STRING },
            moderationReason: { type: Type.STRING },
          },
          required: ['reply', 'wantsOfficialHandoff', 'handoffClassification'],
        },
        'Return JSON with keys: {"reply": string, "wantsOfficialHandoff": boolean, "handoffClassification": "NONE"|"IMPORTANT"|"SPAM_REDUNDANT", "handoffSummary": string, "moderationReason": string}.',
        { hasImage: Boolean(cleanImageB64) }
      );

      const replyText = String(parsed?.reply || '').trim();
      if (!replyText) {
        return jsonResponse(
          {
            success: false,
            error:
              reqLang === 'en'
                ? 'T.U.G.O.N. AI is currently busy. Please try again or talk with a Barangay Official.'
                : 'Abala ngayon ang T.U.G.O.N. AI. Subukan muli o makipag-usap sa Barangay Official.',
          },
          502
        );
      }

      const wantsHandoff = Boolean(parsed?.wantsOfficialHandoff);
      const rawClass = String(parsed?.handoffClassification || 'NONE').toUpperCase();
      const handoffClassification = !wantsHandoff
        ? 'NONE'
        : rawClass === 'SPAM_REDUNDANT'
          ? 'SPAM_REDUNDANT'
          : 'IMPORTANT';

      return jsonResponse({
        success: true,
        reply: replyText,
        modelUsed: cleanImageB64 ? `${modelUsed} Vision` : modelUsed,
        wantsOfficialHandoff: wantsHandoff,
        handoffClassification,
        handoffSummary: String(parsed?.handoffSummary || '').trim(),
        moderationReason: String(parsed?.moderationReason || '').trim(),
      });
    } catch (err: any) {
      let cleanErr = String(err?.message || '');
      try {
        if (cleanErr.startsWith('{')) {
          const parsedErr = JSON.parse(cleanErr);
          if (parsedErr?.error?.message) cleanErr = String(parsedErr.error.message);
        }
      } catch {}
      return jsonResponse(
        {
          success: false,
          error:
            cleanErr ||
            (reqLang === 'en'
              ? 'Unable to reach T.U.G.O.N. AI right now.'
              : 'Hindi maabot ang T.U.G.O.N. AI sa ngayon.'),
        },
        502
      );
    }
  }

  // Fast Dynamic Translation of Existing AI Chat Replies to Match Interface Language
  if (path === '/api/chat/ai/translate' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const reqLang: 'tl' | 'en' = body?.targetLang === 'en' ? 'en' : 'tl';
    const validItems: { id: string; text: string }[] = Array.isArray(body?.items)
      ? body.items
          .filter((it: any) => it && it.id && typeof it.text === 'string' && it.text.trim())
          .map((it: any) => ({ id: String(it.id), text: String(it.text) }))
      : [];
    if (validItems.length === 0) {
      return jsonResponse({ success: true, translations: {} });
    }
    const aiKeys = resolveEdgeAiProviderKeys(env);
    const hasAnyAiKey = Boolean(aiKeys.geminiKey || aiKeys.openRouterKey || aiKeys.groqKey);
    if (!hasAnyAiKey) {
      const bodyPiT = body?.piUrl ? normalizeEdgePiUrl(String(body.piUrl)) : '';
      const piTargetT = (activePi && !isPrivateHost(activePi) ? activePi : '') || (bodyPiT && !isPrivateHost(bodyPiT) ? bodyPiT : '');
      if (piTargetT) {
        try {
          const piRes = await fetch(`${piTargetT}/api/chat/ai/translate`, {
            method: 'POST',
            headers: { ...PI_EDGE_HEADERS, 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: validItems, targetLang: reqLang }),
          }).catch(() => null);
          if (piRes && piRes.ok) {
            const piJson: any = await piRes.json().catch(() => null);
            if (piJson?.success && piJson?.translations) {
              return jsonResponse(piJson);
            }
          }
        } catch {}
      }
      return jsonResponse({ success: false, error: 'AI API key not configured (GEMINI_API_KEY, OPENROUTER_API_KEY, or GROQ_API_KEY)' }, 503);
    }
    try {
      const targetName = reqLang === 'en' ? 'English' : 'Tagalog / Filipino';
      const systemInstruction = [
        `Translate each T.U.G.O.N. AI Assistant reply accurately and completely into natural ${targetName}.`,
        'Preserve every detail, meaning, ticket code (#TUGON-CAV-...), status token (PENDING, DISPATCHED, RESOLVED, CANCELLED), and Barangay name (Barangay 40, Barangay 41) verbatim.',
        'Do NOT summarize or shorten any message. Return JSON matching the schema.',
      ].join('\n');
      const serializedItems = JSON.stringify(validItems);
      const { parsed, modelUsed } = await runEdgeAiJsonWithMultiProvider(
        aiKeys,
        systemInstruction,
        [{ role: 'user', parts: [{ text: serializedItems }] }],
        [{ role: 'user', text: serializedItems }],
        {
          type: Type.OBJECT,
          properties: {
            translations: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  text: { type: Type.STRING },
                },
                required: ['id', 'text'],
              },
            },
          },
          required: ['translations'],
        },
        'Return JSON with key: {"translations": [{"id": string, "text": string}]}.',
        { preferFastest: true }
      );
      const translationsMap: Record<string, string> = {};
      if (Array.isArray(parsed?.translations)) {
        for (const entry of parsed.translations) {
          if (entry?.id && typeof entry?.text === 'string' && entry.text.trim()) {
            translationsMap[String(entry.id)] = entry.text.trim();
          }
        }
      }
      return jsonResponse({ success: true, translations: translationsMap, modelUsed });
    } catch (err: any) {
      return jsonResponse({ success: false, error: String(err?.message || 'Translation failed') }, 502);
    }
  }

  // Live Resident <-> Barangay Official Support Chat Endpoints (AI Moderated + Telegram Logbook + Delete)
  if (path === '/api/support-chat' && request.method === 'GET') {
    const sessionId = String(reqUrl.searchParams.get('sessionId') || '').trim();
    const cachedThreads = await getEdgeSupportChats();
    let mergedThreads = cachedThreads;

    if (activePi && !isPrivateHost(activePi)) {
      try {
        const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
        const piRes = await fetch(`${activePi}/api/support-chat${suffix}`, {
          headers: PI_EDGE_HEADERS,
        }).catch(() => null);
        if (piRes && piRes.ok) {
          const piJson: any = await piRes.json().catch(() => null);
          if (Array.isArray(piJson?.threads)) {
            mergedThreads = sessionId
              ? mergeSupportChatThreads(
                  cachedThreads.filter((t) => String(t.sessionId) === sessionId),
                  piJson.threads
                )
              : mergeSupportChatThreads(cachedThreads, piJson.threads);
            if (!sessionId) await saveEdgeSupportChats(mergedThreads);
          }
        }
      } catch {}
    }

    const filtered = sessionId
      ? mergedThreads.filter((t) => String(t.sessionId) === sessionId)
      : mergedThreads;
    return jsonResponse({ success: true, threads: filtered });
  }

  if (path === '/api/support-chat' && request.method === 'POST') {
    const body: any = await request.json().catch(() => ({}));
    const sessionId = String(body?.sessionId || '').trim();
    const text = String(body?.text || '').trim();
    const sender: 'resident' | 'official' =
      String(body?.sender || '').toLowerCase() === 'official' ? 'official' : 'resident';
    if (!sessionId || !text) {
      return jsonResponse({ success: false, error: 'sessionId and text are required' }, 400);
    }

    const existingThreads = await getEdgeSupportChats();
    let nextThreads = [...existingThreads];
    let target = nextThreads.find((t) => String(t.sessionId) === sessionId);

    let folderVal: 'INBOX' | 'SPAM' = 'INBOX';
    let spamReason = '';
    let aiSummary = String(body?.aiHandoffSummary || '').trim();

    if (sender === 'resident') {
      const preClass = String(body?.handoffClassification || '').toUpperCase();
      if (preClass === 'SPAM_REDUNDANT') {
        folderVal = 'SPAM';
        spamReason = String(body?.spamReason || 'Flagged as redundant or off-topic by T.U.G.O.N. AI');
      } else if (preClass === 'IMPORTANT') {
        folderVal = 'INBOX';
      } else {
        const aiKeys = resolveEdgeAiProviderKeys(env);
        if (aiKeys.geminiKey || aiKeys.openRouterKey || aiKeys.groqKey) {
          try {
            const modInstr = buildSupportModerationInstruction(
              String(body?.residentName || target?.residentName || 'Resident'),
              String(body?.barangay || target?.barangay || 'Brgy 40/41'),
              String(body?.ticketNumber ?? target?.ticketNumber ?? ''),
              (target?.messages || []).slice(-8)
            );
            const clippedText = text.slice(0, 1500);
            const { parsed: modParsed } = await runEdgeAiJsonWithMultiProvider(
              aiKeys,
              modInstr,
              [{ role: 'user', parts: [{ text: clippedText }] }],
              [{ role: 'user', text: clippedText }],
              {
                type: Type.OBJECT,
                properties: {
                  classification: { type: Type.STRING },
                  reason: { type: Type.STRING },
                  summary: { type: Type.STRING },
                },
                required: ['classification', 'reason'],
              },
              'Return JSON with keys: {"classification": "IMPORTANT"|"SPAM_REDUNDANT", "reason": string, "summary": string}.',
              { preferFastest: true }
            );
            const cls = String(modParsed?.classification || 'IMPORTANT').toUpperCase();
            if (cls === 'SPAM_REDUNDANT') {
              folderVal = 'SPAM';
              spamReason = String(modParsed?.reason || 'Redundant or irrelevant message').slice(0, 200);
            } else {
              folderVal = 'INBOX';
              if (!aiSummary && modParsed?.summary) {
                aiSummary = String(modParsed.summary).trim().slice(0, 400);
              }
            }
          } catch {}
        }
      }
    }

    const nowIso = new Date().toISOString();
    const ackIso = new Date(Date.now() + 1).toISOString();
    const reqLang: 'tl' | 'en' = body?.lang === 'en' ? 'en' : 'tl';
    const messageId = String(body?.messageId || `sc-${Date.now()}`);
    const newMsg = {
      id: messageId,
      sender,
      senderName: String(
        body?.senderName || (sender === 'official' ? 'Barangay Official' : 'Resident')
      )
        .trim()
        .slice(0, 80),
      text,
      timestamp: String(body?.timestamp || nowIso),
    };

    const ticketStr = String(
      body?.ticketNumber !== undefined ? body.ticketNumber : target?.ticketNumber || ''
    )
      .trim()
      .replace(/^#+/, '');
    const ackMsg =
      sender === 'resident'
        ? (() => {
            const textEn =
              folderVal === 'SPAM'
                ? 'Your message was received by T.U.G.O.N. and placed in review. Please share specific Barangay 40 & 41 waste concern details for immediate official assistance.'
                : ticketStr
                  ? `Your message regarding #${ticketStr} has been delivered to Barangay 40 & 41 Officials. Please wait shortly for a response.`
                  : 'Your message has been delivered to Barangay 40 & 41 Officials. Please wait shortly for a response.';
            const textTl =
              folderVal === 'SPAM'
                ? 'Natanggap ng T.U.G.O.N. ang iyong mensahe para sa review. Maglagay ng malinaw na detalye tungkol sa basura sa Barangay 40 & 41 para sa agarang tulong.'
                : ticketStr
                  ? `Naipadala na ang iyong mensahe tungkol sa #${ticketStr} sa mga Opisyal ng Barangay 40 & 41. Mangyaring maghintay sandali para sa kanilang tugon.`
                  : 'Naipadala na ang iyong mensahe sa mga Opisyal ng Barangay 40 & 41. Mangyaring maghintay sandali para sa kanilang tugon.';
            return {
              id: `${messageId}-ack`,
              sender: 'ai',
              senderName: 'T.U.G.O.N. AI',
              text: reqLang === 'en' ? textEn : textTl,
              textEn,
              textTl,
              timestamp: ackIso,
            };
          })()
        : null;

    if (!target) {
      target = {
        sessionId,
        residentName: String(body?.residentName || 'Resident').trim().slice(0, 80) || 'Resident',
        barangay: String(body?.barangay || 'Barangay 40 & 41').trim().slice(0, 40),
        ticketNumber: String(body?.ticketNumber || '').trim().slice(0, 32),
        status: sender === 'resident' || body?.requestOfficial ? 'NEEDS_OFFICIAL' : 'OPEN',
        folder: folderVal,
        spamReason: folderVal === 'SPAM' ? spamReason : '',
        aiHandoffSummary: aiSummary,
        unreadByOfficial: sender === 'resident' && folderVal !== 'SPAM' ? 1 : 0,
        unreadByResident: sender === 'official' ? 1 : 0,
        createdAt: nowIso,
        updatedAt: nowIso,
        messages: ackMsg ? [newMsg, ackMsg] : [newMsg],
      };
      nextThreads.unshift(target);
    } else {
      if (body?.residentName && String(body.residentName).trim()) {
        target.residentName = String(body.residentName).trim().slice(0, 80);
      }
      if (body?.barangay && String(body.barangay).trim()) {
        target.barangay = String(body.barangay).trim().slice(0, 40);
      }
      if (body?.ticketNumber !== undefined) {
        target.ticketNumber = String(body.ticketNumber || '').trim().slice(0, 32);
      }
      if (aiSummary) {
        target.aiHandoffSummary = aiSummary;
      }
      if (sender === 'resident') {
        target.folder = folderVal;
        target.spamReason = folderVal === 'SPAM' ? spamReason : '';
      } else {
        target.folder = 'INBOX';
        target.spamReason = '';
      }
      const msgs = Array.isArray(target.messages) ? [...target.messages] : [];
      if (!msgs.some((m: any) => String(m?.id) === messageId)) {
        msgs.push(newMsg);
      }
      if (ackMsg && !msgs.some((m: any) => String(m?.id) === ackMsg.id)) {
        msgs.push(ackMsg);
      }
      target.messages = msgs;
      target.updatedAt = nowIso;
      if (sender === 'resident') {
        if (folderVal !== 'SPAM') {
          target.unreadByOfficial = Number(target.unreadByOfficial || 0) + 1;
        }
        target.unreadByResident = 0;
        if (body?.requestOfficial || target.status === 'RESOLVED') {
          target.status = 'NEEDS_OFFICIAL';
        }
      } else {
        target.unreadByResident = Number(target.unreadByResident || 0) + 1;
        target.unreadByOfficial = 0;
        if (target.status === 'OPEN') target.status = 'NEEDS_OFFICIAL';
      }
    }

    if (activePi && !isPrivateHost(activePi)) {
      const piRes = await fetch(`${activePi}/api/support-chat`, {
        method: 'POST',
        headers: { ...PI_EDGE_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...body,
          messageId,
          timestamp: newMsg.timestamp,
          ...(ackMsg ? { ackMessage: ackMsg } : {}),
          folder: folderVal,
          spamReason,
          aiHandoffSummary: aiSummary,
        }),
      }).catch(() => null);
      if (piRes && piRes.ok) {
        const piJson: any = await piRes.json().catch(() => null);
        if (Array.isArray(piJson?.threads)) {
          nextThreads = mergeSupportChatThreads(nextThreads, piJson.threads);
          target = nextThreads.find((t) => String(t.sessionId) === sessionId) || target;
        }
      }
    }

    await saveEdgeSupportChats(nextThreads);
    await bumpEdgePortalRevision();

    // Telegram serves as our official Logbook — log IMPORTANT resident messages routed to Inbox
    if (sender === 'resident' && folderVal === 'INBOX') {
      try {
        const cfg = await getEdgeConfig();
        const { token: tgToken, chatId: tgChat } = await resolveEdgeTelegramCreds(
          request,
          env,
          cfg,
          activePi,
          body
        );
        if (tgToken && tgChat) {
          const ticketPart = target.ticketNumber ? ` • 🎫 #${target.ticketNumber}` : '';
          const summaryPart = aiSummary
            ? `\n🤖 <i>AI Summary: ${String(aiSummary).slice(0, 220).replace(/</g, '&lt;')}</i>`
            : '';
          const alertHtml =
            `💬 <b>[T.U.G.O.N. OFFICIAL CHAT LOGBOOK]</b>\n` +
            `👤 ${String(target.residentName || 'Resident').replace(/</g, '&lt;')} (${String(target.barangay || 'Brgy 40/41').replace(/</g, '&lt;')}${ticketPart})\n` +
            `📝 "${text.slice(0, 220).replace(/</g, '&lt;')}"` +
            `${summaryPart}\n` +
            `👉 Buksan ang chat bubble sa Barangay Portal upang sumagot.`;
          await sendEdgeTelegramMessage(tgToken, tgChat, alertHtml);
        }
      } catch {}
    }

    return jsonResponse({
      success: true,
      folder: folderVal,
      spamReason,
      thread: target,
      threads: nextThreads,
    });
  }

  if (path === '/api/support-chat' && request.method === 'PATCH') {
    const body: any = await request.json().catch(() => ({}));
    const sessionId = String(body?.sessionId || '').trim();
    if (!sessionId) {
      return jsonResponse({ success: false, error: 'sessionId is required' }, 400);
    }

    let existingThreads = await getEdgeSupportChats();
    if (activePi && !isPrivateHost(activePi)) {
      const piRes = await fetch(`${activePi}/api/support-chat`, {
        method: 'PATCH',
        headers: { ...PI_EDGE_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(() => null);
      if (piRes && piRes.ok) {
        const piJson: any = await piRes.json().catch(() => null);
        if (Array.isArray(piJson?.threads)) {
          existingThreads = mergeSupportChatThreads(existingThreads, piJson.threads);
        }
      }
    }

    const target = existingThreads.find((t) => String(t.sessionId) === sessionId);
    if (target) {
      if (body?.status === 'OPEN' || body?.status === 'NEEDS_OFFICIAL' || body?.status === 'RESOLVED') {
        target.status = body.status;
      }
      if (body?.folder === 'INBOX' || body?.folder === 'SPAM') {
        target.folder = body.folder;
        if (body.folder === 'INBOX') target.spamReason = '';
      }
      if (body?.markReadFor === 'official') target.unreadByOfficial = 0;
      if (body?.markReadFor === 'resident') target.unreadByResident = 0;
      target.updatedAt = new Date().toISOString();
    }
    await saveEdgeSupportChats(existingThreads);
    await bumpEdgePortalRevision();
    return jsonResponse({ success: Boolean(target), thread: target || null, threads: existingThreads });
  }

  if (path === '/api/support-chat' && request.method === 'DELETE') {
    const body: any = await request.json().catch(() => ({}));
    const sessionId = String(reqUrl.searchParams.get('sessionId') || body?.sessionId || '').trim();
    if (!sessionId) {
      return jsonResponse({ success: false, error: 'sessionId is required' }, 400);
    }
    const existingThreads = await getEdgeSupportChats();
    const filtered = existingThreads.filter((t) => String(t.sessionId) !== sessionId);
    await saveEdgeSupportChats(filtered);

    if (activePi && !isPrivateHost(activePi)) {
      await fetch(`${activePi}/api/support-chat?sessionId=${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        headers: PI_EDGE_HEADERS,
      }).catch(() => null);
    }

    await bumpEdgePortalRevision();
    return jsonResponse({ success: true, deletedSessionId: sessionId, threads: filtered });
  }

  return jsonResponse({ success: false, edgeUnhandled: true, path }, 404);
};
