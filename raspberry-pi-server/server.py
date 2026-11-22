#!/usr/bin/env python3
"""
T.U.G.O.N. / P.U.L.S.E. - Barangay 40 (Gumamela) & 41 (Rosal), Cavite City
Raspberry Pi 4B Sovereign Cloud Storage Server

Zero-Dependency Version: Python 3 Standard Library Only (No pip / No venv required!)
Features:
- Concurrent ThreadingHTTPServer (never hangs on large photo uploads or parallel pings)
- Full CORS + Cloudflare Pages/Workers + Chrome Private Network Access + ngrok-skip-browser-warning support
- Auto-detection of External Hard Drive (/media/pi/Vherrsie Back-up/RESEARCH TRASH)
- Automatic decoding of Resident & Kagawad Proof Base64 photos into real .jpg/.png files on disk
- Real Hardware Telemetry (CPU Temp, RAM MemAvailable, Disk Total/Used/Free, LAN IP)
- Complete CRUD: Health, Config, Storage, Single Report POST + Two-Way Sync, PATCH Status/Proof, Delete Report, Save/List/Download/Delete Logbooks, Safe Shutdown & Reboot
"""

from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import os
import sys
import json
import base64
import shutil
import socket
import datetime
import threading
import time
import urllib.parse
import urllib.request
import urllib.error


class ReusableThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def _ensure_writable_dir(path):
    try:
        os.makedirs(path, exist_ok=True)
        probe = os.path.join(path, ".tugon_write_probe")
        with open(probe, "w", encoding="utf-8") as f:
            f.write("ok")
        os.remove(probe)
        return True
    except Exception:
        return False


def get_storage_dir():
    custom_dir = os.environ.get("PI_STORAGE_DIR", "").strip()
    if custom_dir and _ensure_writable_dir(custom_dir):
        return custom_dir

    candidates = [
        "/media/pi/Vherrsie Back-up/RESEARCH TRASH",
        os.path.expanduser("~/media/pi/Vherrsie Back-up/RESEARCH TRASH"),
        os.path.abspath("media/pi/Vherrsie Back-up/RESEARCH TRASH"),
        "/media/pi/Vherrsie Back-up",
    ]
    for p in candidates:
        if os.path.exists(p):
            if os.path.basename(p) == "Vherrsie Back-up":
                target = os.path.join(p, "RESEARCH TRASH")
                if _ensure_writable_dir(target):
                    return target
            if _ensure_writable_dir(p):
                return p

    for base in ["/media/pi", "/media", "/mnt"]:
        if os.path.exists(base):
            try:
                for entry in os.listdir(base):
                    mount = os.path.join(base, entry)
                    if os.path.isdir(mount) and not entry.startswith("."):
                        target = os.path.join(mount, "RESEARCH TRASH")
                        if os.path.exists(target) and _ensure_writable_dir(target):
                            return target
                        pulse_dir = os.path.join(mount, "pulse_storage")
                        if _ensure_writable_dir(pulse_dir):
                            return pulse_dir
            except Exception:
                pass

    for fallback in [os.path.expanduser("~/pulse_storage"), "/tmp/pulse_storage"]:
        if _ensure_writable_dir(fallback):
            return fallback
    return os.path.abspath("pulse_storage")


STORAGE_DIR = get_storage_dir()
os.makedirs(STORAGE_DIR, exist_ok=True)

LOGBOOKS_DIR = os.path.join(STORAGE_DIR, "saved_logbooks")
os.makedirs(LOGBOOKS_DIR, exist_ok=True)
PHOTOS_DIR = os.path.join(STORAGE_DIR, "photos")
os.makedirs(PHOTOS_DIR, exist_ok=True)
ARCHIVES_DIR = os.path.join(STORAGE_DIR, "purged_archives")
os.makedirs(ARCHIVES_DIR, exist_ok=True)
REPORTS_DB_FILE = os.path.join(STORAGE_DIR, "pulse_reports.json")
PORTAL_CONFIG_FILE = os.path.join(STORAGE_DIR, "pulse_portal_config.json")
DELETED_IDS_FILE = os.path.join(STORAGE_DIR, "pulse_deleted_ids.json")
SUPPORT_CHATS_FILE = os.path.join(STORAGE_DIR, "pulse_support_chats.json")
AUTO_PURGE_TTL_DAYS = 7

DB_LOCK = threading.RLock()
REV_CV = threading.Condition(DB_LOCK)
_PORTAL_REVISION = None


def get_pi_gemini_api_key():
    key_names = (
        "GEMINI_API_KEY",
        "GOOGLE_GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "API_KEY",
        "GEMINI_KEY",
        "VITE_GEMINI_API_KEY",
        "VITE_API_KEY",
    )
    for kname in key_names:
        val = str(os.environ.get(kname) or "").strip().strip('"').strip("'").strip()
        if val:
            return val
    base_dir = os.path.dirname(os.path.abspath(__file__))
    for env_path in [os.path.join(base_dir, ".env"), os.path.join(os.path.dirname(base_dir), ".env")]:
        if os.path.exists(env_path):
            try:
                with open(env_path, "r", encoding="utf-8") as f:
                    for line in f:
                        s = line.strip()
                        if not s or s.startswith("#") or "=" not in s:
                            continue
                        k, v = s.split("=", 1)
                        if k.strip() in key_names:
                            val = v.strip().strip('"').strip("'").strip()
                            if val:
                                return val
            except Exception:
                pass
    return ""


def call_pi_gemini_json(api_key, system_instruction, contents, response_schema, prefer_fastest=False, has_image=False):
    models = ["gemini-3.1-flash-lite", "gemini-4-hydrogen"]
    last_err = "Gemini unavailable"
    for model_name in models:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent"
        gen_cfg = {
            "responseMimeType": "application/json",
            "responseSchema": response_schema,
            "thinkingConfig": {
                "thinkingLevel": "MINIMAL" if model_name == "gemini-3.1-flash-lite" else "LOW"
            },
        }
        payload = {
            "systemInstruction": {"parts": [{"text": system_instruction}]},
            "contents": contents,
            "generationConfig": gen_cfg,
        }
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": api_key,
                "User-Agent": "aistudio-build",
            },
            method="POST",
        )
        try:
            timeout_sec = (15 if has_image else 10) if model_name == "gemini-3.1-flash-lite" else (6.5 if has_image else 3.5)
            with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
                raw_json = json.loads(resp.read().decode("utf-8"))
                candidates = raw_json.get("candidates") or []
                parts = (candidates[0].get("content") or {}).get("parts") or [] if candidates else []
                text_out = "".join(str(p.get("text") or "") for p in parts).strip()
                if not text_out:
                    continue
                friendly = "Gemini 4 Hydrogen" if model_name == "gemini-4-hydrogen" else "Gemini 3.1 Flash Lite"
                try:
                    return json.loads(text_out), friendly
                except Exception:
                    cleaned = text_out.replace("```json", "").replace("```", "").strip()
                    try:
                        return json.loads(cleaned), friendly
                    except Exception:
                        return {"reply": text_out, "wantsOfficialHandoff": False, "handoffClassification": "NONE"}, friendly
        except urllib.error.HTTPError as e:
            try:
                last_err = e.read().decode("utf-8", errors="ignore")[:300]
            except Exception:
                last_err = str(e)
        except Exception as e:
            last_err = str(e)
    raise RuntimeError(last_err)


def sanitize_filename_token(val):
    cleaned = "".join(c if (c.isalnum() or c in "-_") else "_" for c in str(val or "ticket"))
    return cleaned[:48] or "ticket"


def save_data_url_image(data_url, target_filename):
    if not isinstance(data_url, str) or not data_url.startswith("data:image/"):
        return False
    try:
        header, b64_part = data_url.split(",", 1)
        ext = "jpg"
        if "image/png" in header:
            ext = "png"
        elif "image/webp" in header:
            ext = "webp"
        out_path = os.path.join(PHOTOS_DIR, f"{target_filename}.{ext}")
        if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
            return True
        raw_bytes = base64.b64decode(b64_part)
        with open(out_path, "wb") as img_f:
            img_f.write(raw_bytes)
        return True
    except Exception:
        return False


