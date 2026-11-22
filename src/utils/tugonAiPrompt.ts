export interface TugonAiLiveSummary {
  totalActive: number;
  pendingCount: number;
  dispatchedCount: number;
  seniorPriorityCount: number;
  brgy40ActiveCount: number;
  brgy41ActiveCount: number;
  resolvedCount: number;
}

export interface ResidentDeviceReportContext {
  id?: string;
  ticketNumber?: string;
  status?: string;
  barangay?: string;
  purok?: string;
  streetAddress?: string;
  landmark?: string;
  severityLevel?: string;
  isElderly?: boolean;
  wasteTypes?: string[];
  notes?: string;
  dispatchedKagawad?: string;
  dispatchedAt?: string;
  resolvedBy?: string;
  resolvedAt?: string;
  resolutionNotes?: string;
  cancellationReason?: string;
  createdAt?: string;
  updatedAt?: string;
}

export function computeTugonAiLiveSummary(reports: any[]): TugonAiLiveSummary {
  const list = Array.isArray(reports) ? reports : [];
  const active = list.filter((r) => {
    if (!r || r.isPurgedFromFeed) return false;
    const st = String(r.status || 'PENDING').trim().toUpperCase();
    return st === 'PENDING' || st === 'DISPATCHED';
  });
  const pendingCount = active.filter(
    (r) => String(r.status || 'PENDING').trim().toUpperCase() === 'PENDING'
  ).length;
  const dispatchedCount = active.filter(
    (r) => String(r.status || 'PENDING').trim().toUpperCase() === 'DISPATCHED'
  ).length;
  const seniorPriorityCount = active.filter(
    (r) => Boolean(r?.isElderly) || r?.severityLevel === 'EMERGENCY' || r?.severityLevel === 'OVERFLOWING'
  ).length;
  const brgy40ActiveCount = active.filter((r) =>
    String(r?.barangay || r?.purok || '').toLowerCase().includes('40')
  ).length;
  const brgy41ActiveCount = active.length - brgy40ActiveCount;
  const resolvedCount = list.filter(
    (r) => String(r?.status || '').trim().toUpperCase() === 'RESOLVED'
  ).length;

  return {
    totalActive: active.length,
    pendingCount,
    dispatchedCount,
    seniorPriorityCount,
    brgy40ActiveCount,
    brgy41ActiveCount,
    resolvedCount,
  };
}

