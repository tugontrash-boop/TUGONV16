import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Camera,
  CheckCircle2,
  FileSearch,
  ImagePlus,
  Inbox,
  Loader2,
  MessageSquare,
  RotateCcw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserCheck,
  X,
} from 'lucide-react';
import { SupportChatThread, TugonAiMessage, WasteReport } from '../types';
import { useLanguage } from '../context/LanguageContext';
import { compressImage } from '../utils/imageCompressor';
import { LiveCameraModal } from './LiveCameraModal';
import {
  getAllDeviceReports,
  getOrCreateDeviceId,
  mergeServerUpdatesIntoDeviceReports,
} from '../utils/residentStorage';
import {
  askTugonCentralizedAi,
  deleteSupportChatThread,
  fetchSupportChatThreads,
  fetchUnifiedReports,
  sendSupportChatMessage,
  subscribeToBarangayPortalSync,
  translateTugonAiMessages,
  updateSupportChatStatus,
} from '../utils/piBridge';

interface TugonChatHeadProps {
  currentRole: 'resident' | 'kagawad';
  reports: WasteReport[];
}

type ChatViewMode = 'triage' | 'ai' | 'official';
type OfficialFolderTab = 'INBOX' | 'RESOLVED' | 'SPAM';

const RESIDENT_NAME_STORAGE_KEY = 'tugon_chat_resident_name';
const RESIDENT_BRGY_STORAGE_KEY = 'tugon_chat_resident_barangay';
const CHAT_HEAD_POS_STORAGE_KEY = 'tugon_chat_head_pos';
const BUBBLE_SIZE = 56;
const BUBBLE_MARGIN = 12;

function clampBubblePos(x: number, y: number): { x: number; y: number } {
  if (typeof window === 'undefined') return { x: 16, y: 16 };
  const maxX = Math.max(BUBBLE_MARGIN, window.innerWidth - BUBBLE_SIZE - BUBBLE_MARGIN);
  const maxY = Math.max(BUBBLE_MARGIN, window.innerHeight - BUBBLE_SIZE - BUBBLE_MARGIN);
  return {
    x: Math.round(Math.min(Math.max(BUBBLE_MARGIN, x), maxX)),
    y: Math.round(Math.min(Math.max(BUBBLE_MARGIN, y), maxY)),
  };
}

function snapBubbleToNearestEdge(x: number, y: number): { x: number; y: number } {
  const clamped = clampBubblePos(x, y);
  if (typeof window === 'undefined') return clamped;
  const maxX = Math.max(BUBBLE_MARGIN, window.innerWidth - BUBBLE_SIZE - BUBBLE_MARGIN);
  const maxY = Math.max(BUBBLE_MARGIN, window.innerHeight - BUBBLE_SIZE - BUBBLE_MARGIN);
  const distLeft = clamped.x - BUBBLE_MARGIN;
  const distRight = maxX - clamped.x;
  const distTop = clamped.y - BUBBLE_MARGIN;
  const distBottom = maxY - clamped.y;
  const minDist = Math.min(distLeft, distRight, distTop, distBottom);

  if (minDist === distLeft) return { x: BUBBLE_MARGIN, y: clamped.y };
  if (minDist === distRight) return { x: maxX, y: clamped.y };
  if (minDist === distTop) return { x: clamped.x, y: BUBBLE_MARGIN };
  return { x: clamped.x, y: maxY };
}

function getInitialBubblePos(): { x: number; y: number } {
  if (typeof window === 'undefined') return { x: 16, y: 16 };
  try {
    const raw = localStorage.getItem(CHAT_HEAD_POS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number') {
        return snapBubbleToNearestEdge(parsed.x, parsed.y);
      }
    }
  } catch {}
  return snapBubbleToNearestEdge(window.innerWidth - BUBBLE_SIZE - 16, window.innerHeight - BUBBLE_SIZE - 16);
}

function formatShortTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-PH', {
    timeZone: 'Asia/Manila',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getStatusBadgeClasses(status: WasteReport['status']): string {
  if (status === 'RESOLVED') return 'bg-emerald-100 text-emerald-800 border-emerald-200';
  if (status === 'DISPATCHED') return 'bg-sky-100 text-sky-800 border-sky-200';
  if (status === 'CANCELLED') return 'bg-slate-200 text-slate-700 border-slate-300';
  return 'bg-amber-100 text-amber-800 border-amber-200';
}