def sync_report_photos_to_disk(reports_list):
    if not isinstance(reports_list, list):
        return 0
    saved = 0
    for rep in reports_list:
        if not isinstance(rep, dict):
            continue
        token = sanitize_filename_token(rep.get("ticketNumber") or rep.get("id"))
        for idx, photo in enumerate(rep.get("photos") or []):
            if save_data_url_image(photo, f"{token}_resident_{idx + 1}"):
                saved += 1
        for idx, proof in enumerate(rep.get("proofPhotos") or []):
            if save_data_url_image(proof, f"{token}_proof_{idx + 1}"):
                saved += 1
    return saved


def _normalize_ticket_str(raw_ticket):
    t_str = str(raw_ticket or "").strip().lstrip("#")
    for legacy_pfx in ("PULSE-CAV-", "pulse-cav-", "TRASH-CAV-", "DRAW-CAV-"):
        if t_str.startswith(legacy_pfx):
            return "TUGON-CAV-" + t_str[len(legacy_pfx):]
    return t_str


def _status_rank(status):
    return {"PENDING": 1, "DISPATCHED": 2, "CANCELLED": 3, "RESOLVED": 4}.get(str(status or "PENDING").upper(), 1)


def _parse_iso_ts(raw_val):
    if not raw_val:
        return 0.0
    s = str(raw_val).strip()
    if not s:
        return 0.0
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.datetime.fromisoformat(s)
        return dt.timestamp()
    except Exception:
        return 0.0


def _effective_record_ts(rep):
    if not isinstance(rep, dict):
        return 0.0
    for fld in ("updatedAt", "resolvedAt", "cancelledAt", "dispatchedAt", "proofSubmittedAt", "createdAt"):
        ts = _parse_iso_ts(rep.get(fld))
        if ts > 0:
            return ts
    return 0.0


def _extract_target_keys(raw_val):
    raw = str(raw_val or "").strip()
    if not raw:
        return set()
    norm = _normalize_ticket_str(raw).upper()
    keys = {f"id:{raw}", f"tk:{norm}"}
    return {k for k in keys if not k.endswith(":")}


def _extract_report_keys(rep):
    keys = set()
    if not isinstance(rep, dict):
        return keys
    rid = str(rep.get("id") or "").strip()
    if rid:
        keys.add(f"id:{rid}")
    tk = _normalize_ticket_str(rep.get("ticketNumber")).upper()
    if tk:
        keys.add(f"tk:{tk}")
    return keys