function formatDeviceTicketsSection(
  residentReports?: ResidentDeviceReportContext[],
  selectedReport?: ResidentDeviceReportContext | null
): string {
  const list = Array.isArray(residentReports) ? residentReports : [];
  if (list.length === 0 && !selectedReport) {
    return 'THIS DEVICE REPORTS: No reports submitted from this phone yet.';
  }
  const lines = ['THIS PHONE SUBMITTED REPORTS (Private to this device only):'];
  for (const r of list) {
    const tk = String(r.ticketNumber || r.id || 'N/A').replace(/^#+/, '');
    const st = String(r.status || 'PENDING').toUpperCase();
    const brgy = r.barangay || r.purok || 'Brgy 40/41';
    const sev = r.severityLevel || 'MODERATE';
    const notes = r.notes ? ` | Notes: ${String(r.notes)}` : '';
    const resNotes = r.resolutionNotes ? ` | Resolution: ${String(r.resolutionNotes)}` : '';
    const kagawad = r.dispatchedKagawad
      ? ` | Crew/Kagawad: ${r.dispatchedKagawad}`
      : r.resolvedBy
        ? ` | Resolved By: ${r.resolvedBy}`
        : '';
    lines.push(
      `- #${tk} | Status: ${st} | ${brgy} | Severity: ${sev}${r.isElderly ? ' (Senior/PWD Priority)' : ''} | Created: ${r.createdAt || 'unknown'}${kagawad}${notes}${resNotes}`
    );
  }
  if (selectedReport) {
    const tk = String(selectedReport.ticketNumber || selectedReport.id || '').replace(/^#+/, '');
    lines.push('');
    lines.push(
      `CURRENTLY FOCUSED REPORT BY USER (#${tk}): ${JSON.stringify({
        ticketNumber: `#${tk}`,
        status: selectedReport.status || 'PENDING',
        barangay: selectedReport.barangay || selectedReport.purok,
        streetAddress: selectedReport.streetAddress || '',
        landmark: selectedReport.landmark || '',
        severityLevel: selectedReport.severityLevel || 'MODERATE',
        isElderly: Boolean(selectedReport.isElderly),
        wasteTypes: selectedReport.wasteTypes || [],
        notes: selectedReport.notes || '',
        dispatchedKagawad: selectedReport.dispatchedKagawad || '',
        dispatchedAt: selectedReport.dispatchedAt || '',
        resolvedBy: selectedReport.resolvedBy || '',
        resolvedAt: selectedReport.resolvedAt || '',
        resolutionNotes: selectedReport.resolutionNotes || '',
        cancellationReason: selectedReport.cancellationReason || '',
        createdAt: selectedReport.createdAt || '',
        updatedAt: selectedReport.updatedAt || '',
      })}`
    );
  }
  return lines.join('\n');
}

export function buildTugonAiSystemInstruction(
  lang: 'tl' | 'en',
  role: 'resident' | 'kagawad',
  summary: TugonAiLiveSummary,
  options?: {
    residentReports?: ResidentDeviceReportContext[];
    selectedReport?: ResidentDeviceReportContext | null;
  }
): string {
  const languageDirective =
    lang === 'en'
      ? 'STRICT OUTPUT LANGUAGE: The user selected ENGLISH in the main interface. You MUST write your ENTIRE reply in natural, clear English only — even if ticket notes or user input contain Tagalog/Taglish words.'
      : 'STRICT OUTPUT LANGUAGE: The user selected TAGALOG in the main interface. You MUST write your ENTIRE reply in natural, clear Tagalog / Filipino only — even if the user writes in English or Taglish (keep ticket codes like #TUGON-CAV-XXXX and status codes clear).';

  const roleContext =
    role === 'kagawad'
      ? 'The user is an authenticated Barangay Official / Kagawad in the all-in-one Official Portal.'
      : 'The user is a Resident on their own private phone interface. Only discuss reports submitted from THIS phone.';

  const deviceSection =
    role === 'resident'
      ? formatDeviceTicketsSection(options?.residentReports, options?.selectedReport)
      : `BARANGAY PORTAL LIVE ALL-IN-ONE QUEUE:\n- Active Unresolved Total: ${summary.totalActive} (Pending: ${summary.pendingCount}, Dispatched: ${summary.dispatchedCount})\n- Senior/PWD & Urgent Priority Active: ${summary.seniorPriorityCount}\n- Barangay 40 Active: ${summary.brgy40ActiveCount} | Barangay 41 Active: ${summary.brgy41ActiveCount}\n- Resolved Records: ${summary.resolvedCount}`;

  return [
    'You are the official T.U.G.O.N. AI Assistant — strictly centralized for T.U.G.O.N. (Barangay 40 Gumamela & Barangay 41 Rosal, Cavite City Waste Collection Service with Cloud Storage).',
    languageDirective,
    roleContext,
    '',
    'CORE DOMAIN KNOWLEDGE:',
    '1. Jurisdiction: Barangay 40 (Gumamela) & Barangay 41 (Rosal), Cavite City. Outside locations can still submit with Special Assistance flagged.',
    '2. Report Submission: Fill name/contact, Barangay (40 or 41), street/landmark, enable GPS pin, select severity (MILD, MODERATE, OVERFLOWING, EMERGENCY), Senior/PWD Priority if needed, attach 1-15 photos, and Submit. Offline reports stay queued safely on the device.',
    '3. Ticket Status Lifecycle: PENDING -> DISPATCHED (crew/Kagawad assigned) -> RESOLVED (with collection proof photos & notes) or CANCELLED. Active portal feed auto-purges after 7 days into Logbooks.',
    '4. Waste Photo Inspection (Gemini Vision): If the user attaches a photo of garbage, overflowing bins, street waste, or cleanup proof, carefully inspect the image to identify visible waste categories (e.g. Household Trash, Plastics, Biodegradable, Bulky Waste, Construction Debris), estimate severity (MILD, MODERATE, OVERFLOWING, or EMERGENCY), and advise whether to submit a report or escalate to a Barangay Official.',
    '5. Public Portal Queue Snapshot (Non-PII): ' +
      `Active: ${summary.totalActive} (Pending: ${summary.pendingCount}, Dispatched: ${summary.dispatchedCount}, Brgy 40: ${summary.brgy40ActiveCount}, Brgy 41: ${summary.brgy41ActiveCount}, Resolved: ${summary.resolvedCount}).`,
    '',
    deviceSection,
    '',
    'STRICT DOMAIN BOUNDARY:',
    '- You are T.U.G.O.N. AI powered by Google Gemini, strictly specialized for T.U.G.O.N. Brgy 40 & 41 waste collection.',
    '- NEVER answer general off-topic requests (coding, math homework, trivia, recipes, crypto, essays, jokes, medical diagnosis, or non-waste/non-barangay photos). Politely refuse and redirect back to T.U.G.O.N. Brgy 40/41 waste collection or their ticket.',
    '- NEVER invent fake ticket statuses or reveal other residents private addresses/names on the resident view.',
    '',
    'REQUIRED JSON OUTPUT CONTRACT:',
    'Return valid JSON matching the schema with these fields:',
    '- "reply": Your direct, complete, thorough, helpful answer tailored to the user message and their exact ticket data above with NO arbitrary length cutoffs (strictly follow STRICT OUTPUT LANGUAGE above; avoid markdown code blocks).',
    '- "wantsOfficialHandoff": Boolean. Set to TRUE whenever the user in ANY natural phrasing asks to chat/talk/connect with a Barangay Official/Kagawad/Agent (e.g. "chat with brgy official", "talk to barangay", "kausap ng kagawad", "pakipasa sa barangay", "i need human help"), OR asks to escalate/follow up with officials on an UNRESOLVED (PENDING or DISPATCHED) report. Set to FALSE for normal questions.',
    '- "handoffClassification": Must be "NONE" when wantsOfficialHandoff is false. When wantsOfficialHandoff is true, classify carefully as "IMPORTANT" (genuine waste/barangay concern, ticket follow-up, urgent pickup, or real resident inquiry) OR "SPAM_REDUNDANT" (trolling, gibberish, abusive/empty spam, repetitive duplicate spam with no new concern, or irrelevant off-topic request trying to reach officials).',
    '- "handoffSummary": When wantsOfficialHandoff is true, write a clear summary for the Barangay Official & Telegram Logbook including ticket # (if any), Barangay, and what the resident reported/needs. Empty string when false.',
    '- "moderationReason": Brief reason if classified as SPAM_REDUNDANT, otherwise empty string.',
  ].join('\n');
}

export function buildSupportModerationInstruction(
  residentName: string,
  barangay: string,
  ticketNumber: string,
  recentThreadMessages: { sender: string; text: string; timestamp?: string }[]
): string {
  const recentLines = recentThreadMessages
    .slice(-8)
    .map((m) => `[${m.sender}] ${String(m.text || '').slice(0, 220)}`)
    .join('\n');

  return [
    'You are the AI gatekeeper & moderation filter for the T.U.G.O.N. Barangay 40 & 41 Official Support Inbox.',
    'EVERY message sent by a resident toward Barangay Officials must be evaluated as IMPORTANT or SPAM_REDUNDANT.',
    '',
    `Resident Info: ${residentName || 'Resident'} | Barangay: ${barangay || 'Brgy 40/41'} | Ticket: ${ticketNumber || 'None'}`,
    recentLines ? `Recent Thread History:\n${recentLines}` : 'Recent Thread History: (new conversation)',
    '',
    'CLASSIFICATION RULES:',
    '- Return "IMPORTANT" if the message is a genuine concern, waste pickup follow-up, missed collection report, Senior/PWD urgent need, barangay inquiry, respectful clarification, or natural request to speak with an official about T.U.G.O.N. / Barangay 40 & 41 matters.',
    '- Return "SPAM_REDUNDANT" ONLY if the message is clearly spam: meaningless keyboard mash/gibberish (e.g. "asdfghjkl", "test123"), repeated identical/redundant spam already sent right before without adding info, off-topic abuse/ads/pranks, or non-barangay spam (math homework, crypto promo, coding requests).',
    '- When in doubt on a genuine resident greeting with context or follow-up question, favor "IMPORTANT" so real residents are heard.',
    '',
    'Return JSON with: { "classification": "IMPORTANT" | "SPAM_REDUNDANT", "reason": "short explanation", "summary": "concise 1-sentence summary for Official Inbox & Telegram Logbook" }.',
  ].join('\n');
}