export const TugonChatHead: React.FC<TugonChatHeadProps> = ({ currentRole, reports }) => {
  const { language } = useLanguage();
  const isEn = language === 'en';

  const deviceId = useMemo(() => getOrCreateDeviceId(), []);
  const residentSessionId = useMemo(() => `resident_${deviceId}`, [deviceId]);
  const aiStorageKey = useMemo(
    () => (currentRole === 'resident' ? `tugon_ai_history_${deviceId}` : 'tugon_ai_history_official'),
    [currentRole, deviceId]
  );

  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState<ChatViewMode>('triage');
  const [bubblePos, setBubblePos] = useState<{ x: number; y: number }>(() => getInitialBubblePos());
  const [isDragging, setIsDragging] = useState(false);
  const [viewportSize, setViewportSize] = useState<{ w: number; h: number }>(() =>
    typeof window !== 'undefined'
      ? { w: window.innerWidth, h: window.innerHeight }
      : { w: 1024, h: 768 }
  );
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    hasMoved: boolean;
  } | null>(null);
  const didDragRef = useRef(false);

  useEffect(() => {
    const handleResize = () => {
      setViewportSize({ w: window.innerWidth, h: window.innerHeight });
      setBubblePos((prev) => snapBubbleToNearestEdge(prev.x, prev.y));
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const drawerLayout = useMemo(() => {
    const vw = viewportSize.w;
    const vh = viewportSize.h;
    const drawerW = Math.min(392, Math.max(280, vw - 24));
    const drawerH = Math.min(Math.round(vh * 0.76), 560);
    const bubbleCenterX = bubblePos.x + BUBBLE_SIZE / 2;
    const desiredLeft = bubbleCenterX < vw / 2 ? bubblePos.x : bubblePos.x + BUBBLE_SIZE - drawerW;
    const left = Math.round(Math.min(Math.max(BUBBLE_MARGIN, desiredLeft), Math.max(BUBBLE_MARGIN, vw - drawerW - BUBBLE_MARGIN)));

    const spaceAbove = bubblePos.y - BUBBLE_MARGIN;
    const spaceBelow = vh - (bubblePos.y + BUBBLE_SIZE) - BUBBLE_MARGIN;
    let top: number;
    if (spaceAbove >= drawerH + 10) {
      top = bubblePos.y - drawerH - 10;
    } else if (spaceBelow >= drawerH + 10) {
      top = bubblePos.y + BUBBLE_SIZE + 10;
    } else if (spaceAbove >= spaceBelow) {
      top = Math.max(BUBBLE_MARGIN, bubblePos.y - drawerH - 10);
    } else {
      top = Math.min(vh - drawerH - BUBBLE_MARGIN, bubblePos.y + BUBBLE_SIZE + 10);
    }
    top = Math.round(Math.min(Math.max(BUBBLE_MARGIN, top), Math.max(BUBBLE_MARGIN, vh - drawerH - BUBBLE_MARGIN)));
    return { left, top, width: drawerW, height: drawerH };
  }, [bubblePos, viewportSize]);

  // Per-phone AI history (or official portal AI history), persisted locally without auto-purge
  const [aiMessages, setAiMessages] = useState<TugonAiMessage[]>(() => {
    try {
      const raw = localStorage.getItem(aiStorageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [aiInput, setAiInput] = useState('');
  const [aiPendingImage, setAiPendingImage] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiTranslating, setAiTranslating] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [isAiLiveCamOpen, setIsAiLiveCamOpen] = useState(false);
  const aiPhotoInputRef = useRef<HTMLInputElement | null>(null);
  const inFlightTranslationKeysRef = useRef<Set<string>>(new Set());
  const latestLanguageRef = useRef<'tl' | 'en'>(language);
  latestLanguageRef.current = language;

  // Per-phone resident reports (isolated) vs official all-in-one queue
  const [residentDeviceReports, setResidentDeviceReports] = useState<WasteReport[]>([]);
  const [showReportPicker, setShowReportPicker] = useState(false);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [handoffNotice, setHandoffNotice] = useState<{
    folder: 'INBOX' | 'SPAM';
    reason?: string;
    ticketNumber?: string;
  } | null>(null);

  // Live Resident <-> Barangay Official support chat state
  const [residentName, setResidentName] = useState<string>(() => {
    try {
      return localStorage.getItem(RESIDENT_NAME_STORAGE_KEY) || '';
    } catch {
      return '';
    }
  });
  const [residentBarangay, setResidentBarangay] = useState<string>(() => {
    try {
      return localStorage.getItem(RESIDENT_BRGY_STORAGE_KEY) || 'Barangay 40';
    } catch {
      return 'Barangay 40';
    }
  });
  const [residentTicket, setResidentTicket] = useState<string>('');
  const [threads, setThreads] = useState<SupportChatThread[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [officialTab, setOfficialTab] = useState<OfficialFolderTab>('INBOX');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [supportInput, setSupportInput] = useState('');
  const [supportSending, setSupportSending] = useState(false);
  const [supportError, setSupportError] = useState<string | null>(null);

  const aiEndRef = useRef<HTMLDivElement | null>(null);
  const supportEndRef = useRef<HTMLDivElement | null>(null);

  // Sync AI history when switching role/storage key
  useEffect(() => {
    try {
      const raw = localStorage.getItem(aiStorageKey);
      const parsed = raw ? JSON.parse(raw) : [];
      setAiMessages(Array.isArray(parsed) ? parsed : []);
    } catch {
      setAiMessages([]);
    }
  }, [aiStorageKey]);

  useEffect(() => {
    try {
      const compact = aiMessages.map(({ imagePreview: _img, ...rest }) => rest);
      localStorage.setItem(aiStorageKey, JSON.stringify(compact));
    } catch {}
  }, [aiMessages, aiStorageKey]);

  // Dynamically sync & translate existing Gemini AI replies whenever main interface language changes
  useEffect(() => {
    let needsSwap = false;
    const missingItems: { id: string; text: string }[] = [];

    for (const m of aiMessages) {
      if (m.role !== 'assistant' || !m.text?.trim()) continue;
      const cachedForLang = m.translations?.[language];
      if (cachedForLang) {
        if (cachedForLang !== m.text || m.lang !== language) {
          needsSwap = true;
        }
        continue;
      }
      if (m.lang === language) {
        needsSwap = true;
        continue;
      }
      const key = `${m.id}:${language}`;
      if (!inFlightTranslationKeysRef.current.has(key)) {
        missingItems.push({ id: m.id, text: m.text });
      }
    }

    if (needsSwap) {
      setAiMessages((prev) =>
        prev.map((m) => {
          if (m.role !== 'assistant' || !m.text?.trim()) return m;
          const cached = m.translations?.[language];
          if (cached) {
            return { ...m, text: cached, lang: language };
          }
          if (m.lang === language) {
            return {
              ...m,
              translations: { ...(m.translations || {}), [language]: m.text },
            };
          }
          return m;
        })
      );
    }

    if (missingItems.length === 0) return;

    const requestedLang = language;
    for (const item of missingItems) {
      inFlightTranslationKeysRef.current.add(`${item.id}:${requestedLang}`);
    }
    setAiTranslating(true);

    translateTugonAiMessages({ items: missingItems, targetLang: requestedLang })
      .then((res) => {
        if (!res.ok || !res.translations) return;
        const translatedMap = res.translations;
        setAiMessages((prev) =>
          prev.map((m) => {
            const tr = translatedMap[m.id];
            if (!tr) return m;
            const updatedTranslations = {
              ...(m.translations || {}),
              ...(m.lang && m.text ? { [m.lang]: m.text } : {}),
              [requestedLang]: tr,
            };
            if (latestLanguageRef.current !== requestedLang) {
              return { ...m, translations: updatedTranslations };
            }
            return {
              ...m,
              text: tr,
              lang: requestedLang,
              translations: updatedTranslations,
            };
          })
        );
      })
      .finally(() => {
        for (const item of missingItems) {
          inFlightTranslationKeysRef.current.delete(`${item.id}:${requestedLang}`);
        }
        if (latestLanguageRef.current === requestedLang) {
          setAiTranslating(false);
        }
      });
  }, [language, aiMessages]);

  const officialDisplayName = useMemo(() => {
    try {
      return localStorage.getItem('pulse_account_label') || 'Barangay Kagawad';
    } catch {
      return 'Barangay Kagawad';
    }
  }, [currentRole, isOpen]);

  // Load ONLY this phone's reports when on resident side (isolated per phone)
  const refreshResidentDeviceReports = useCallback(async () => {
    if (currentRole !== 'resident') return;
    try {
      const localList = await getAllDeviceReports();
      setResidentDeviceReports(localList);
      const ids = localList.map((r) => r.id).filter(Boolean);
      if (ids.length > 0) {
        const synced = await fetchUnifiedReports(language, ids);
        if (synced.reports.length > 0) {
          const merged = await mergeServerUpdatesIntoDeviceReports(synced.reports);
          setResidentDeviceReports(merged);
        }
      }
    } catch {}
  }, [currentRole, language]);

  useEffect(() => {
    if (isOpen && currentRole === 'resident') {
      refreshResidentDeviceReports();
    }
  }, [isOpen, currentRole, refreshResidentDeviceReports]);

  const availableReports = useMemo(() => {
    const source = currentRole === 'resident' ? residentDeviceReports : reports;
    return [...source].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }, [currentRole, residentDeviceReports, reports]);

  const selectedReport = useMemo(() => {
    if (!selectedReportId) return null;
    return (
      availableReports.find(
        (r) => r.id === selectedReportId || r.ticketNumber === selectedReportId
      ) || null
    );
  }, [availableReports, selectedReportId]);

  const loadThreads = useCallback(async () => {
    try {
      const list = await fetchSupportChatThreads(
        currentRole === 'resident' ? residentSessionId : undefined
      );
      setThreads(list);
    } catch {}
  }, [currentRole, residentSessionId]);

  useEffect(() => {
    loadThreads();
    const pollMs = isOpen && mode === 'official' ? 2500 : 8000;
    const interval = setInterval(loadThreads, pollMs);
    let unsubscribe = () => {};
    if (currentRole === 'kagawad') {
      unsubscribe = subscribeToBarangayPortalSync(() => {
        loadThreads();
      });
    }
    return () => {
      clearInterval(interval);
      unsubscribe();
    };
  }, [currentRole, isOpen, mode, loadThreads]);

  const activeThread = useMemo(() => {
    if (currentRole === 'resident') {
      return threads.find((t) => t.sessionId === residentSessionId) || null;
    }
    if (!selectedSessionId) return null;
    return threads.find((t) => t.sessionId === selectedSessionId) || null;
  }, [currentRole, threads, residentSessionId, selectedSessionId]);

  const unreadCount = useMemo(() => {
    if (currentRole === 'resident') {
      return Number(activeThread?.unreadByResident || 0);
    }
    return threads
      .filter((t) => t.folder !== 'SPAM')
      .reduce((acc, t) => acc + Number(t.unreadByOfficial || 0), 0);
  }, [currentRole, activeThread, threads]);

  // Mark messages read when actively viewing the thread
  useEffect(() => {
    if (!isOpen || mode !== 'official' || !activeThread) return;
    if (currentRole === 'resident' && activeThread.unreadByResident > 0) {
      updateSupportChatStatus({ sessionId: activeThread.sessionId, markReadFor: 'resident' }).then(
        (res) => {
          if (res.threads) setThreads(res.threads);
        }
      );
    } else if (currentRole === 'kagawad' && activeThread.unreadByOfficial > 0) {
      updateSupportChatStatus({ sessionId: activeThread.sessionId, markReadFor: 'official' }).then(
        (res) => {
          if (res.threads) setThreads(res.threads);
        }
      );
    }
  }, [isOpen, mode, currentRole, activeThread]);

  useEffect(() => {
    aiEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [aiMessages, aiLoading, mode]);

  useEffect(() => {
    supportEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeThread?.messages?.length, mode, selectedSessionId]);

  const handleSelectAiPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const compressed = await compressImage(file, 800, 800, 0.72);
      if (compressed) {
        setAiPendingImage(compressed);
        setMode('ai');
        setAiError(null);
      }
    } catch {}
  };

  const handleSendAi = async (customText?: string, overrideSelectedReport?: WasteReport | null) => {
    const attachedImg = !customText ? aiPendingImage : null;
    const clean = String(customText ?? aiInput).trim();
    if ((!clean && !attachedImg) || aiLoading) return;
    if (!customText) {
      setAiInput('');
      setAiPendingImage(null);
    }
    setAiError(null);

    const activeSelectedReport =
      overrideSelectedReport !== undefined ? overrideSelectedReport : selectedReport;

    const displayPrompt =
      clean ||
      (isEn
        ? 'Please inspect this waste photo for Barangay 40/41 T.U.G.O.N.'
        : 'Pakisuri ang litrato ng basura na ito para sa T.U.G.O.N. Barangay 40/41.');

    const userMsg: TugonAiMessage = {
      id: `ai-u-${Date.now()}`,
      role: 'user',
      text: displayPrompt,
      timestamp: new Date().toISOString(),
      ticketNumber: activeSelectedReport?.ticketNumber,
      imagePreview: attachedImg || undefined,
    };
    const nextHistory = [...aiMessages, userMsg];
    setAiMessages(nextHistory);
    setAiLoading(true);

    // Ensure resident device reports list is fresh before asking AI
    let latestResidentReports = residentDeviceReports;
    if (currentRole === 'resident' && residentDeviceReports.length === 0) {
      try {
        latestResidentReports = await getAllDeviceReports();
        setResidentDeviceReports(latestResidentReports);
      } catch {}
    }

    const res = await askTugonCentralizedAi({
      message: displayPrompt,
      history: aiMessages,
      lang: language,
      role: currentRole,
      residentReports: currentRole === 'resident' ? latestResidentReports : undefined,
      selectedReportId: activeSelectedReport?.id || activeSelectedReport?.ticketNumber || undefined,
      imageDataUrl: attachedImg || undefined,
    });
    setAiLoading(false);

    if (res.ok && res.reply) {
      const assistantMsg: TugonAiMessage = {
        id: `ai-a-${Date.now()}`,
        role: 'assistant',
        text: res.reply,
        timestamp: new Date().toISOString(),
        ticketNumber: activeSelectedReport?.ticketNumber,
        handoffTriggered: res.wantsOfficialHandoff,
        classification: res.handoffClassification,
        modelUsed: res.modelUsed,
        lang: language,
        translations: { [language]: res.reply },
      };
      setAiMessages((prev) => [...prev, assistantMsg]);

      // Natural-language handoff: push info + context to Official side & auto-transfer resident
      if (res.wantsOfficialHandoff && currentRole === 'resident') {
        const resolvedName =
          residentName.trim() ||
          activeSelectedReport?.residentName ||
          (isEn ? 'Resident' : 'Residente');
        const resolvedBrgy =
          activeSelectedReport?.barangay === 'Barangay 40' ||
          activeSelectedReport?.barangay === 'Barangay 41'
            ? activeSelectedReport.barangay
            : residentBarangay;
        const resolvedTicket = activeSelectedReport?.ticketNumber || residentTicket.trim();

        if (!residentName.trim() && activeSelectedReport?.residentName) {
          setResidentName(activeSelectedReport.residentName);
        }
        if (
          activeSelectedReport?.barangay === 'Barangay 40' ||
          activeSelectedReport?.barangay === 'Barangay 41'
        ) {
          setResidentBarangay(activeSelectedReport.barangay);
        }
        if (resolvedTicket) {
          setResidentTicket(resolvedTicket);
        }

        const reportContextLine = activeSelectedReport
          ? `[Report ${activeSelectedReport.ticketNumber} · Status: ${activeSelectedReport.status} · ${activeSelectedReport.barangay || resolvedBrgy}${
              activeSelectedReport.purok ? `, ${activeSelectedReport.purok}` : ''
            }] `
          : '';
        const summaryHeader = res.handoffSummary ? `${reportContextLine}${res.handoffSummary}` : undefined;

        const scRes = await sendSupportChatMessage({
          sessionId: residentSessionId,
          sender: 'resident',
          senderName: resolvedName,
          residentName: resolvedName,
          barangay: resolvedBrgy,
          ticketNumber: resolvedTicket,
          text: `${reportContextLine}${clean}`,
          lang: language,
          requestOfficial: true,
          aiHandoffSummary: summaryHeader,
          handoffClassification: res.handoffClassification,
          spamReason: res.moderationReason,
        });

        if (scRes.ok) {
          if (Array.isArray(scRes.threads)) {
            setThreads(scRes.threads);
          } else {
            await loadThreads();
          }
          setHandoffNotice({
            folder: scRes.folder || (res.handoffClassification === 'SPAM_REDUNDANT' ? 'SPAM' : 'INBOX'),
            reason: scRes.spamReason || res.moderationReason,
            ticketNumber: resolvedTicket || undefined,
          });
          setMode('official');
        }
      }
    } else {
      setAiError(
        res.error ||
          (isEn
            ? 'T.U.G.O.N. AI could not respond right now.'
            : 'Hindi makasagot ang T.U.G.O.N. AI sa ngayon.')
      );
    }
  };

  const handleSendSupport = async () => {
    const clean = supportInput.trim();
    if (!clean || supportSending) return;

    const targetSession =
      currentRole === 'resident' ? residentSessionId : selectedSessionId || '';
    if (!targetSession) return;

    setSupportError(null);
    setSupportSending(true);
    const trimmedName = residentName.trim();
    if (currentRole === 'resident') {
      try {
        if (trimmedName) localStorage.setItem(RESIDENT_NAME_STORAGE_KEY, trimmedName);
        localStorage.setItem(RESIDENT_BRGY_STORAGE_KEY, residentBarangay);
      } catch {}
    }

    const res = await sendSupportChatMessage({
      sessionId: targetSession,
      sender: currentRole === 'kagawad' ? 'official' : 'resident',
      senderName:
        currentRole === 'kagawad'
          ? officialDisplayName
          : trimmedName || (isEn ? 'Resident' : 'Residente'),
      residentName:
        currentRole === 'resident'
          ? trimmedName || (isEn ? 'Resident' : 'Residente')
          : activeThread?.residentName,
      barangay: currentRole === 'resident' ? residentBarangay : activeThread?.barangay,
      ticketNumber:
        currentRole === 'resident' ? residentTicket.trim() : activeThread?.ticketNumber,
      text: clean,
      lang: language,
      requestOfficial: currentRole === 'resident',
    });

    setSupportSending(false);
    if (res.ok) {
      setSupportInput('');
      if (currentRole === 'resident' && res.folder) {
        setHandoffNotice({
          folder: res.folder,
          reason: res.spamReason,
          ticketNumber: residentTicket.trim() || undefined,
        });
      }
      if (Array.isArray(res.threads)) {
        setThreads(res.threads);
      } else {
        await loadThreads();
      }
    } else {
      setSupportError(
        res.error ||
          (isEn
            ? 'Message failed to send. Check connection and try again.'
            : 'Hindi naipadala ang mensahe. Suriin ang koneksyon at subukan muli.')
      );
    }
  };

  const handleToggleThreadStatus = async (thread: SupportChatThread) => {
    const nextStatus = thread.status === 'RESOLVED' ? 'NEEDS_OFFICIAL' : 'RESOLVED';
    const res = await updateSupportChatStatus({
      sessionId: thread.sessionId,
      status: nextStatus,
      markReadFor: 'official',
    });
    if (res.threads) setThreads(res.threads);
    else loadThreads();
  };

  const handleMoveSpamToInbox = async (thread: SupportChatThread) => {
    const res = await updateSupportChatStatus({
      sessionId: thread.sessionId,
      folder: 'INBOX',
      status: 'NEEDS_OFFICIAL',
      markReadFor: 'official',
    });
    if (res.threads) setThreads(res.threads);
    else loadThreads();
  };

  const handleDeleteThread = async (sessionId: string) => {
    const res = await deleteSupportChatThread(sessionId);
    setConfirmDeleteId(null);
    if (res.ok) {
      if (selectedSessionId === sessionId) setSelectedSessionId(null);
      if (res.threads) setThreads(res.threads);
      else loadThreads();
    }
  };

  const tabCounts = useMemo(() => {
    const inbox = threads.filter((t) => t.folder !== 'SPAM' && t.status !== 'RESOLVED').length;
    const resolved = threads.filter((t) => t.folder !== 'SPAM' && t.status === 'RESOLVED').length;
    const spam = threads.filter((t) => t.folder === 'SPAM').length;
    return { inbox, resolved, spam };
  }, [threads]);

  const filteredOfficialThreads = useMemo(() => {
    if (officialTab === 'SPAM') return threads.filter((t) => t.folder === 'SPAM');
    if (officialTab === 'RESOLVED')
      return threads.filter((t) => t.folder !== 'SPAM' && t.status === 'RESOLVED');
    return threads.filter((t) => t.folder !== 'SPAM' && t.status !== 'RESOLVED');
  }, [threads, officialTab]);

  const openAiWithStarter = (starterPrompt: string) => {
    setMode('ai');
    handleSendAi(starterPrompt);
  };

  const handleSelectReportForAi = (report: WasteReport) => {
    setSelectedReportId(report.id);
    setShowReportPicker(false);
    setMode('ai');
    if (currentRole === 'resident') {
      if (!residentName.trim() && report.residentName) setResidentName(report.residentName);
      if (report.barangay === 'Barangay 40' || report.barangay === 'Barangay 41') {
        setResidentBarangay(report.barangay);
      }
      if (report.ticketNumber) setResidentTicket(report.ticketNumber);
    }
  };

  const handlePushUnresolvedToOfficial = () => {
    if (!selectedReport) return;
    const prompt = isEn
      ? `Please transfer me to a Barangay Official to follow up on my unresolved report ${selectedReport.ticketNumber} (${selectedReport.status}).`
      : `Pakikonekta ako sa Barangay Official para i-follow up ang hindi pa tapos na report ${selectedReport.ticketNumber} (${selectedReport.status}).`;
    handleSendAi(prompt, selectedReport);
  };

  const isSelectedUnresolved =
    selectedReport &&
    (selectedReport.status === 'PENDING' || selectedReport.status === 'DISPATCHED');

  return (
    <>
      {isOpen && (
        <section
          aria-label={isEn ? 'T.U.G.O.N. Support & AI Assistant' : 'T.U.G.O.N. Assistant at Opisyal'}
          style={{
            left: `${drawerLayout.left}px`,
            top: `${drawerLayout.top}px`,
            width: `${drawerLayout.width}px`,
            height: `${drawerLayout.height}px`,
          }}
          className="fixed z-40 bg-white border border-slate-200 rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        >
          <input
            ref={aiPhotoInputRef}
            type="file"
            accept="image/*"
            onChange={handleSelectAiPhoto}
            className="hidden"
          />
          {/* Drawer Header */}
          <div className="bg-emerald-800 text-white px-4 py-3 flex items-center justify-between gap-2 shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
              {mode !== 'triage' && (
                <button
                  type="button"
                  onClick={() => {
                    if (mode === 'official' && currentRole === 'kagawad' && selectedSessionId) {
                      setSelectedSessionId(null);
                      setConfirmDeleteId(null);
                    } else {
                      setMode('triage');
                    }
                  }}
                  aria-label={isEn ? 'Back' : 'Bumalik'}
                  className="p-1.5 -ml-1.5 rounded-lg hover:bg-emerald-700/80 transition-colors shrink-0"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
              )}
              <img
                src="/icon.svg"
                alt="T.U.G.O.N."
                className="w-9 h-9 rounded-full bg-white p-0.5 object-cover border border-emerald-300/60 shrink-0"
              />
              <div className="min-w-0">
                <h2 className="text-sm font-extrabold tracking-tight truncate">
                  {mode === 'ai'
                    ? 'T.U.G.O.N. AI Help'
                    : mode === 'official'
                      ? currentRole === 'kagawad'
                        ? isEn
                          ? 'Resident Live Chat'
                          : 'Live Chat ng Residente'
                        : isEn
                          ? 'Barangay Official Chat'
                          : 'Usapan sa Barangay Official'
                      : 'T.U.G.O.N. Assistant'}
                </h2>
                <p className="text-[11px] text-emerald-100/90 truncate flex items-center gap-1">
                  {mode === 'ai' ? (
                    <>
                      <Sparkles className="w-3 h-3 text-emerald-200 shrink-0" />
                      <span className="truncate">
                        {currentRole === 'resident'
                          ? isEn
                            ? 'Gemini AI · Your Device Tickets'
                            : 'Gemini AI · Mga Report sa Device Mo'
                          : isEn
                            ? 'Gemini AI · Barangay 40 & 41 Portal'
                            : 'Gemini AI · Barangay 40 & 41 Portal'}
                      </span>
                    </>
                  ) : mode === 'official' ? (
                    currentRole === 'kagawad'
                      ? `${tabCounts.inbox} ${isEn ? 'inbox' : 'inbox'} · ${tabCounts.spam} ${isEn ? 'spam' : 'spam'}`
                      : 'Barangay 40 & 41 · Cavite City'
                  ) : (
                    'Barangay 40 & 41 · Cavite City'
                  )}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {mode === 'ai' && aiMessages.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setAiMessages([]);
                    setAiError(null);
                    try {
                      localStorage.removeItem(aiStorageKey);
                    } catch {}
                  }}
                  title={isEn ? 'Reset AI chat' : 'I-reset ang AI chat'}
                  aria-label={isEn ? 'Reset AI chat' : 'I-reset ang AI chat'}
                  className="p-2 rounded-lg hover:bg-emerald-700/80 transition-colors"
                >
                  <RotateCcw className="w-4 h-4" />
                </button>
              )}
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                aria-label={isEn ? 'Close chat' : 'Isara ang chat'}
                className="p-2 rounded-lg hover:bg-emerald-700/80 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Body: Triage Home */}
          {mode === 'triage' && (
            <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-50">
              <div className="flex items-start gap-2.5">
                <img
                  src="/icon.svg"
                  alt="T.U.G.O.N. AI"
                  className="w-8 h-8 rounded-full border border-emerald-200 bg-white p-0.5 shrink-0 mt-0.5"
                />
                <div className="bg-white border border-slate-200 rounded-2xl rounded-tl-sm px-3.5 py-3 shadow-xs text-xs text-slate-700 leading-relaxed space-y-1.5">
                  <p className="font-bold text-slate-900">
                    {isEn
                      ? 'Mabuhay! Welcome to T.U.G.O.N. Help Desk.'
                      : 'Mabuhay! Maligayang pagdating sa T.U.G.O.N. Help Desk.'}
                  </p>
                  <p>
                    {currentRole === 'kagawad'
                      ? isEn
                        ? 'I can answer questions across all Barangay 40 & 41 reports and portal workflows, or open the Resident Inbox & Spam filter.'
                        : 'Matutulungan kita sa lahat ng Barangay 40 & 41 reports at portal workflows, o buksan ang Resident Inbox at Spam folder.'
                      : isEn
                        ? 'I am the built-in AI for T.U.G.O.N. I can check the status of reports sent from this phone or transfer you to a Barangay Official.'
                        : 'Ako ang built-in AI para sa T.U.G.O.N. Maaari kong tingnan ang mga report na ipinadala mula sa teleponong ito o ikonekta ka sa Barangay Official.'}
                  </p>
                </div>
              </div>

              <div className="space-y-2.5">
                <button
                  type="button"
                  onClick={() => setMode('ai')}
                  className="w-full min-h-[56px] text-left bg-white hover:bg-emerald-50/70 border border-emerald-200 hover:border-emerald-400 rounded-xl px-3.5 py-3 transition-colors flex items-center gap-3 shadow-xs"
                >
                  <div className="w-10 h-10 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
                    <Bot className="w-5 h-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-extrabold text-slate-900">
                      {isEn ? 'Talk with AI (App Help & Reports)' : 'Talk with AI (Tulong at Ticket Check)'}
                    </div>
                    <p className="text-[11px] text-slate-500 leading-snug mt-0.5">
                      {currentRole === 'resident'
                        ? isEn
                          ? 'Ask anything about T.U.G.O.N., check your phone’s tickets, or request an official'
                          : 'Magtanong tungkol sa T.U.G.O.N., i-check ang ticket mo, o humiling ng opisyal'
                        : isEn
                          ? 'Brgy 40 & 41 portal guide & queue lookup'
                          : 'Gabay at summary ng mga ulat sa Barangay 40 & 41'}
                    </p>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setMode('official')}
                  className="w-full min-h-[56px] text-left bg-white hover:bg-sky-50/70 border border-slate-200 hover:border-sky-400 rounded-xl px-3.5 py-3 transition-colors flex items-center gap-3 shadow-xs"
                >
                  <div className="w-10 h-10 rounded-full bg-sky-100 text-sky-700 flex items-center justify-center shrink-0">
                    <UserCheck className="w-5 h-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-extrabold text-slate-900 truncate">
                        {currentRole === 'kagawad'
                          ? isEn
                            ? 'Talk with Residents (Official Inbox)'
                            : 'Talk with Residents (Inbox ng Opisyal)'
                          : isEn
                            ? 'Talk with Barangay Official (Important)'
                            : 'Talk with Barangay Official (Mahalaga)'}
                      </span>
                      {unreadCount > 0 && (
                        <span className="px-1.5 py-0.5 rounded-md bg-rose-600 text-white text-[10px] font-bold shrink-0">
                          {unreadCount}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-500 leading-snug mt-0.5">
                      {currentRole === 'kagawad'
                        ? isEn
                          ? 'Official Inbox, Resolved threads, & Spam Folder'
                          : 'Inbox ng Opisyal, Tapos Na, at Spam Folder'
                        : isEn
                          ? 'Direct chat with Barangay 40 & 41 Officials'
                          : 'Direktang pakikipag-usap sa Barangay Official (Brgy 40 & 41)'}
                    </p>
                  </div>
                </button>
              </div>

              <div className="pt-1 border-t border-slate-200/80 space-y-2">
                <p className="text-[11px] font-bold text-slate-500">
                  {isEn ? 'Quick T.U.G.O.N. AI questions' : 'Mabilisang tanong sa T.U.G.O.N. AI'}
                </p>
                <div className="flex flex-col gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      if (currentRole === 'resident') refreshResidentDeviceReports();
                      setShowReportPicker((v) => !v);
                    }}
                    className="text-left text-xs text-sky-900 bg-sky-50 hover:bg-sky-100 border border-sky-200 rounded-lg px-3 py-2 font-bold transition-colors flex items-center justify-between gap-2"
                  >
                    <span className="flex items-center gap-1.5">
                      <FileSearch className="w-3.5 h-3.5 text-sky-700 shrink-0" />
                      {isEn ? 'Ask about a report' : 'Magtanong tungkol sa isang report'}
                    </span>
                    <span className="text-[10px] font-extrabold px-1.5 py-0.5 rounded bg-white text-sky-800 border border-sky-200">
                      {availableReports.length}
                    </span>
                  </button>

                  {showReportPicker && (
                    <div className="bg-white border border-sky-200 rounded-xl p-2 space-y-1.5 max-h-48 overflow-y-auto shadow-xs">
                      {availableReports.length === 0 ? (
                        <p className="text-[11px] text-slate-500 px-2 py-2 text-center">
                          {currentRole === 'resident'
                            ? isEn
                              ? 'No waste reports submitted from this phone yet.'
                              : 'Wala pang report na naipadala mula sa teleponong ito.'
                            : isEn
                              ? 'No reports found in the queue.'
                              : 'Walang report sa queue.'}
                        </p>
                      ) : (
                        availableReports.map((rep) => (
                          <button
                            key={rep.id}
                            type="button"
                            onClick={() => handleSelectReportForAi(rep)}
                            className="w-full text-left p-2 rounded-lg border border-slate-200 hover:border-sky-400 hover:bg-sky-50/50 transition-colors space-y-0.5"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[11px] font-extrabold text-slate-900 truncate">
                                #{rep.ticketNumber}
                              </span>
                              <span
                                className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${getStatusBadgeClasses(
                                  rep.status
                                )}`}
                              >
                                {rep.status}
                              </span>
                            </div>
                            <p className="text-[11px] text-slate-600 truncate">
                              {rep.barangay || 'Brgy 40/41'} · {rep.wasteTypes?.join(', ') || 'Waste report'}
                            </p>
                          </button>
                        ))
                      )}
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setMode('ai');
                        aiPhotoInputRef.current?.click();
                      }}
                      className="text-left text-xs text-emerald-900 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg px-2.5 py-2 font-bold transition-colors flex items-center gap-1.5"
                    >
                      <ImagePlus className="w-3.5 h-3.5 text-emerald-700 shrink-0" />
                      <span className="truncate">
                        {isEn ? 'Attach Photo' : 'Attach File'}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMode('ai');
                        setIsAiLiveCamOpen(true);
                      }}
                      className="text-left text-xs text-emerald-900 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg px-2.5 py-2 font-bold transition-colors flex items-center gap-1.5"
                    >
                      <Camera className="w-3.5 h-3.5 text-emerald-700 shrink-0" />
                      <span className="truncate">
                        {isEn ? 'Live Camera' : 'Live Cam'}
                      </span>
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      openAiWithStarter(
                        isEn
                          ? 'How do I submit a waste collection report in T.U.G.O.N.?'
                          : 'Paano magpadala ng waste report sa T.U.G.O.N.?'
                      )
                    }
                    className="text-left text-xs text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200/80 rounded-lg px-3 py-2 font-medium transition-colors"
                  >
                    {isEn
                      ? 'How do I submit a waste collection report?'
                      : 'Paano magpadala ng waste report sa T.U.G.O.N.?'}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      openAiWithStarter(
                        isEn
                          ? 'What are the report status steps (Pending, Dispatched, Resolved) and how do I talk with a Barangay Official?'
                          : 'Ano ang ibig sabihin ng Pending, Dispatched, at Resolved at paano makipag-usap sa Barangay Official?'
                      )
                    }
                    className="text-left text-xs text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200/80 rounded-lg px-3 py-2 font-medium transition-colors"
                  >
                    {isEn
                      ? 'Explain ticket stages & Barangay Official escalation'
                      : 'Gabay sa ticket stages at pag-contact sa Barangay Official'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Body: Centralized T.U.G.O.N. AI Chat */}
          {mode === 'ai' && (
            <>
              <div className="px-3.5 py-2 bg-emerald-50/80 border-b border-emerald-100 flex items-center justify-between gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    if (currentRole === 'resident') refreshResidentDeviceReports();
                    setShowReportPicker((v) => !v);
                  }}
                  className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-900 hover:text-emerald-700 truncate"
                >
                  <FileSearch className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">
                    {selectedReport
                      ? `#${selectedReport.ticketNumber}`
                      : isEn
                        ? 'Select a report'
                        : 'Pumili ng report'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setMode('official')}
                  className="text-[11px] font-bold text-sky-700 hover:text-sky-900 underline whitespace-nowrap shrink-0"
                >
                  {isEn ? 'Talk with Official' : 'Kausapin ang Opisyal'}
                </button>
              </div>

              {/* Inline Report Picker inside AI View */}
              {showReportPicker && (
                <div className="px-3 py-2 bg-sky-50 border-b border-sky-200 max-h-44 overflow-y-auto space-y-1.5 shrink-0">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold text-sky-900">
                      {currentRole === 'resident'
                        ? isEn
                          ? 'Reports submitted from this phone:'
                          : 'Mga report mula sa phone na ito:'
                        : isEn
                          ? 'All Barangay 40 & 41 reports:'
                          : 'Lahat ng report sa Brgy 40 & 41:'}
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowReportPicker(false)}
                      className="text-[10px] font-bold text-slate-600 hover:text-slate-900"
                    >
                      {isEn ? 'Close' : 'Isara'}
                    </button>
                  </div>
                  {availableReports.length === 0 ? (
                    <p className="text-[11px] text-slate-600 py-1">
                      {isEn
                        ? 'No reports found yet on this phone.'
                        : 'Wala pang naipadalang report sa teleponong ito.'}
                    </p>
                  ) : (
                    availableReports.map((rep) => (
                      <button
                        key={rep.id}
                        type="button"
                        onClick={() => handleSelectReportForAi(rep)}
                        className="w-full text-left bg-white hover:bg-sky-100/50 border border-sky-200 rounded-lg px-2.5 py-1.5 flex items-center justify-between gap-2"
                      >
                        <div className="min-w-0">
                          <div className="text-[11px] font-extrabold text-slate-900 truncate">
                            #{rep.ticketNumber}
                          </div>
                          <div className="text-[10px] text-slate-500 truncate">
                            {rep.barangay || 'Brgy 40/41'} · {rep.wasteTypes?.join(', ') || 'Report'}
                          </div>
                        </div>
                        <span
                          className={`text-[10px] font-bold px-1.5 py-0.5 rounded border shrink-0 ${getStatusBadgeClasses(
                            rep.status
                          )}`}
                        >
                          {rep.status}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}

              {/* Focused Selected Report Banner */}
              {selectedReport && (
                <div className="px-3 py-2 bg-sky-50/90 border-b border-sky-200 flex items-center justify-between gap-2 shrink-0">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-extrabold text-sky-950 truncate">
                        #{selectedReport.ticketNumber}
                      </span>
                      <span
                        className={`text-[10px] font-bold px-1.5 py-0.5 rounded border shrink-0 ${getStatusBadgeClasses(
                          selectedReport.status
                        )}`}
                      >
                        {selectedReport.status}
                      </span>
                    </div>
                    <p className="text-[10px] text-sky-800 truncate">
                      {selectedReport.barangay || 'Brgy 40/41'} ·{' '}
                      {selectedReport.wasteTypes?.join(', ') || 'Concern'}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {currentRole === 'resident' && isSelectedUnresolved && (
                      <button
                        type="button"
                        onClick={handlePushUnresolvedToOfficial}
                        disabled={aiLoading}
                        className="px-2 py-1 rounded-lg bg-sky-700 hover:bg-sky-800 disabled:opacity-50 text-white text-[10px] font-bold whitespace-nowrap"
                      >
                        {isEn ? 'Escalate to Official' : 'Ipasa sa Opisyal'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setSelectedReportId(null)}
                      aria-label={isEn ? 'Clear selected report' : 'Alisin ang napiling report'}
                      className="p-1 rounded hover:bg-sky-200/70 text-sky-900"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}

              <div className="flex-1 overflow-y-auto p-3.5 space-y-3 bg-slate-50">
                {aiMessages.length === 0 && (
                  <div className="flex items-start gap-2">
                    <img
                      src="/icon.svg"
                      alt="T.U.G.O.N."
                      className="w-7 h-7 rounded-full border border-emerald-200 bg-white p-0.5 shrink-0 mt-0.5"
                    />
                    <div className="bg-white border border-slate-200 rounded-2xl rounded-tl-sm px-3 py-2.5 text-xs text-slate-700 leading-relaxed space-y-2">
                      <p>
                        {selectedReport
                          ? isEn
                            ? `Report #${selectedReport.ticketNumber} (${selectedReport.status}) is loaded. Ask anything about it, or ask to chat with a Barangay Official.`
                            : `Naka-select na ang report #${selectedReport.ticketNumber} (${selectedReport.status}). Magtanong kahit ano tungkol dito o hilinging makausap ang Barangay Official.`
                          : currentRole === 'resident'
                            ? isEn
                              ? 'Ask me anything about submitting waste reports, your phone’s submitted tickets, Senior/PWD priority, or say you want to chat with a Barangay Official.'
                              : 'Magtanong tungkol sa pag-report, mga ticket na naipadala sa phone mo, o sabihin lang kung gusto mong makausap ang Barangay Official.'
                            : isEn
                              ? 'Ask me about any Barangay 40 & 41 reports, dispatch workflow, Telegram logbook, or portal totals.'
                              : 'Magtanong tungkol sa mga report sa Barangay 40 & 41, dispatch workflow, Telegram logbook, o live summary.'}
                      </p>
                      {selectedReport && (
                        <div className="flex flex-wrap gap-1.5 pt-0.5">
                          <button
                            type="button"
                            onClick={() =>
                              handleSendAi(
                                isEn
                                  ? `What is the current status and details of report ${selectedReport.ticketNumber}?`
                                  : `Ano ang kasalukuyang status at detalye ng report ${selectedReport.ticketNumber}?`
                              )
                            }
                            className="text-[11px] font-bold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg px-2.5 py-1"
                          >
                            {isEn ? 'Check status & details' : 'Tingnan ang status'}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {aiMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex items-end gap-2 ${
                      msg.role === 'user' ? 'justify-end' : 'justify-start'
                    }`}
                  >
                    {msg.role === 'assistant' && (
                      <img
                        src="/icon.svg"
                        alt="AI"
                        className="w-6 h-6 rounded-full border border-emerald-200 bg-white p-0.5 shrink-0"
                      />
                    )}
                    <div
                      className={`max-w-[82%] rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed whitespace-pre-wrap break-words space-y-1.5 ${
                        msg.role === 'user'
                          ? 'bg-emerald-700 text-white rounded-br-sm'
                          : 'bg-white border border-slate-200 text-slate-800 rounded-bl-sm shadow-xs'
                      }`}
                    >
                      {msg.imagePreview && (
                        <img
                          src={msg.imagePreview}
                          alt="Uploaded waste photo"
                          className="w-full max-h-36 object-cover rounded-lg border border-white/20"
                        />
                      )}
                      <div>{msg.text}</div>
                      {msg.role === 'assistant' && msg.modelUsed && (
                        <div className="pt-1 border-t border-slate-100 flex items-center gap-1 text-[10px] font-semibold text-emerald-700">
                          <Sparkles className="w-2.5 h-2.5 shrink-0" />
                          <span>{msg.modelUsed}</span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                {(aiLoading || aiTranslating) && (
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <Loader2 className="w-4 h-4 animate-spin text-emerald-700" />
                    <span>
                      {aiLoading
                        ? isEn
                          ? 'Gemini AI is analyzing...'
                          : 'Sumasagot ang Gemini AI...'
                        : isEn
                          ? 'Syncing AI replies to English...'
                          : 'Isinasalin ang mga sagot sa Tagalog...'}
                    </span>
                  </div>
                )}

                {aiError && (
                  <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 text-xs text-rose-800 space-y-2">
                    <p>{aiError}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      {aiMessages.some((m) => m.role === 'user') && (
                        <button
                          type="button"
                          onClick={() => {
                            const lastUser = [...aiMessages].reverse().find((m) => m.role === 'user');
                            if (lastUser) handleSendAi(lastUser.text);
                          }}
                          className="inline-flex items-center gap-1 font-bold text-rose-800 bg-white border border-rose-200 rounded-lg px-2.5 py-1.5 hover:bg-rose-100/60"
                        >
                          {isEn ? 'Try Again' : 'Subukan Muli'}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setMode('official')}
                        className="inline-flex items-center gap-1.5 font-bold text-sky-800 bg-white border border-sky-200 rounded-lg px-2.5 py-1.5 hover:bg-sky-50"
                      >
                        <UserCheck className="w-3.5 h-3.5" />
                        {isEn ? 'Talk with Barangay Official Instead' : 'Makipag-usap sa Barangay Official'}
                      </button>
                    </div>
                  </div>
                )}
                <div ref={aiEndRef} />
              </div>

              {aiPendingImage && (
                <div className="px-3 py-2 bg-emerald-50 border-t border-emerald-200 flex items-center justify-between gap-2 shrink-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <img
                      src={aiPendingImage}
                      alt="Pending waste photo"
                      className="w-10 h-10 rounded-lg object-cover border border-emerald-300 shrink-0"
                    />
                    <span className="text-[11px] font-semibold text-emerald-900 truncate">
                      {isEn ? 'Photo attached for Gemini Vision' : 'May naka-attach na litrato para sa Gemini'}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setAiPendingImage(null)}
                    aria-label={isEn ? 'Remove attached photo' : 'Alisin ang litrato'}
                    className="p-1 rounded-lg hover:bg-emerald-200/70 text-emerald-900 shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSendAi();
                }}
                className="p-2.5 border-t border-slate-200 bg-white flex items-center gap-1.5 shrink-0"
              >
                <button
                  type="button"
                  onClick={() => aiPhotoInputRef.current?.click()}
                  disabled={aiLoading}
                  title={isEn ? 'Attach photo file for Gemini Vision' : 'Mag-attach ng file o litrato'}
                  aria-label={isEn ? 'Attach photo file for Gemini Vision' : 'Mag-attach ng file o litrato'}
                  className="min-w-[38px] min-h-[42px] rounded-xl bg-slate-100 hover:bg-emerald-50 border border-slate-200 text-slate-700 hover:text-emerald-800 flex items-center justify-center transition-colors shrink-0"
                >
                  <ImagePlus className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setIsAiLiveCamOpen(true)}
                  disabled={aiLoading}
                  title={isEn ? 'Take live photo with camera' : 'Kumuha ng live photo gamit ang camera'}
                  aria-label={isEn ? 'Take live photo with camera' : 'Kumuha ng live photo gamit ang camera'}
                  className="min-w-[38px] min-h-[42px] rounded-xl bg-slate-100 hover:bg-emerald-50 border border-slate-200 text-slate-700 hover:text-emerald-800 flex items-center justify-center transition-colors shrink-0"
                >
                  <Camera className="w-4 h-4" />
                </button>
                <input
                  type="text"
                  value={aiInput}
                  onChange={(e) => setAiInput(e.target.value)}
                  placeholder={
                    aiPendingImage
                      ? isEn
                        ? 'Ask Gemini about this photo...'
                        : 'Magtanong sa Gemini tungkol sa litrato...'
                      : selectedReport
                        ? isEn
                          ? `Ask about #${selectedReport.ticketNumber}...`
                          : `Magtanong tungkol sa #${selectedReport.ticketNumber}...`
                        : isEn
                          ? 'Ask Gemini AI or say chat with brgy official...'
                          : 'Magtanong sa Gemini AI o sabihing kausapin ang opisyal...'
                  }
                  className="flex-1 min-h-[42px] px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-emerald-500"
                />
                <button
                  type="submit"
                  disabled={aiLoading || (!aiInput.trim() && !aiPendingImage)}
                  aria-label={isEn ? 'Send' : 'Ipadala'}
                  className="min-w-[42px] min-h-[42px] rounded-xl bg-emerald-700 hover:bg-emerald-800 disabled:opacity-45 text-white flex items-center justify-center transition-colors shrink-0"
                >
                  <Send className="w-4 h-4" />
                </button>
              </form>
            </>
          )}

          {/* Body: Live Resident <-> Barangay Official Chat */}
          {mode === 'official' && (
            <>
              {/* Kagawad Inbox List View */}
              {currentRole === 'kagawad' && !selectedSessionId ? (
                <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
                  <div className="px-3 py-2 bg-white border-b border-slate-200 flex items-center gap-1.5 shrink-0">
                    {(
                      [
                        { key: 'INBOX', label: isEn ? `Inbox (${tabCounts.inbox})` : `Inbox (${tabCounts.inbox})` },
                        { key: 'RESOLVED', label: isEn ? `Resolved (${tabCounts.resolved})` : `Tapos (${tabCounts.resolved})` },
                        { key: 'SPAM', label: isEn ? `Spam (${tabCounts.spam})` : `Spam (${tabCounts.spam})` },
                      ] as const
                    ).map((tab) => (
                      <button
                        key={tab.key}
                        type="button"
                        onClick={() => setOfficialTab(tab.key)}
                        className={`px-2.5 py-1.5 rounded-lg text-[11px] font-bold whitespace-nowrap transition-colors ${
                          officialTab === tab.key
                            ? tab.key === 'SPAM'
                              ? 'bg-rose-700 text-white'
                              : 'bg-emerald-700 text-white'
                            : 'text-slate-600 hover:bg-slate-100'
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>

                  <div className="flex-1 overflow-y-auto p-3 space-y-2">
                    {filteredOfficialThreads.length === 0 ? (
                      <div className="h-full flex flex-col items-center justify-center text-center px-6 py-10 text-slate-500">
                        <MessageSquare className="w-8 h-8 text-slate-300 mb-2" />
                        <p className="text-xs font-bold text-slate-700">
                          {officialTab === 'SPAM'
                            ? isEn
                              ? 'Spam folder is clean'
                              : 'Walang laman ang Spam folder'
                            : officialTab === 'RESOLVED'
                              ? isEn
                                ? 'No resolved chats yet'
                                : 'Wala pang tapos na usapan'
                              : isEn
                                ? 'No active resident chat requests'
                                : 'Walang aktibong resident chat'}
                        </p>
                        <p className="text-[11px] text-slate-500 mt-1">
                          {officialTab === 'SPAM'
                            ? isEn
                              ? 'Redundant or non-concern messages filtered by T.U.G.O.N. AI appear here.'
                              : 'Ang mga paulit-ulit o hindi totoong concern na na-filter ng AI ay lalabas dito.'
                            : isEn
                              ? 'Important resident concerns approved by T.U.G.O.N. AI appear here and log to Telegram.'
                              : 'Ang mga importanteng mensahe mula sa AI gatekeeper ay lalabas dito at sa Telegram.'}
                        </p>
                      </div>
                    ) : (
                      filteredOfficialThreads.map((t) => {
                        const humanMsgs = (t.messages || []).filter((m) => m.sender !== 'ai');
                        const lastMsg = humanMsgs[humanMsgs.length - 1] || t.messages?.[t.messages.length - 1];
                        return (
                          <button
                            key={t.sessionId}
                            type="button"
                            onClick={() => {
                              setConfirmDeleteId(null);
                              setSelectedSessionId(t.sessionId);
                            }}
                            className={`w-full text-left bg-white border rounded-xl p-3 transition-colors space-y-1 shadow-xs ${
                              t.folder === 'SPAM'
                                ? 'border-rose-200 hover:bg-rose-50/40'
                                : 'border-slate-200 hover:bg-emerald-50/50'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs font-extrabold text-slate-900 truncate">
                                {t.residentName || 'Resident'}
                              </span>
                              <div className="flex items-center gap-1.5 shrink-0">
                                {t.unreadByOfficial > 0 && (
                                  <span className="px-1.5 py-0.5 rounded bg-rose-600 text-white text-[10px] font-bold">
                                    {t.unreadByOfficial}
                                  </span>
                                )}
                                <span
                                  className={`text-[10px] font-bold ${
                                    t.folder === 'SPAM'
                                      ? 'text-rose-700'
                                      : t.status === 'RESOLVED'
                                        ? 'text-emerald-700'
                                        : 'text-amber-700'
                                  }`}
                                >
                                  {t.folder === 'SPAM'
                                    ? 'SPAM'
                                    : t.status === 'RESOLVED'
                                      ? isEn
                                        ? 'Resolved'
                                        : 'Tapos Na'
                                      : isEn
                                        ? 'Active'
                                        : 'Aktibo'}
                                </span>
                              </div>
                            </div>
                            <div className="text-[11px] text-slate-500 truncate">
                              {t.barangay || 'Brgy 40 & 41'}
                              {t.ticketNumber ? ` · #${t.ticketNumber}` : ''}
                              {lastMsg?.timestamp ? ` · ${formatShortTime(lastMsg.timestamp)}` : ''}
                            </div>
                            {t.aiHandoffSummary && (
                              <p className="text-[11px] font-semibold text-emerald-800 truncate">
                                AI: {t.aiHandoffSummary}
                              </p>
                            )}
                            {lastMsg && (
                              <p className="text-xs text-slate-700 truncate">
                                {lastMsg.sender === 'official' ? `${lastMsg.senderName}: ` : ''}
                                {lastMsg.text}
                              </p>
                            )}
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              ) : (
                /* Thread Conversation View (Resident or Selected Kagawad Thread) */
                <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
                  {currentRole === 'resident' ? (
                    <div className="px-3 py-2 bg-white border-b border-slate-200 grid grid-cols-3 gap-1.5 shrink-0">
                      <input
                        type="text"
                        value={residentName}
                        onChange={(e) => setResidentName(e.target.value)}
                        placeholder={isEn ? 'Your Name' : 'Pangalan mo'}
                        className="px-2 py-1.5 text-[11px] bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500"
                      />
                      <select
                        value={residentBarangay}
                        onChange={(e) => setResidentBarangay(e.target.value)}
                        aria-label="Barangay"
                        className="px-1.5 py-1.5 text-[11px] bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500"
                      >
                        <option value="Barangay 40">Brgy 40</option>
                        <option value="Barangay 41">Brgy 41</option>
                      </select>
                      <input
                        type="text"
                        value={residentTicket}
                        onChange={(e) => setResidentTicket(e.target.value)}
                        placeholder={isEn ? 'Ticket # (opt)' : 'Ticket # (opt)'}
                        className="px-2 py-1.5 text-[11px] bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500"
                      />
                    </div>
                  ) : (
                    activeThread && (
                      <div className="px-3 py-2 bg-white border-b border-slate-200 space-y-1.5 shrink-0">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-xs font-extrabold text-slate-900 truncate">
                              {activeThread.residentName}
                            </p>
                            <p className="text-[11px] text-slate-500 truncate">
                              {activeThread.barangay || 'Brgy 40 & 41'}
                              {activeThread.ticketNumber ? ` · #${activeThread.ticketNumber}` : ''}
                            </p>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            {activeThread.folder === 'SPAM' && (
                              <button
                                type="button"
                                onClick={() => handleMoveSpamToInbox(activeThread)}
                                className="px-2 py-1.5 rounded-lg text-[10px] font-bold bg-sky-50 text-sky-800 border border-sky-200 hover:bg-sky-100 flex items-center gap-1"
                              >
                                <Inbox className="w-3 h-3" />
                                {isEn ? 'To Inbox' : 'Sa Inbox'}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => handleToggleThreadStatus(activeThread)}
                              className={`px-2 py-1.5 rounded-lg text-[10px] font-bold flex items-center gap-1 whitespace-nowrap border transition-colors ${
                                activeThread.status === 'RESOLVED'
                                  ? 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                                  : 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100'
                              }`}
                            >
                              <CheckCircle2 className="w-3 h-3" />
                              {activeThread.status === 'RESOLVED'
                                ? isEn
                                  ? 'Reopen'
                                  : 'Buksan'
                                : isEn
                                  ? 'Resolve'
                                  : 'Tapos Na'}
                            </button>
                            {confirmDeleteId === activeThread.sessionId ? (
                              <button
                                type="button"
                                onClick={() => handleDeleteThread(activeThread.sessionId)}
                                className="px-2 py-1.5 rounded-lg text-[10px] font-bold bg-rose-600 text-white hover:bg-rose-700"
                              >
                                {isEn ? 'Confirm?' : 'Burahin?'}
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(activeThread.sessionId)}
                                title={isEn ? 'Delete conversation' : 'Burahin ang usapan'}
                                aria-label={isEn ? 'Delete conversation' : 'Burahin ang usapan'}
                                className="p-1.5 rounded-lg text-rose-700 bg-rose-50 border border-rose-200 hover:bg-rose-100"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </div>
                        {activeThread.aiHandoffSummary && (
                          <p className="text-[11px] bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-lg px-2.5 py-1.5">
                            <span className="font-bold">AI Summary:</span> {activeThread.aiHandoffSummary}
                          </p>
                        )}
                        {activeThread.folder === 'SPAM' && activeThread.spamReason && (
                          <p className="text-[11px] bg-rose-50 border border-rose-200 text-rose-900 rounded-lg px-2.5 py-1.5 flex items-start gap-1.5">
                            <ShieldAlert className="w-3.5 h-3.5 text-rose-700 shrink-0 mt-0.5" />
                            <span>
                              <span className="font-bold">AI Spam Filter:</span> {activeThread.spamReason}
                            </span>
                          </p>
                        )}
                      </div>
                    )
                  )}

                  {currentRole === 'resident' && handoffNotice && (
                    <div
                      className={`mx-3 mt-2.5 px-3 py-2 rounded-xl border text-[11px] flex items-start justify-between gap-2 shrink-0 ${
                        handoffNotice.folder === 'SPAM'
                          ? 'bg-amber-50 border-amber-200 text-amber-900'
                          : 'bg-emerald-50 border-emerald-200 text-emerald-900'
                      }`}
                    >
                      <div className="flex items-start gap-1.5 min-w-0">
                        {handoffNotice.folder === 'SPAM' ? (
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-700 shrink-0 mt-0.5" />
                        ) : (
                          <ShieldCheck className="w-3.5 h-3.5 text-emerald-700 shrink-0 mt-0.5" />
                        )}
                        <span>
                          {handoffNotice.folder === 'SPAM'
                            ? isEn
                              ? `Note: Screened to Officials' Spam folder (${handoffNotice.reason || 'redundant / non-concern'}). Send specific waste concern details to reach the Inbox.`
                              : `Paalala: Nalagay sa Spam folder (${handoffNotice.reason || 'paulit-ulit / hindi malinaw na concern'}). Magbigay ng malinaw na detalye ng concern.`
                            : isEn
                              ? `Forwarded to Barangay Official Inbox & logged to Telegram${handoffNotice.ticketNumber ? ` (#${handoffNotice.ticketNumber})` : ''}.`
                              : `Naipadala sa Barangay Official Inbox at naka-log sa Telegram${handoffNotice.ticketNumber ? ` (#${handoffNotice.ticketNumber})` : ''}.`}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setHandoffNotice(null)}
                        aria-label="Dismiss"
                        className="p-0.5 rounded hover:bg-black/5 shrink-0"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  )}

                  <div className="flex-1 overflow-y-auto p-3.5 space-y-2.5">
                    {(!activeThread || activeThread.messages.length === 0) && (
                      <div className="bg-sky-50 border border-sky-200 rounded-xl p-3 text-xs text-sky-900 leading-relaxed flex items-start gap-2">
                        <ShieldCheck className="w-4 h-4 text-sky-700 shrink-0 mt-0.5" />
                        <span>
                          {isEn
                            ? 'Send your message below to talk with a Barangay 40 & 41 Official. T.U.G.O.N. AI screens messages so genuine concerns enter the Inbox and Telegram Logbook.'
                            : 'Ipadala ang iyong mensahe sa ibaba para makausap ang Barangay Official. Sinasala ng AI ang mensahe upang ang totoong concern ay pumasok sa Inbox at Telegram Logbook.'}
                        </span>
                      </div>
                    )}

                    {activeThread?.messages?.map((m) => {
                      if (m.sender === 'ai') {
                        const aiDisplay = isEn ? m.textEn || m.text : m.textTl || m.text;
                        return (
                          <div key={m.id} className="flex items-end gap-2 justify-start">
                            <img
                              src="/icon.svg"
                              alt="T.U.G.O.N. AI"
                              className="w-6 h-6 rounded-full border border-emerald-200 bg-white p-0.5 shrink-0"
                            />
                            <div className="flex flex-col items-start max-w-[82%]">
                              <span className="text-[10px] font-semibold text-emerald-700 px-1 mb-0.5">
                                {m.senderName || 'T.U.G.O.N. AI'} · {formatShortTime(m.timestamp)}
                              </span>
                              <div className="rounded-2xl rounded-bl-sm px-3.5 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words bg-emerald-50 border border-emerald-200 text-emerald-950">
                                {aiDisplay}
                              </div>
                            </div>
                          </div>
                        );
                      }
                      const isSelf =
                        (currentRole === 'resident' && m.sender === 'resident') ||
                        (currentRole === 'kagawad' && m.sender === 'official');
                      return (
                        <div
                          key={m.id}
                          className={`flex flex-col ${isSelf ? 'items-end' : 'items-start'}`}
                        >
                          <span className="text-[10px] text-slate-400 px-1 mb-0.5">
                            {m.senderName} · {formatShortTime(m.timestamp)}
                          </span>
                          <div
                            className={`max-w-[82%] rounded-2xl px-3.5 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words ${
                              isSelf
                                ? 'bg-sky-700 text-white rounded-br-sm'
                                : 'bg-white border border-slate-200 text-slate-800 rounded-bl-sm shadow-xs'
                            }`}
                          >
                            {m.text}
                          </div>
                        </div>
                      );
                    })}

                    {supportError && (
                      <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
                        {supportError}
                      </p>
                    )}
                    <div ref={supportEndRef} />
                  </div>

                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      handleSendSupport();
                    }}
                    className="p-2.5 border-t border-slate-200 bg-white flex items-center gap-2 shrink-0"
                  >
                    <input
                      type="text"
                      value={supportInput}
                      onChange={(e) => setSupportInput(e.target.value)}
                      placeholder={
                        currentRole === 'kagawad'
                          ? isEn
                            ? 'Reply to resident...'
                            : 'Sumagot sa residente...'
                          : isEn
                            ? 'Message Barangay Official...'
                            : 'Mensahe sa Barangay Official...'
                      }
                      className="flex-1 min-h-[42px] px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-sky-500"
                    />
                    <button
                      type="submit"
                      disabled={supportSending || !supportInput.trim()}
                      aria-label={isEn ? 'Send' : 'Ipadala'}
                      className="min-w-[42px] min-h-[42px] rounded-xl bg-sky-700 hover:bg-sky-800 disabled:opacity-45 text-white flex items-center justify-center transition-colors shrink-0"
                    >
                      {supportSending ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Send className="w-4 h-4" />
                      )}
                    </button>
                  </form>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* Floating Draggable Circular Chat Head using T.U.G.O.N. App Icon (/icon.svg) */}
      <button
        type="button"
        onPointerDown={(e) => {
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          try {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          } catch {}
          didDragRef.current = false;
          dragStateRef.current = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            originX: bubblePos.x,
            originY: bubblePos.y,
            hasMoved: false,
          };
          setIsDragging(true);
        }}
        onPointerMove={(e) => {
          const ds = dragStateRef.current;
          if (!ds || ds.pointerId !== e.pointerId) return;
          const dx = e.clientX - ds.startX;
          const dy = e.clientY - ds.startY;
          if (!ds.hasMoved && Math.hypot(dx, dy) > 6) {
            ds.hasMoved = true;
            didDragRef.current = true;
          }
          if (ds.hasMoved) {
            setBubblePos(clampBubblePos(ds.originX + dx, ds.originY + dy));
          }
        }}
        onPointerUp={(e) => {
          const ds = dragStateRef.current;
          if (!ds || ds.pointerId !== e.pointerId) return;
          try {
            (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
          } catch {}
          dragStateRef.current = null;
          setIsDragging(false);
          if (ds.hasMoved) {
            setBubblePos((curr) => {
              const snapped = snapBubbleToNearestEdge(curr.x, curr.y);
              try {
                localStorage.setItem(CHAT_HEAD_POS_STORAGE_KEY, JSON.stringify(snapped));
              } catch {}
              return snapped;
            });
            setTimeout(() => {
              didDragRef.current = false;
            }, 80);
          }
        }}
        onPointerCancel={(e) => {
          const ds = dragStateRef.current;
          if (!ds || ds.pointerId !== e.pointerId) return;
          try {
            (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
          } catch {}
          dragStateRef.current = null;
          setIsDragging(false);
          if (ds.hasMoved) {
            setBubblePos((curr) => {
              const snapped = snapBubbleToNearestEdge(curr.x, curr.y);
              try {
                localStorage.setItem(CHAT_HEAD_POS_STORAGE_KEY, JSON.stringify(snapped));
              } catch {}
              return snapped;
            });
          }
          setTimeout(() => {
            didDragRef.current = false;
          }, 80);
        }}
        onClick={() => {
          if (didDragRef.current) {
            didDragRef.current = false;
            return;
          }
          setIsOpen((v) => !v);
        }}
        style={{
          left: `${bubblePos.x}px`,
          top: `${bubblePos.y}px`,
        }}
        aria-label={
          isEn
            ? 'Open or move T.U.G.O.N. AI & Barangay Official Chat'
            : 'Buksan o ilipat ang T.U.G.O.N. AI at Barangay Official Chat'
        }
        className={`fixed z-50 w-14 h-14 rounded-full bg-white border-2 border-emerald-600 flex items-center justify-center p-1 touch-none select-none cursor-grab active:cursor-grabbing ${
          isDragging
            ? 'scale-105 shadow-2xl transition-none'
            : 'shadow-lg hover:shadow-xl active:scale-95 transition-[left,top,box-shadow,transform] duration-200 ease-out'
        }`}
      >
        <img
          src="/icon.svg"
          alt="T.U.G.O.N. Chat"
          draggable={false}
          className="w-full h-full rounded-full object-cover pointer-events-none select-none"
        />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[20px] h-[20px] px-1 rounded-full bg-rose-600 text-white text-[10px] font-extrabold flex items-center justify-center border-2 border-white pointer-events-none">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      <LiveCameraModal
        isOpen={isAiLiveCamOpen}
        onClose={() => setIsAiLiveCamOpen(false)}
        onCapture={(dataUrl) => {
          setAiPendingImage(dataUrl);
          setMode('ai');
          setAiError(null);
        }}
        onFallbackToFile={() => aiPhotoInputRef.current?.click()}
      />
    </>
  );
};