def read_deleted_ids():
    if not os.path.exists(DELETED_IDS_FILE):
        return []
    with DB_LOCK:
        try:
            with open(DELETED_IDS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                return [str(x) for x in data if x] if isinstance(data, list) else []
        except Exception:
            return []


def write_deleted_ids(keys_list):
    with DB_LOCK:
        try:
            deduped = []
            seen = set()
            for k in (keys_list or []):
                ks = str(k or "").strip()
                if ks and ks not in seen:
                    seen.add(ks)
                    deduped.append(ks)
            deduped = deduped[-2500:]
            tmp_file = DELETED_IDS_FILE + ".tmp"
            with open(tmp_file, "w", encoding="utf-8") as f:
                json.dump(deduped, f, indent=2, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_file, DELETED_IDS_FILE)
            return deduped
        except Exception as e:
            print(f"[ERROR] Writing deleted IDs failed: {e}")
            return []


def record_deleted_keys(new_keys):
    with DB_LOCK:
        existing = read_deleted_ids()
        combined = existing + [str(k) for k in (new_keys or []) if k]
        return write_deleted_ids(combined)


def merge_pi_reports_non_destructive(existing_list, incoming_list, deleted_keys=None):
    """
    Merges incoming portal/client reports into the authoritative Raspberry Pi database
    without dropping existing Pi reports, wiping resident/proof photos, overwriting metadata
    with empty strings, or resurrecting tombstoned/deleted concerns.
    """
    tombstones = set(deleted_keys) if deleted_keys is not None else set(read_deleted_ids())
    by_key = {}
    ticket_to_key = {}
    ordered_keys = []

    def canonical_key(rep):
        if not isinstance(rep, dict):
            return None
        tk = _normalize_ticket_str(rep.get("ticketNumber")).upper()
        if tk and tk in ticket_to_key:
            return ticket_to_key[tk]
        rid = str(rep.get("id") or "").strip()
        if rid:
            k = f"id:{rid}"
            if tk:
                ticket_to_key[tk] = k
            return k
        if tk:
            k = f"tk:{tk}"
            ticket_to_key[tk] = k
            return k
        return None

    def is_tombstoned(rep):
        if not tombstones:
            return False
        return bool(_extract_report_keys(rep) & tombstones)

    def _safe_merge_records(prev, copy_inc):
        prev_upd = _parse_iso_ts(prev.get("updatedAt"))
        inc_upd = _parse_iso_ts(copy_inc.get("updatedAt"))
        prev_rev = int(prev.get("portalRevision") or 0)
        inc_rev = int(copy_inc.get("portalRevision") or 0)
        prev_score = _status_rank(prev.get("status")) * 10 + len(prev.get("proofPhotos") or [])
        inc_score = _status_rank(copy_inc.get("status")) * 10 + len(copy_inc.get("proofPhotos") or [])

        if inc_upd > 0 or prev_upd > 0:
            if inc_upd > prev_upd + 0.001:
                inc_wins = True
            elif prev_upd > inc_upd + 0.001:
                inc_wins = False
            elif inc_rev != prev_rev:
                inc_wins = inc_rev > prev_rev
            else:
                inc_wins = inc_score >= prev_score
        else:
            inc_wins = inc_score >= prev_score

        winner = copy_inc if inc_wins else prev
        runner = prev if inc_wins else copy_inc
        merged = dict(runner)
        merged.update(winner)

        winner_has_explicit_edit = _parse_iso_ts(winner.get("updatedAt")) > _parse_iso_ts(runner.get("updatedAt"))
        reverted_pending = winner_has_explicit_edit and winner.get("status") == "PENDING"
        if reverted_pending:
            for stale_field in ("dispatchedAt", "dispatchedKagawad", "resolvedAt", "proofSubmittedAt", "cancelledAt"):
                if not winner.get(stale_field):
                    merged.pop(stale_field, None)

        preserve_fields = ("id", "residentName", "residentPhone", "createdAt")
        if not reverted_pending:
            preserve_fields += ("dispatchedAt", "resolvedAt", "proofSubmittedAt", "cancelledAt")
        for field in preserve_fields:
            if not merged.get(field) and runner.get(field):
                merged[field] = runner[field]

        # If winner has no explicit updatedAt, protect metadata against accidental blank wipes
        for field in (
            "streetAddress",
            "houseNumber",
            "landmark",
            "purok",
            "barangay",
            "notes",
            "extraMessage",
            "dispatchedKagawad",
            "resolvedBy",
            "resolutionNotes",
            "proofKagawadName",
            "cancellationReason",
        ):
            if not winner_has_explicit_edit and not merged.get(field) and runner.get(field):
                merged[field] = runner[field]

        winner_photos = winner.get("photos") if isinstance(winner.get("photos"), list) else []
        runner_photos = runner.get("photos") if isinstance(runner.get("photos"), list) else []
        merged["photos"] = winner_photos if len(winner_photos) >= len(runner_photos) and len(winner_photos) > 0 else (runner_photos or winner_photos)

        winner_proofs = winner.get("proofPhotos") if isinstance(winner.get("proofPhotos"), list) else []
        runner_proofs = runner.get("proofPhotos") if isinstance(runner.get("proofPhotos"), list) else []
        merged["proofPhotos"] = winner_proofs if len(winner_proofs) >= len(runner_proofs) and len(winner_proofs) > 0 else (runner_proofs or winner_proofs)

        merged["localSyncStatus"] = "SENT_TO_PI"
        merged["sourceStorage"] = "Raspberry Pi 4B Cloud Storage"
        return merged

    for item in (existing_list or []):
        if not isinstance(item, dict) or is_tombstoned(item):
            continue
        k = canonical_key(item)
        if not k:
            continue
        copy_item = dict(item)
        if copy_item.get("ticketNumber"):
            copy_item["ticketNumber"] = _normalize_ticket_str(copy_item["ticketNumber"])
        copy_item["localSyncStatus"] = "SENT_TO_PI"
        copy_item.setdefault("sourceStorage", "Raspberry Pi 4B Cloud Storage")
        if k not in by_key:
            by_key[k] = copy_item
            ordered_keys.append(k)
        else:
            by_key[k] = _safe_merge_records(by_key[k], copy_item)

    for inc in (incoming_list or []):
        if not isinstance(inc, dict) or is_tombstoned(inc):
            continue
        k = canonical_key(inc)
        if not k:
            continue
        copy_inc = dict(inc)
        if copy_inc.get("ticketNumber"):
            copy_inc["ticketNumber"] = _normalize_ticket_str(copy_inc["ticketNumber"])
        copy_inc["localSyncStatus"] = "SENT_TO_PI"
        copy_inc["sourceStorage"] = copy_inc.get("sourceStorage") or "Raspberry Pi 4B Cloud Storage"

        if k not in by_key:
            by_key[k] = copy_inc
            ordered_keys.append(k)
        else:
            by_key[k] = _safe_merge_records(by_key[k], copy_inc)

    result = [by_key[k] for k in ordered_keys if k in by_key]
    result.sort(key=lambda r: str(r.get("createdAt") or ""), reverse=True)
    return result


def read_pi_reports():
    if not os.path.exists(REPORTS_DB_FILE):
        return []
    with DB_LOCK:
        try:
            with open(REPORTS_DB_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data if isinstance(data, list) else []
        except Exception:
            return []


def write_pi_reports(reports_list):
    with DB_LOCK:
        try:
            tmp_file = REPORTS_DB_FILE + ".tmp"
            with open(tmp_file, "w", encoding="utf-8") as f:
                json.dump(reports_list, f, indent=2, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_file, REPORTS_DB_FILE)
        except Exception as e:
            print(f"[ERROR] Writing reports failed: {e}")
            return False
    try:
        sync_report_photos_to_disk(reports_list)
    except Exception:
        pass
    return True


def read_portal_config():
    if not os.path.exists(PORTAL_CONFIG_FILE):
        return {}
    with DB_LOCK:
        try:
            with open(PORTAL_CONFIG_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data if isinstance(data, dict) else {}
        except Exception:
            return {}


def write_portal_config(cfg):
    with DB_LOCK:
        try:
            current = {}
            if os.path.exists(PORTAL_CONFIG_FILE):
                try:
                    with open(PORTAL_CONFIG_FILE, "r", encoding="utf-8") as f:
                        loaded = json.load(f)
                        if isinstance(loaded, dict):
                            current = loaded
                except Exception:
                    pass
            if isinstance(cfg, dict):
                current.update(cfg)
            tmp_file = PORTAL_CONFIG_FILE + ".tmp"
            with open(tmp_file, "w", encoding="utf-8") as f:
                json.dump(current, f, indent=2, ensure_ascii=False)
            os.replace(tmp_file, PORTAL_CONFIG_FILE)
            return current
        except Exception:
            return cfg


def read_support_chats():
    if not os.path.exists(SUPPORT_CHATS_FILE):
        return []
    with DB_LOCK:
        try:
            with open(SUPPORT_CHATS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data if isinstance(data, list) else []
        except Exception:
            return []


def write_support_chats(threads_list):
    with DB_LOCK:
        try:
            cleaned = [t for t in (threads_list or []) if isinstance(t, dict) and t.get("sessionId")]
            cleaned.sort(key=lambda t: str(t.get("updatedAt") or t.get("createdAt") or ""), reverse=True)
            cleaned = cleaned[:100]
            tmp_file = SUPPORT_CHATS_FILE + ".tmp"
            with open(tmp_file, "w", encoding="utf-8") as f:
                json.dump(cleaned, f, indent=2, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_file, SUPPORT_CHATS_FILE)
            return cleaned
        except Exception as e:
            print(f"[ERROR] Writing support chats failed: {e}")
            return threads_list or []


def get_portal_revision():
    global _PORTAL_REVISION
    with DB_LOCK:
        if _PORTAL_REVISION is None:
            cfg = read_portal_config()
            rev = int(cfg.get("portalRevision") or 1)
            for r in read_pi_reports():
                if isinstance(r, dict):
                    rev = max(rev, int(r.get("portalRevision") or 0))
            _PORTAL_REVISION = max(1, rev)
        return _PORTAL_REVISION


def bump_portal_revision():
    global _PORTAL_REVISION
    with REV_CV:
        cur = get_portal_revision()
        _PORTAL_REVISION = cur + 1
        write_portal_config({"portalRevision": _PORTAL_REVISION})
        REV_CV.notify_all()
        return _PORTAL_REVISION


def get_dir_size_bytes(path):
    total = 0
    try:
        for root, _dirs, files in os.walk(path):
            for f in files:
                fp = os.path.join(root, f)
                if not os.path.islink(fp):
                    try:
                        total += os.path.getsize(fp)
                    except Exception:
                        pass
    except Exception:
        pass
    return total


def get_hardware_model():
    model_path = "/proc/device-tree/model"
    if os.path.exists(model_path):
        try:
            with open(model_path, "rb") as f:
                raw = f.read().replace(b"\x00", b"").decode("utf-8", errors="ignore").strip()
                if raw:
                    return raw
        except Exception:
            pass
    return "Raspberry Pi 4 Model B (Local Cloud Storage)"


def get_ram_summary():
    meminfo = "/proc/meminfo"
    if os.path.exists(meminfo):
        try:
            info = {}
            with open(meminfo, "r", encoding="utf-8") as f:
                for line in f:
                    parts = line.split(":")
                    if len(parts) == 2:
                        key = parts[0].strip()
                        val_kb = int(parts[1].strip().split()[0])
                        info[key] = val_kb
            total_kb = info.get("MemTotal", 0)
            avail_kb = info.get("MemAvailable", info.get("MemFree", 0))
            if total_kb > 0:
                total_gb = round(total_kb / (1024 * 1024), 1)
                used_gb = round((total_kb - avail_kb) / (1024 * 1024), 1)
                pct = round(((total_kb - avail_kb) / total_kb) * 100)
                return f"{used_gb} GB / {total_gb} GB ({pct}%)", pct
        except Exception:
            pass
    return "Active (Healthy)", 35


def get_cpu_temp():
    temp_path = "/sys/class/thermal/thermal_zone0/temp"
    if os.path.exists(temp_path):
        try:
            with open(temp_path, "r", encoding="utf-8") as f:
                c = round(float(f.read().strip()) / 1000.0, 1)
                return f"{c}°C", c
        except Exception:
            pass
    return "42.0°C", 42.0


def get_lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


class PulseHttpHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] {self.address_string()} {args[0]} -> {args[1]}")

    def _send_cors(self):
        req_headers = self.headers.get("Access-Control-Request-Headers", "")
        default_allowed = (
            "Content-Type, Authorization, ngrok-skip-browser-warning, "
            "Bypass-Tunnel-Reminder, X-Requested-With, X-Pi-Endpoint, Accept, Cache-Control, Pragma"
        )
        allow_headers = f"{default_allowed}, {req_headers}" if req_headers else default_allowed
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", allow_headers)
        self.send_header("Access-Control-Expose-Headers", "X-Pi-Online, X-Portal-Revision, Content-Disposition")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("X-Pi-Online", "true")
        self.send_header("X-Portal-Revision", str(get_portal_revision()))
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")

    def _send_json(self, status_code, payload):
        try:
            body = json.dumps(payload, indent=2, ensure_ascii=False).encode("utf-8")
            self.send_response(status_code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self._send_cors()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_OPTIONS(self):
        try:
            self.send_response(204)
            self._send_cors()
            self.end_headers()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path == "/test.txt":
            try:
                body = b"T.U.G.O.N. Raspberry Pi 4B Cloud Storage ONLINE"
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self._send_cors()
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return

        if path == "/api/portal/events":
            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Connection", "keep-alive")
                self.send_header("X-Accel-Buffering", "no")
                self._send_cors()
                self.end_headers()
                last_sent_rev = get_portal_revision()
                init_payload = json.dumps({"type": "portal:init", "revision": last_sent_rev})
                self.wfile.write(f"event: portal-sync\ndata: {init_payload}\n\n".encode("utf-8"))
                self.wfile.flush()
                while True:
                    with REV_CV:
                        REV_CV.wait(timeout=20.0)
                        cur_rev = get_portal_revision()
                    if cur_rev != last_sent_rev:
                        last_sent_rev = cur_rev
                        msg_payload = json.dumps({"type": "portal:sync", "revision": cur_rev})
                        self.wfile.write(f"event: portal-sync\ndata: {msg_payload}\n\n".encode("utf-8"))
                        self.wfile.flush()
                    else:
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            return

        if path == "/api/config":
            cfg = read_portal_config()
            self._send_json(
                200,
                {
                    "success": True,
                    "piOnline": True,
                    "telegramConfigured": bool(cfg.get("telegramBotToken") and cfg.get("telegramChatId")),
                    "telegramSetupComplete": bool(cfg.get("telegramSetupComplete")),
                    "telegramLocked": bool(cfg.get("telegramLocked")),
                    "telegramChatId": cfg.get("telegramChatId", ""),
                    "telegramBotToken": cfg.get("telegramBotToken", ""),
                    "telegramActiveSnapshot": cfg.get("telegramActiveSnapshot", []),
                    "hasCustomPassword": bool(cfg.get("kagawadCustomPassword")),
                    "deletedReportIds": read_deleted_ids()[-500:],
                    "autoPurgeTtlDays": AUTO_PURGE_TTL_DAYS,
                    "portalRevision": get_portal_revision(),
                },
            )
            return

        if path == "/api/support-chat":
            threads = read_support_chats()
            session_id = str((qs.get("sessionId") or [""])[0]).strip()
            if session_id:
                threads = [t for t in threads if str(t.get("sessionId")) == session_id]
            self._send_json(200, {"success": True, "threads": threads, "revision": get_portal_revision()})
            return

        if path == "/" or path.startswith("/api/health") or path.startswith("/api/storage"):
            cpu_temp_str, cpu_temp_val = get_cpu_temp()
            ram_str, ram_pct = get_ram_summary()
            hw_model = get_hardware_model()

            total_gb, used_gb, free_gb = 500.0, 20.0, 480.0
            try:
                total, used, free = shutil.disk_usage(STORAGE_DIR)
                total_gb = round(total / (1024**3), 1)
                used_gb = round(used / (1024**3), 1)
                free_gb = round(free / (1024**3), 1)
            except Exception:
                pass

            pulse_bytes = get_dir_size_bytes(STORAGE_DIR)
            pulse_mb = round(pulse_bytes / (1024 * 1024), 2)
            pulse_kb = round(pulse_bytes / 1024, 1)

            logbooks_count = (
                len([f for f in os.listdir(LOGBOOKS_DIR) if f.endswith(".json")])
                if os.path.exists(LOGBOOKS_DIR)
                else 0
            )
            disk_photos_count = (
                len([f for f in os.listdir(PHOTOS_DIR) if not f.startswith(".")])
                if os.path.exists(PHOTOS_DIR)
                else 0
            )
            purged_count = len(os.listdir(ARCHIVES_DIR)) if os.path.exists(ARCHIVES_DIR) else 0
            reports_data = read_pi_reports()

            resident_photos = sum(len(r.get("photos") or []) for r in reports_data if isinstance(r, dict))
            proof_photos = sum(len(r.get("proofPhotos") or []) for r in reports_data if isinstance(r, dict))

            data = {
                "status": "ONLINE",
                "online": True,
                "system": "T.U.G.O.N. Raspberry Pi 4B Server",
                "hardware": hw_model,
                "ram": ram_str,
                "ramUsagePercent": ram_pct,
                "storage_folder": STORAGE_DIR,
                "disk_total": f"{total_gb} GB",
                "disk_used": f"{used_gb} GB",
                "disk_free": f"{free_gb} GB",
                "pulse_folder_mb": pulse_mb,
                "pulse_folder_kb": pulse_kb,
                "pulse_storage_summary": f"{pulse_mb} MB ({pulse_kb} KB) used on hard drive",
                "logbooks_count": logbooks_count,
                "photos_count": max(disk_photos_count, resident_photos + proof_photos),
                "disk_photos_files": disk_photos_count,
                "resident_photos_count": resident_photos,
                "proof_photos_count": proof_photos,
                "reports_count": len(reports_data),
                "purged_archives_count": purged_count,
                "autoPurgeTtlDays": AUTO_PURGE_TTL_DAYS,
                "deletedReportIds": read_deleted_ids()[-500:],
                "cpu_temp": cpu_temp_str,
                "cpuTempCelsius": cpu_temp_val,
                "lan_ip": get_lan_ip(),
                "hostname": socket.gethostname(),
                "portalRevision": get_portal_revision(),
                "time": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            }
            self._send_json(200, data)
            return

        if path.startswith("/photos/") or path.startswith("/api/photos/"):
            prefix = "/api/photos/" if path.startswith("/api/photos/") else "/photos/"
            raw_photo = urllib.parse.unquote(path[len(prefix):]).strip("/")
            safe_photo = os.path.basename(raw_photo)
            photo_fp = os.path.join(PHOTOS_DIR, safe_photo)
            if os.path.exists(photo_fp) and os.path.isfile(photo_fp):
                try:
                    ext = os.path.splitext(safe_photo)[1].lower()
                    mime = (
                        "image/png"
                        if ext == ".png"
                        else "image/webp"
                        if ext == ".webp"
                        else "image/jpeg"
                    )
                    with open(photo_fp, "rb") as pf:
                        img_bytes = pf.read()
                    self.send_response(200)
                    self.send_header("Content-Type", mime)
                    self.send_header("Cache-Control", "public, max-age=86400")
                    self._send_cors()
                    self.send_header("Content-Length", str(len(img_bytes)))
                    self.end_headers()
                    self.wfile.write(img_bytes)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                except Exception as e:
                    self._send_json(500, {"error": str(e)})
                return
            self._send_json(404, {"error": "Photo file not found on Pi"})
            return

        if path.startswith("/api/reports"):
            reports_data = read_pi_reports()
            for r in reports_data:
                if isinstance(r, dict) and r.get("ticketNumber"):
                    t_str = str(r["ticketNumber"]).strip().lstrip("#")
                    for legacy_pfx in ("PULSE-CAV-", "pulse-cav-", "TRASH-CAV-", "DRAW-CAV-"):
                        if t_str.startswith(legacy_pfx):
                            t_str = "TUGON-CAV-" + t_str[len(legacy_pfx):]
                            break
                    r["ticketNumber"] = t_str
            summary_param = str((qs.get("summary") or [""])[0]).strip().lower()
            is_summary = summary_param in ("1", "true", "yes")
            if is_summary:
                summarized = []
                for r in reports_data:
                    if not isinstance(r, dict):
                        continue
                    item = dict(r)
                    p_list = item.get("photos")
                    pr_list = item.get("proofPhotos")
                    item["photosCount"] = len(p_list) if isinstance(p_list, list) else int(item.get("photosCount") or 0)
                    item["proofPhotosCount"] = len(pr_list) if isinstance(pr_list, list) else int(item.get("proofPhotosCount") or 0)
                    item["photos"] = []
                    item["proofPhotos"] = []
                    summarized.append(item)
                reports_data = summarized
            if "ids" in qs:
                raw_ids = [s.strip() for s in (qs.get("ids") or [""])[0].split(",") if s.strip()]
                if not raw_ids:
                    self._send_json(200, [])
                    return
                id_set = set(raw_ids)
                norm_set = {
                    s.lstrip("#").upper().replace("PULSE-CAV-", "TUGON-CAV-") for s in raw_ids
                }
                filtered = [
                    r
                    for r in reports_data
                    if isinstance(r, dict)
                    and (
                        str(r.get("id")) in id_set
                        or str(r.get("ticketNumber")) in id_set
                        or str(r.get("ticketNumber", "")).upper() in norm_set
                    )
                ]
                self._send_json(200, filtered)
                return
            self._send_json(200, reports_data)
            return

        if path.startswith("/api/logbooks/"):
            raw_name = urllib.parse.unquote(path[len("/api/logbooks/"):]).strip("/")
            safe_name = os.path.basename(raw_name)
            fp = os.path.join(LOGBOOKS_DIR, safe_name)
            if os.path.exists(fp) and os.path.isfile(fp):
                try:
                    with open(fp, "r", encoding="utf-8") as f:
                        content = json.load(f)
                    self._send_json(200, content)
                    return
                except Exception as e:
                    self._send_json(500, {"error": str(e)})
                    return
            self._send_json(404, {"error": "Logbook file not found on Pi"})
            return

        if path.startswith("/api/logbooks"):
            logs = []
            if os.path.exists(LOGBOOKS_DIR):
                for f in sorted(os.listdir(LOGBOOKS_DIR), reverse=True):
                    if f.endswith(".json"):
                        fp = os.path.join(LOGBOOKS_DIR, f)
                        try:
                            st = os.stat(fp)
                            meta = {}
                            try:
                                with open(fp, "r", encoding="utf-8") as jf:
                                    loaded = json.load(jf)
                                    if isinstance(loaded, dict):
                                        meta = {
                                            "id": loaded.get("logbookId") or loaded.get("id") or f,
                                            "savedBy": loaded.get("savedBy") or "Barangay Official",
                                            "savedAtPhilippineTime": loaded.get("savedAtPhilippineTime"),
                                            "totalRecords": loaded.get("totalRecords", len(loaded.get("reports") or [])),
                                        }
                            except Exception:
                                pass
                            mod_str = datetime.datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M:%S")
                            logs.append(
                                {
                                    "id": meta.get("id", f),
                                    "filename": f,
                                    "path": fp,
                                    "sizeBytes": st.st_size,
                                    "sizeKb": round(st.st_size / 1024, 1),
                                    "savedBy": meta.get("savedBy", "Barangay Official"),
                                    "totalRecords": meta.get("totalRecords", 0),
                                    "modified": meta.get("savedAtPhilippineTime") or mod_str,
                                }
                            )
                        except Exception:
                            pass
            self._send_json(200, logs)
            return

        self._send_json(404, {"error": "Endpoint not found", "path": path})

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length", 0))
        raw_data = self.rfile.read(length) if length > 0 else b""

        if path == "/api/config":
            try:
                payload = json.loads(raw_data.decode("utf-8")) if raw_data else {}
                saved = write_portal_config(payload if isinstance(payload, dict) else {})
                self._send_json(200, {"success": True, "config": saved})
            except Exception as e:
                self._send_json(500, {"success": False, "error": str(e)})
            return

        if path == "/api/reports/clear-all":
            with DB_LOCK:
                existing = read_pi_reports()
                keys = []
                for r in existing:
                    keys.extend(_extract_report_keys(r))
                if keys:
                    record_deleted_keys(keys)
                write_pi_reports([])
                rev = bump_portal_revision()
            self._send_json(200, {"success": True, "count": 0, "revision": rev})
            return

        if path.startswith("/api/reports/sync"):
            try:
                payload = json.loads(raw_data.decode("utf-8")) if raw_data else []
                replace_mode = False
                if isinstance(payload, dict) and "reports" in payload and isinstance(payload["reports"], list):
                    incoming_reports = payload["reports"]
                    replace_mode = bool(payload.get("replace"))
                elif isinstance(payload, list):
                    incoming_reports = payload
                else:
                    incoming_reports = []

                with DB_LOCK:
                    existing = read_pi_reports()
                    deleted_keys = set(read_deleted_ids())
                    if replace_mode:
                        reports_to_save = merge_pi_reports_non_destructive([], incoming_reports, deleted_keys)
                    elif len(incoming_reports) == 0 and len(existing) > 0:
                        # Guard against empty sync payloads wiping existing Pi database
                        reports_to_save = merge_pi_reports_non_destructive(existing, [], deleted_keys)
                    else:
                        reports_to_save = merge_pi_reports_non_destructive(existing, incoming_reports, deleted_keys)
                    changed = reports_to_save != existing
                    write_pi_reports(reports_to_save)
                    rev = bump_portal_revision() if changed else get_portal_revision()

                pulse_bytes = get_dir_size_bytes(STORAGE_DIR)
                pulse_mb = round(pulse_bytes / (1024 * 1024), 2)
                self._send_json(
                    200,
                    {
                        "success": True,
                        "count": len(reports_to_save),
                        "reports": reports_to_save,
                        "deletedReportIds": read_deleted_ids()[-500:],
                        "revision": rev,
                        "file": REPORTS_DB_FILE,
                        "photos_dir": PHOTOS_DIR,
                        "pulse_folder_mb": pulse_mb,
                    },
                )
            except Exception as e:
                self._send_json(500, {"success": False, "error": str(e)})
            return

        if path == "/api/reports":
            try:
                payload = json.loads(raw_data.decode("utf-8")) if raw_data else {}

                if isinstance(payload, list):
                    with DB_LOCK:
                        deleted_keys = set(read_deleted_ids())
                        merged = merge_pi_reports_non_destructive(read_pi_reports(), payload, deleted_keys)
                        write_pi_reports(merged)
                        rev = bump_portal_revision()
                    self._send_json(200, {"success": True, "count": len(merged), "reports": merged, "revision": rev})
                    return

                if isinstance(payload, dict) and "reports" in payload and isinstance(payload["reports"], list):
                    with DB_LOCK:
                        deleted_keys = set(read_deleted_ids())
                        merged = merge_pi_reports_non_destructive(read_pi_reports(), payload["reports"], deleted_keys)
                        write_pi_reports(merged)
                        rev = bump_portal_revision()
                    self._send_json(200, {"success": True, "count": len(merged), "reports": merged, "revision": rev})
                    return

                if isinstance(payload, dict):
                    rep_id = str(payload.get("id") or f"rep-{int(time.time() * 1000)}")
                    raw_ticket = str(
                        payload.get("ticketNumber") or f"TUGON-CAV-{int(time.time() * 1000) % 10000:04d}"
                    ).strip().lstrip("#")
                    ticket_num = _normalize_ticket_str(raw_ticket)
                    now_iso = datetime.datetime.utcnow().isoformat() + "Z"
                    new_rep = dict(payload)
                    new_rep["id"] = rep_id
                    new_rep["ticketNumber"] = ticket_num
                    new_rep["localSyncStatus"] = "SENT_TO_PI"
                    new_rep["sourceStorage"] = new_rep.get("sourceStorage") or "Raspberry Pi 4B Cloud Storage"
                    new_rep.setdefault("status", "PENDING")
                    new_rep.setdefault("createdAt", now_iso)
                    new_rep.setdefault("updatedAt", new_rep.get("createdAt") or now_iso)
                    new_rep.setdefault("photos", [])
                    new_rep.setdefault("proofPhotos", [])

                    with DB_LOCK:
                        current = read_pi_reports()
                        deleted_keys = set(read_deleted_ids())
                        updated_list = merge_pi_reports_non_destructive(current, [new_rep], deleted_keys)
                        write_pi_reports(updated_list)
                        rev = bump_portal_revision()
                        stored_rep = next(
                            (r for r in updated_list if str(r.get("id")) == rep_id or str(r.get("ticketNumber")) == ticket_num),
                            new_rep,
                        )

                    self._send_json(201, {"success": True, "report": stored_rep, "count": len(updated_list), "revision": rev})
                    return

                self._send_json(400, {"success": False, "error": "Invalid report payload"})
            except Exception as e:
                self._send_json(500, {"success": False, "error": str(e)})
            return

        if path.startswith("/api/logbook/save"):
            try:
                payload = json.loads(raw_data.decode("utf-8")) if raw_data else {}
                requested_name = payload.get("filename") if isinstance(payload, dict) else None
                if requested_name and str(requested_name).endswith(".json"):
                    filename = os.path.basename(str(requested_name))
                else:
                    filename = f"TUGON_Logbook_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
                file_path = os.path.join(LOGBOOKS_DIR, filename)
                with open(file_path, "w", encoding="utf-8") as f:
                    json.dump(payload, f, indent=2, ensure_ascii=False)
                if isinstance(payload, dict) and isinstance(payload.get("reports"), list):
                    sync_report_photos_to_disk(payload["reports"])
                pulse_bytes = get_dir_size_bytes(STORAGE_DIR)
                pulse_mb = round(pulse_bytes / (1024 * 1024), 2)
                self._send_json(
                    200,
                    {
                        "success": True,
                        "message": "Logbook saved to Raspberry Pi Hard Drive!",
                        "filename": filename,
                        "file": file_path,
                        "folder": LOGBOOKS_DIR,
                        "current_pulse_storage_mb": pulse_mb,
                    },
                )
            except Exception as e:
                self._send_json(500, {"success": False, "error": str(e)})
            return

        if path == "/api/support-chat":
            try:
                payload = json.loads(raw_data.decode("utf-8")) if raw_data else {}
                session_id = str(payload.get("sessionId") or "").strip()
                text = str(payload.get("text") or "").strip()
                sender = "official" if str(payload.get("sender") or "").lower() == "official" else "resident"
                if not session_id or not text:
                    self._send_json(400, {"success": False, "error": "sessionId and text are required"})
                    return
                now_iso = datetime.datetime.utcnow().isoformat() + "Z"
                ack_iso = datetime.datetime.utcfromtimestamp(time.time() + 0.002).isoformat() + "Z"
                req_lang = "en" if payload.get("lang") == "en" else "tl"
                folder_val = "SPAM" if str(payload.get("folder") or "").upper() == "SPAM" else "INBOX"
                spam_reason = str(payload.get("spamReason") or "").strip()[:200]
                handoff_summary = str(payload.get("aiHandoffSummary") or "").strip()[:400]
                message_id = str(payload.get("messageId") or f"sc-{int(time.time() * 1000)}")
                msg_entry = {
                    "id": message_id,
                    "sender": sender,
                    "senderName": str(payload.get("senderName") or ("Barangay Official" if sender == "official" else "Resident")).strip()[:80],
                    "text": text,
                    "timestamp": str(payload.get("timestamp") or now_iso),
                }
                with DB_LOCK:
                    threads = read_support_chats()
                    target = next((t for t in threads if str(t.get("sessionId")) == session_id), None)
                    raw_ticket = payload.get("ticketNumber") if payload.get("ticketNumber") is not None else (target.get("ticketNumber") if target else "")
                    ticket_str = str(raw_ticket or "").strip().lstrip("#")
                    ack_entry = None
                    if sender == "resident":
                        passed_ack = payload.get("ackMessage")
                        if isinstance(passed_ack, dict) and passed_ack.get("id") and passed_ack.get("text"):
                            ack_entry = passed_ack
                        else:
                            text_en = (
                                "Your message was received by T.U.G.O.N. and placed in review. Please share specific Barangay 40 & 41 waste concern details for immediate official assistance."
                                if folder_val == "SPAM"
                                else (
                                    f"Your message regarding #{ticket_str} has been delivered to Barangay 40 & 41 Officials. Please wait shortly for a response."
                                    if ticket_str
                                    else "Your message has been delivered to Barangay 40 & 41 Officials. Please wait shortly for a response."
                                )
                            )
                            text_tl = (
                                "Natanggap ng T.U.G.O.N. ang iyong mensahe para sa review. Maglagay ng malinaw na detalye tungkol sa basura sa Barangay 40 & 41 para sa agarang tulong."
                                if folder_val == "SPAM"
                                else (
                                    f"Naipadala na ang iyong mensahe tungkol sa #{ticket_str} sa mga Opisyal ng Barangay 40 & 41. Mangyaring maghintay sandali para sa kanilang tugon."
                                    if ticket_str
                                    else "Naipadala na ang iyong mensahe sa mga Opisyal ng Barangay 40 & 41. Mangyaring maghintay sandali para sa kanilang tugon."
                                )
                            )
                            ack_entry = {
                                "id": f"{message_id}-ack",
                                "sender": "ai",
                                "senderName": "T.U.G.O.N. AI",
                                "text": text_en if req_lang == "en" else text_tl,
                                "textEn": text_en,
                                "textTl": text_tl,
                                "timestamp": ack_iso,
                            }
                    if target is None:
                        target = {
                            "sessionId": session_id,
                            "residentName": str(payload.get("residentName") or "Resident").strip()[:80] or "Resident",
                            "barangay": str(payload.get("barangay") or "Barangay 40 & 41").strip()[:40],
                            "ticketNumber": str(payload.get("ticketNumber") or "").strip()[:32],
                            "status": "NEEDS_OFFICIAL" if (sender == "resident" or payload.get("requestOfficial")) else "OPEN",
                            "folder": folder_val,
                            "spamReason": spam_reason if folder_val == "SPAM" else "",
                            "aiHandoffSummary": handoff_summary,
                            "unreadByOfficial": 1 if (sender == "resident" and folder_val != "SPAM") else 0,
                            "unreadByResident": 1 if sender == "official" else 0,
                            "createdAt": now_iso,
                            "updatedAt": now_iso,
                            "messages": [msg_entry, ack_entry] if ack_entry else [msg_entry],
                        }
                        threads.insert(0, target)
                    else:
                        if payload.get("residentName") and str(payload.get("residentName")).strip():
                            target["residentName"] = str(payload.get("residentName")).strip()[:80]
                        if payload.get("barangay") and str(payload.get("barangay")).strip():
                            target["barangay"] = str(payload.get("barangay")).strip()[:40]
                        if payload.get("ticketNumber") is not None:
                            target["ticketNumber"] = str(payload.get("ticketNumber")).strip()[:32]
                        if handoff_summary:
                            target["aiHandoffSummary"] = handoff_summary
                        if sender == "resident":
                            target["folder"] = folder_val
                            target["spamReason"] = spam_reason if folder_val == "SPAM" else ""
                        else:
                            target["folder"] = "INBOX"
                            target["spamReason"] = ""
                        msgs = target.get("messages") if isinstance(target.get("messages"), list) else []
                        if not any(isinstance(m, dict) and str(m.get("id")) == msg_entry["id"] for m in msgs):
                            msgs.append(msg_entry)
                        if ack_entry and not any(isinstance(m, dict) and str(m.get("id")) == ack_entry["id"] for m in msgs):
                            msgs.append(ack_entry)
                        target["messages"] = msgs
                        target["updatedAt"] = now_iso
                        if sender == "resident":
                            if folder_val != "SPAM":
                                target["unreadByOfficial"] = int(target.get("unreadByOfficial") or 0) + 1
                            target["unreadByResident"] = 0
                            if payload.get("requestOfficial") or target.get("status") == "RESOLVED":
                                target["status"] = "NEEDS_OFFICIAL"
                        else:
                            target["unreadByResident"] = int(target.get("unreadByResident") or 0) + 1
                            target["unreadByOfficial"] = 0
                            if target.get("status") == "OPEN":
                                target["status"] = "NEEDS_OFFICIAL"
                    saved_threads = write_support_chats(threads)
                    rev = bump_portal_revision()
                self._send_json(200, {"success": True, "thread": target, "threads": saved_threads, "revision": rev})
            except Exception as e:
                self._send_json(500, {"success": False, "error": str(e)})
            return

        if path == "/api/chat/ai":
            try:
                payload = json.loads(raw_data.decode("utf-8")) if raw_data else {}
                req_lang = "en" if payload.get("lang") == "en" else "tl"
                req_role = "kagawad" if payload.get("role") == "kagawad" else "resident"
                user_msg = str(payload.get("message") or "").strip()
                img_b64 = str(payload.get("imageBase64") or "").strip()
                if "," in img_b64 and img_b64.startswith("data:image/"):
                    img_b64 = img_b64.split(",", 1)[1].strip()
                img_mime = str(payload.get("imageMimeType") or "image/jpeg").lower()
                if img_mime == "image/jpg":
                    img_mime = "image/jpeg"
                if not user_msg and not img_b64:
                    self._send_json(400, {"success": False, "error": "Please enter a message or attach a photo."})
                    return

                api_key = get_pi_gemini_api_key()
                if not api_key:
                    self._send_json(503, {"success": False, "error": "GEMINI_API_KEY is not set on Raspberry Pi server."})
                    return

                all_reports = read_pi_reports()
                active = [r for r in all_reports if isinstance(r, dict) and str(r.get("status", "PENDING")).upper() in ("PENDING", "DISPATCHED")]
                pending_cnt = sum(1 for r in active if str(r.get("status", "PENDING")).upper() == "PENDING")
                disp_cnt = len(active) - pending_cnt
                res_cnt = sum(1 for r in all_reports if isinstance(r, dict) and str(r.get("status", "")).upper() == "RESOLVED")

                ticket_lines = []
                if req_role == "resident" and isinstance(payload.get("residentReports"), list):
                    by_id = {str(r.get("id")): r for r in all_reports if isinstance(r, dict) and r.get("id")}
                    for lr in payload["residentReports"]:
                        if not isinstance(lr, dict):
                            continue
                        fresh = by_id.get(str(lr.get("id"))) or lr
                        tk = str(fresh.get("ticketNumber") or lr.get("ticketNumber") or "N/A").lstrip("#")
                        st = str(fresh.get("status") or lr.get("status") or "PENDING").upper()
                        brgy = fresh.get("barangay") or lr.get("barangay") or "Brgy 40/41"
                        ticket_lines.append(f"- #{tk} | Status: {st} | {brgy} | Notes: {str(fresh.get('notes') or '')}")

                strict_lang = (
                    "STRICT OUTPUT LANGUAGE: Write your ENTIRE reply in natural, clear English ONLY — even if notes or input contain Tagalog."
                    if req_lang == "en"
                    else "STRICT OUTPUT LANGUAGE: Write your ENTIRE reply in natural, clear Tagalog/Filipino ONLY — even if input is English."
                )
                sys_instr = (
                    "You are the official T.U.G.O.N. AI Assistant powered by Google Gemini for Barangay 40 (Gumamela) & Barangay 41 (Rosal), Cavite City Waste Collection Service.\n"
                    f"{strict_lang}\nRole: {req_role}.\n"
                    f"Queue Summary: Active={len(active)} (Pending={pending_cnt}, Dispatched={disp_cnt}), Resolved={res_cnt}.\n"
                    + ("Device Reports:\n" + "\n".join(ticket_lines) if ticket_lines else "")
                    + "\nGive complete, thorough answers with NO arbitrary length cutoffs. Refuse off-topic non-TUGON queries politely. Return JSON with keys: reply (string), wantsOfficialHandoff (boolean), handoffClassification (IMPORTANT|SPAM_REDUNDANT|NONE), handoffSummary (string), moderationReason (string)."
                )

                contents = []
                for h in (payload.get("history") or []):
                    if isinstance(h, dict) and isinstance(h.get("text"), str) and h["text"].strip():
                        contents.append({
                            "role": "model" if h.get("role") == "assistant" else "user",
                            "parts": [{"text": h["text"].strip()}],
                        })
                cur_parts = []
                if img_b64:
                    cur_parts.append({"inlineData": {"mimeType": img_mime, "data": img_b64}})
                cur_parts.append({"text": user_msg or "Inspect this waste photo for T.U.G.O.N. Barangay 40/41."})
                contents.append({"role": "user", "parts": cur_parts})

                schema = {
                    "type": "OBJECT",
                    "properties": {
                        "reply": {"type": "STRING"},
                        "wantsOfficialHandoff": {"type": "BOOLEAN"},
                        "handoffClassification": {"type": "STRING"},
                        "handoffSummary": {"type": "STRING"},
                        "moderationReason": {"type": "STRING"},
                    },
                    "required": ["reply", "wantsOfficialHandoff", "handoffClassification"],
                }
                parsed, model_used = call_pi_gemini_json(
                    api_key, sys_instr, contents, schema, prefer_fastest=False, has_image=bool(img_b64)
                )
                reply_text = str(parsed.get("reply") or "").strip()
                if not reply_text:
                    self._send_json(502, {"success": False, "error": "Empty AI response"})
                    return
                wants_handoff = bool(parsed.get("wantsOfficialHandoff"))
                cls_raw = str(parsed.get("handoffClassification") or "NONE").upper()
                handoff_cls = "NONE" if not wants_handoff else ("SPAM_REDUNDANT" if cls_raw == "SPAM_REDUNDANT" else "IMPORTANT")
                self._send_json(200, {
                    "success": True,
                    "reply": reply_text,
                    "modelUsed": f"{model_used} Vision" if img_b64 else model_used,
                    "wantsOfficialHandoff": wants_handoff,
                    "handoffClassification": handoff_cls,
                    "handoffSummary": str(parsed.get("handoffSummary") or "").strip(),
                    "moderationReason": str(parsed.get("moderationReason") or "").strip(),
                })
            except Exception as e:
                self._send_json(502, {"success": False, "error": str(e)})
            return

        if path == "/api/chat/ai/translate":
            try:
                payload = json.loads(raw_data.decode("utf-8")) if raw_data else {}
                req_lang = "en" if payload.get("targetLang") == "en" else "tl"
                raw_items = payload.get("items") or []
                valid_items = [
                    {"id": str(it.get("id")), "text": str(it.get("text"))}
                    for it in raw_items
                    if isinstance(it, dict) and it.get("id") and isinstance(it.get("text"), str) and it["text"].strip()
                ]
                if not valid_items:
                    self._send_json(200, {"success": True, "translations": {}})
                    return
                api_key = get_pi_gemini_api_key()
                if not api_key:
                    self._send_json(503, {"success": False, "error": "GEMINI_API_KEY is not set on Raspberry Pi server."})
                    return
                target_name = "English" if req_lang == "en" else "Tagalog / Filipino"
                sys_instr = (
                    f"Translate each T.U.G.O.N. AI Assistant reply accurately and completely into natural {target_name}.\n"
                    "Preserve every detail, ticket code (#TUGON-CAV-...), status token (PENDING, DISPATCHED, RESOLVED, CANCELLED), and Barangay name verbatim.\n"
                    "Do NOT shorten or summarize any message. Return JSON matching the schema."
                )
                schema = {
                    "type": "OBJECT",
                    "properties": {
                        "translations": {
                            "type": "ARRAY",
                            "items": {
                                "type": "OBJECT",
                                "properties": {"id": {"type": "STRING"}, "text": {"type": "STRING"}},
                                "required": ["id", "text"],
                            },
                        }
                    },
                    "required": ["translations"],
                }
                parsed, model_used = call_pi_gemini_json(
                    api_key,
                    sys_instr,
                    [{"role": "user", "parts": [{"text": json.dumps(valid_items)}]}],
                    schema,
                    prefer_fastest=True,
                )
                trans_map = {}
                for entry in (parsed.get("translations") or []):
                    if isinstance(entry, dict) and entry.get("id") and isinstance(entry.get("text"), str) and entry["text"].strip():
                        trans_map[str(entry["id"])] = entry["text"].strip()
                self._send_json(200, {"success": True, "translations": trans_map, "modelUsed": model_used})
            except Exception as e:
                self._send_json(502, {"success": False, "error": str(e)})
            return

        self._send_json(404, {"error": "POST endpoint not found", "path": path})

    def do_PATCH(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length", 0))
        raw_data = self.rfile.read(length) if length > 0 else b""

        if path.startswith("/api/reports/"):
            try:
                remainder = path[len("/api/reports/"):].strip("/")
                if remainder.endswith("/status"):
                    remainder = remainder[: -len("/status")].strip("/")
                target_id = urllib.parse.unquote(remainder)
                payload = json.loads(raw_data.decode("utf-8")) if raw_data else {}
                now_iso = datetime.datetime.utcnow().isoformat() + "Z"
                matched = None
                target_norm = target_id.lstrip("#").upper().replace("PULSE-CAV-", "TUGON-CAV-")

                with DB_LOCK:
                    current = read_pi_reports()
                    for rep in current:
                        if isinstance(rep, dict) and (
                            str(rep.get("id")) == target_id
                            or str(rep.get("ticketNumber")) == target_id
                            or str(rep.get("ticketNumber", "")).lstrip("#").upper().replace("PULSE-CAV-", "TUGON-CAV-")
                            == target_norm
                        ):
                            editable_fields = (
                                "residentName",
                                "residentPhone",
                                "barangay",
                                "purok",
                                "streetAddress",
                                "houseNumber",
                                "landmark",
                                "notes",
                                "extraMessage",
                                "severityLevel",
                                "urgency",
                                "dispatchedKagawad",
                                "resolvedBy",
                                "resolutionNotes",
                                "proofKagawadName",
                                "cancellationReason",
                            )
                            for fld in editable_fields:
                                if fld in payload and payload[fld] is not None:
                                    rep[fld] = payload[fld]
                            for bool_fld in ("isElderly", "isWithinJurisdiction", "needsAssistanceOutside", "isWithinBrgy41"):
                                if bool_fld in payload and payload[bool_fld] is not None:
                                    rep[bool_fld] = bool(payload[bool_fld])

                            status = payload.get("status")
                            if status:
                                rep["status"] = status
                                if status == "PENDING":
                                    rep.pop("dispatchedAt", None)
                                    if payload.get("dispatchedKagawad") is None:
                                        rep.pop("dispatchedKagawad", None)
                                elif status == "DISPATCHED":
                                    rep["dispatchedAt"] = payload.get("dispatchedAt") or now_iso
                                    rep["dispatchedKagawad"] = payload.get("dispatchedKagawad") or rep.get("dispatchedKagawad") or "Barangay Official"
                                elif status == "RESOLVED":
                                    rep["resolvedAt"] = payload.get("resolvedAt") or now_iso
                                    rep["resolvedBy"] = payload.get("resolvedBy") or rep.get("resolvedBy") or "Barangay Official"
                                    if isinstance(payload.get("proofPhotos"), list):
                                        rep["proofPhotos"] = payload["proofPhotos"]
                                        if len(payload["proofPhotos"]) > 0:
                                            rep["proofSubmittedAt"] = payload.get("proofSubmittedAt") or now_iso
                                    if payload.get("resolutionNotes") is not None:
                                        rep["resolutionNotes"] = payload["resolutionNotes"]
                                    if payload.get("proofKagawadName") is not None:
                                        rep["proofKagawadName"] = payload["proofKagawadName"]
                                elif status == "CANCELLED":
                                    rep["cancelledAt"] = payload.get("cancelledAt") or now_iso
                                    rep["cancellationReason"] = payload.get("cancellationReason") or rep.get("cancellationReason") or "Cancelled"

                            rep["updatedAt"] = payload.get("updatedAt") or now_iso
                            rev = bump_portal_revision()
                            rep["portalRevision"] = rev
                            matched = rep
                            break

                    if not matched:
                        self._send_json(404, {"success": False, "error": "Report not found on Pi"})
                        return

                    write_pi_reports(current)
                self._send_json(200, {"success": True, "report": matched, "revision": matched.get("portalRevision")})
            except Exception as e:
                self._send_json(500, {"success": False, "error": str(e)})
            return

        if path == "/api/support-chat":
            try:
                payload = json.loads(raw_data.decode("utf-8")) if raw_data else {}
                session_id = str(payload.get("sessionId") or "").strip()
                if not session_id:
                    self._send_json(400, {"success": False, "error": "sessionId is required"})
                    return
                with DB_LOCK:
                    threads = read_support_chats()
                    target = next((t for t in threads if str(t.get("sessionId")) == session_id), None)
                    if not target:
                        self._send_json(404, {"success": False, "error": "Support thread not found"})
                        return
                    if payload.get("status") in ("OPEN", "NEEDS_OFFICIAL", "RESOLVED"):
                        target["status"] = payload["status"]
                    if payload.get("folder") in ("INBOX", "SPAM"):
                        target["folder"] = payload["folder"]
                        if payload["folder"] == "INBOX":
                            target["spamReason"] = ""
                    if payload.get("markReadFor") == "official":
                        target["unreadByOfficial"] = 0
                    elif payload.get("markReadFor") == "resident":
                        target["unreadByResident"] = 0
                    target["updatedAt"] = datetime.datetime.utcnow().isoformat() + "Z"
                    saved_threads = write_support_chats(threads)
                    rev = bump_portal_revision()
                self._send_json(200, {"success": True, "thread": target, "threads": saved_threads, "revision": rev})
            except Exception as e:
                self._send_json(500, {"success": False, "error": str(e)})
            return

        self._send_json(404, {"error": "PATCH endpoint not found", "path": path})

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path.startswith("/api/reports"):
            target_id = (qs.get("id") or [""])[0].strip()
            if not target_id and path.startswith("/api/reports/"):
                target_id = urllib.parse.unquote(path[len("/api/reports/"):].strip("/"))
            if not target_id:
                self._send_json(400, {"success": False, "error": "Missing report id"})
                return
            target_norm = _normalize_ticket_str(target_id.lstrip("#")).upper()
            with DB_LOCK:
                current = read_pi_reports()
                keys_to_tombstone = set(_extract_target_keys(target_id))
                filtered = []
                for r in current:
                    if not isinstance(r, dict):
                        continue
                    is_match = (
                        str(r.get("id")) == target_id
                        or str(r.get("ticketNumber")) == target_id
                        or _normalize_ticket_str(str(r.get("ticketNumber", "")).lstrip("#")).upper()
                        == target_norm
                    )
                    if is_match:
                        keys_to_tombstone.update(_extract_report_keys(r))
                    else:
                        filtered.append(r)
                record_deleted_keys(keys_to_tombstone)
                write_pi_reports(filtered)
                rev = bump_portal_revision()
            self._send_json(
                200,
                {
                    "success": True,
                    "deletedId": target_id,
                    "remaining": len(filtered),
                    "revision": rev,
                },
            )
            return

        if path.startswith("/api/logbooks"):
            target_file = (qs.get("filename") or qs.get("id") or [""])[0].strip()
            if not target_file and path.startswith("/api/logbooks/"):
                target_file = urllib.parse.unquote(path[len("/api/logbooks/"):].strip("/"))
            if not target_file:
                self._send_json(400, {"success": False, "error": "Missing filename"})
                return
            safe_name = os.path.basename(target_file)
            deleted = False
            if os.path.exists(LOGBOOKS_DIR):
                for fname in os.listdir(LOGBOOKS_DIR):
                    if fname == safe_name or target_file in fname:
                        fp = os.path.join(LOGBOOKS_DIR, fname)
                        try:
                            os.remove(fp)
                            deleted = True
                        except Exception:
                            pass
            self._send_json(200, {"success": True, "deleted": deleted, "filename": safe_name})
            return

        if path.startswith("/api/support-chat"):
            target_session = (qs.get("sessionId") or [""])[0].strip()
            if not target_session and path.startswith("/api/support-chat/"):
                target_session = urllib.parse.unquote(path[len("/api/support-chat/"):].strip("/"))
            if not target_session:
                self._send_json(400, {"success": False, "error": "sessionId is required"})
                return
            with DB_LOCK:
                threads = read_support_chats()
                filtered = [t for t in threads if str(t.get("sessionId")) != target_session]
                saved_threads = write_support_chats(filtered)
                rev = bump_portal_revision()
            self._send_json(200, {"success": True, "deletedSessionId": target_session, "threads": saved_threads, "revision": rev})
            return

        self._send_json(404, {"error": "DELETE endpoint not found", "path": path})


def run():
    if len(sys.argv) > 1:
        port = int(sys.argv[1])
    else:
        port = int(os.environ.get("PI_PORT") or os.environ.get("PORT") or "8000")
    lan_ip = get_lan_ip()
    print("=" * 68)
    print("  T.U.G.O.N. RASPBERRY PI 4B CLOUD STORAGE SERVER (Brgy 40 & 41)")
    print(f"  Storage Folder : {STORAGE_DIR}")
    print("  Subfolders     : saved_logbooks, photos, purged_archives")
    print(f"  Local LAN URL  : http://{lan_ip}:{port}")
    print("  Zero-Dependency: Python 3 Standard Library (ThreadingHTTPServer)")
    print("=" * 68)
    server = ReusableThreadingHTTPServer(("0.0.0.0", port), PulseHttpHandler)
    print(f"  Listening on http://0.0.0.0:{port} ...")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped cleanly.")


if __name__ == "__main__":
    run()
