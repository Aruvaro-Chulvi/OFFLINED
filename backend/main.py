from fastapi import FastAPI, Query, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse, FileResponse
from llama_cpp import Llama
import json, os, re, math, locale, unicodedata
import subprocess
import requests
import psutil
from typing import Dict, Any, Optional, List, Tuple
import httpx
from pathlib import Path
from urllib.parse import quote
import mimetypes

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)

# ===== DETECCIÓN DE IDIOMA =====
def detect_language():
    try:
        lang, _ = locale.getdefaultlocale()
    except Exception:
        lang = "en"
    if not lang:
        return "en"
    lang = lang.lower()
    if lang.startswith("es"): return "es"
    elif lang.startswith("fr"): return "fr"
    return "en"

LANG_CODE = detect_language()
LANG_MAP = {
    "es": {"flag": "🇪🇸", "label": "Español"},
    "en": {"flag": "🇬🇧", "label": "English"},
    "fr": {"flag": "🇫🇷", "label": "Français"},
}
LANG_INFO = LANG_MAP.get(LANG_CODE, LANG_MAP["en"])

def lang_info_from(code: Optional[str]):
    code = (code or "").lower()
    return LANG_MAP.get(code, LANG_MAP.get(LANG_CODE, LANG_MAP["en"]))

# ===== MODELOS =====
ALLOWED_MODELS = ["phi-4-mini-instruct-q4_k_m.gguf"]
CHAT_FORMAT_MAP = {}
DEFAULT_MODEL = ALLOWED_MODELS[0]
CTX_TOKENS, REPLY_TOKENS = 4096, 512
SEED = 42
GEN_KW = dict(max_tokens=REPLY_TOKENS, temperature=0.2, top_p=0.9, repeat_penalty=1.1)
STOP_SEQS = ["<|end|>", "</s>"]

# ===== Sesiones =====
Session = Dict[str, Any]
sessions: Dict[str, Session] = {}

def agent_key_of(agent: Optional[dict]) -> str:
    """Clave de sesión estable por NOMBRE de agente (cambiar agente => cambia hilo)."""
    if not agent:
        return "default"
    return (agent.get("name") or "default").strip() or "default"

def get_session(agent: Optional[dict]) -> Session:
    k = agent_key_of(agent)
    if k not in sessions:
        sessions[k] = {"history": []}
    return sessions[k]

# ===== Modelo activo =====
MODEL_FILE = "phi-4-mini-instruct-q4_k_m.gguf"
BASE_DIR = Path(__file__).resolve().parent        # .../backend
MODEL_PATH = str((BASE_DIR.parent / "models" / MODEL_FILE).resolve())

def resolve_chat_format(filename: str):
    # Por defecto None → llama.cpp usa el chat_template del GGUF
    return CHAT_FORMAT_MAP.get(filename)

def load_llm(path: str, filename: str):
    chat_format = resolve_chat_format(filename)
    n_threads = int(os.getenv("LLAMA_THREADS", max(2, (os.cpu_count() or 8) - 1)))
    kwargs = dict(model_path=path, n_ctx=CTX_TOKENS, n_threads=n_threads, seed=SEED)
    if chat_format:
        kwargs["chat_format"] = chat_format
    return Llama(**kwargs)

llm = load_llm(MODEL_PATH, MODEL_FILE)

# ===== Utilidades de idioma/agentes =====
def pick_lang(value, lang_code: Optional[str]) -> str:
    """Devuelve el string en el idioma adecuado (acepta str o dict por idiomas)."""
    if not value:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        t = (lang_code or LANG_CODE)
        return value.get(t) or value.get(t[:2]) or value.get("en") or next(iter(value.values()), "")
    return str(value)

AGENTS_FILE = str((BASE_DIR.parent / "agents.json").resolve())

def load_agents_directory(lang_code: Optional[str]) -> List[dict]:
    """
    Carga un directorio compacto de agentes (name/category/profession).
    Se usa para que el agente pueda 'derivar' (referral) a otro experto.
    """
    try:
        with open(AGENTS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return []
    out = []
    for name, meta in data.items():
        out.append({
            "name": pick_lang(name, lang_code),
            "category": meta.get("category", ""),
            "profession": pick_lang(meta.get("profession", ""), lang_code),
        })
    return out

# ===== Helpers limpieza / Markdown =====
def strip_meta_tokens(text: str) -> str:
    if not text: return ""
    return (
        text.replace("<|im_start|>","")
            .replace("<|im_end|>","")
            .replace("[INST]","")
            .replace("[/INST]","")
    )

def remove_disclaimers(text: str) -> str:
    s = text or ""
    s = re.sub(r"[ \t]{2,}", " ", s)
    s = re.sub(r"[ \t]*\n[ \t]*", "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()

def promote_headings(s: str) -> str:
    if not s:
        return s
    lines = s.splitlines()
    out, count = [], 0
    blacklist = {"nota", "importante", "aviso", "observación", "observacion"}
    rx = re.compile(r'^\s*(?![-*]\s)(?!\d{1,2}\.\s)([^\n:]{3,80}):\s*$')
    for line in lines:
        m = rx.match(line)
        if m and count < 3:
            text = m.group(1).strip()
            if text.lower() not in blacklist:
                level = "###" if count == 0 else "####"
                out.append(f"{level} {text}")
                count += 1
                continue
        out.append(line)
    return "\n".join(out)

def enforce_markdown_lists(s: str) -> str:
    if not s:
        return ""
    s = re.sub(r"(?<!\d)(\d{1,2})\)\s*", r"\1. ", s)
    s = re.sub(r"(?<!\d)(\d{1,2})\.\-\s*", r"\1. ", s)
    s = re.sub(r"([^\n])\s*((?<!\d)(\d{1,2}))\.\s+", r"\1\n\2. ", s)
    s = re.sub(r"(?m)(^(\s*\d{1,2})\.\s[^\n]+?)\s+(?=\d{1,2}\.\s)", r"\1\n", s)
    s = re.sub(r"(?m)^(?P<li>\s*\d{1,2}\.\s.*)\n{2,}(?=\s*\d{1,2}\.\s)", r"\g<li>\n", s)
    s = re.sub(
        r"(?m)^(?!(?:\s*(?:\d{1,2}\.\s|[-*]\s)|#{1,6}\s))([^\n].*?)\n(?=\s*\d{1,2}\.\s)",
        r"\1\n\n",
        s,
    )
    s = re.sub(
        r"(?m)^(\s*(?:\d{1,2}\.\s|[-*]\s).+?[.!?])\s+(?=[A-ZÁÉÍÓÚÑ])",
        r"\1\n\n",
        s,
    )
    s = re.sub(
        r"(?m)(^((?:\s*\d{1,2}\.\s|[-*]\s).*(?:\n|$))+)(?=^(?!\s*(?:\d{1,2}\.\s|[-*]\s))\S)",
        r"\1\n",
        s,
    )
    s = re.sub(r"[ \t]+\n", "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    s = re.sub(r"(?m)^(#{3,4}\s.+)\n{2,}", r"\1\n", s)
    return s

# Binomiales solo en listas
_BINOMIAL_RE = re.compile(r"\b([A-Z][a-z]{2,})\s([a-z]{3,})\b")
_LIST_LINE_RE = re.compile(r'^\s*(?:[-*]|\d{1,2}\.)\s', re.M)

def italicize_binomials(s: str) -> str:
    if not s:
        return s
    lines = s.splitlines()
    for i, line in enumerate(lines):
        if _LIST_LINE_RE.match(line):
            lines[i] = _BINOMIAL_RE.sub(r"*\1 \2*", line)
    return "\n".join(lines)

def strip_model_emphasis(s: str) -> str:
    if not s:
        return ""
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s, flags=re.DOTALL)
    s = re.sub(r"(?m)\*(?!\s)([^*\n]+?)\*(?!\s)", r"\1", s)
    s = re.sub(r"_(.+?)_", r"\1", s, flags=re.DOTALL)
    return s

def bold_quoted_phrases(s: str) -> str:
    if not s:
        return s
    def wrap_quotes(pattern, text, open_q='"', close_q='"'):
        def repl(m):
            inner = m.group(1).strip()
            if 2 <= len(inner) <= 60 and "\n" not in inner:
                return f"{open_q}**{inner}**{close_q}"
            return m.group(0)
        return re.sub(pattern, repl, text)
    s = wrap_quotes(r'"([^"\n]{2,})"', s, '"', '"')
    s = wrap_quotes(r'“([^”\n]{2,})”', s, '“', '”')
    s = wrap_quotes(r'«([^»\n]{2,})»', s, '«', '»')
    return s

def _norm(s: str) -> str:
    """Normaliza para matching: minúsculas, acento-insensible."""
    if not s:
        return ""
    s = s.lower()
    s = unicodedata.normalize("NFD", s)
    return "".join(ch for ch in s if not unicodedata.combining(ch))

def selfify_current_agent_mentions(text: str, agent_name: Optional[str], lang_code: Optional[str]) -> str:
    """
    Si el agente actual se menciona en tercera persona, reescribe a primera persona.
    """
    if not text or not agent_name:
        return text
    name = agent_name.strip()
    if not re.search(rf"(?<!\w){re.escape(name)}(?!\w)", text):
        return text

    code = (lang_code or "en")[:2].lower()
    s = text

    if code == "es":
        s = re.sub(rf"\b{re.escape(name)}\s+es\b", "Soy", s, flags=re.I)
        s = re.sub(rf"\b{re.escape(name)}\s+puede\b", "Puedo", s, flags=re.I)
        s = re.sub(r"\bponerte en contacto con (ella|él)\b", "ponerte en contacto conmigo", s, flags=re.I)
        s = re.sub(r"\bcontactar con (ella|él)\b", "contactar conmigo", s, flags=re.I)
        s = re.sub(r"\bhablar con (ella|él)\b", "hablar conmigo", s, flags=re.I)
        s = re.sub(rf"\bte recomiendo\b(?:[^.\n]{{0,60}})?\b{re.escape(name)}\b", "Te puedo ayudar yo misma", s, flags=re.I)
    elif code == "en":
        s = re.sub(rf"\b{re.escape(name)}\s+is\b", "I am", s, flags=re.I)
        s = re.sub(rf"\b{re.escape(name)}\s+can\b", "I can", s, flags=re.I)
        s = re.sub(r"\bcontact (her|him)\b", "contact me", s, flags=re.I)
        s = re.sub(r"\btalk to (her|him)\b", "talk to me", s, flags=re.I)
        s = re.sub(r"\breach out to (her|him)\b", "reach out to me", s, flags=re.I)
        s = re.sub(rf"\bI recommend\b(?:[^.\n]{{0,60}})?\b{re.escape(name)}\b", "I can help you directly", s, flags=re.I)
    elif code == "fr":
        s = re.sub(rf"\b{re.escape(name)}\s+est\b", "Je suis", s, flags=re.I)
        s = re.sub(rf"\b{re.escape(name)}\s+peut\b", "Je peux", s, flags=re.I)
        s = re.sub(r"\bcontacter (elle|lui)\b", "me contacter", s, flags=re.I)
        s = re.sub(r"\bparler avec (elle|lui)\b", "parler avec moi", s, flags=re.I)
        s = re.sub(r"\bprendre contact avec (elle|lui)\b", "prendre contact avec moi", s, flags=re.I)
        s = re.sub(rf"\bje recommande\b(?:[^.\n]{{0,60}})?\b{re.escape(name)}\b", "je peux vous aider directement", s, flags=re.I)

    s = re.sub(rf"^\s*{re.escape(name)}\s*,\s*(soy|je suis|i am)\b", r"\1", s, flags=re.I)
    return s

def clean_answer(text: str) -> str:
    s = text or ""
    s = strip_model_emphasis(s)
    s = strip_meta_tokens(text or "").strip()
    allow_rich = os.getenv("ALLOW_RICH_MD", "1")
    if allow_rich == "0":
        s = strip_model_emphasis(s)
    s = promote_headings(s)
    s = enforce_markdown_lists(s)
    s = italicize_binomials(s)
    s = bold_quoted_phrases(s)
    s = remove_disclaimers(s)
    return s or "…Sorry, rephrase?"

def _load_agents_full_map(lang_code: Optional[str]) -> Dict[str, dict]:
    """Mapa: nombre -> {name, category, profession, avatar} (localizado)."""
    try:
        with open(AGENTS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return {}
    out = {}
    for name, meta in data.items():
        out[name] = {
            "name": name,
            "category": meta.get("category", ""),
            "profession": pick_lang(meta.get("profession", ""), lang_code),
            "avatar": meta.get("avatar", ""),
        }
    return out

# ====== REFERRALS / MENCIÓN DE AGENTES ======
def _keyword_patterns(kw: str) -> List[re.Pattern]:
    """Variaciones morfológicas básicas (acento-insensible)."""
    k = _norm(kw).strip()
    if len(k) < 3:
        return []
    pats = [re.compile(rf"\b{re.escape(k)}\w{{0,8}}\b")]
    if len(k) >= 8:
        stem6 = re.escape(k[:6])
        pats.append(re.compile(rf"\b{stem6}\w{{0,10}}\b"))
    if k.endswith("izacion"):
        stem = re.escape(k[:-7] + "iza")
        pats.append(re.compile(rf"\b{stem}\w{{0,8}}\b"))
    if k.endswith("isation"):
        stem = re.escape(k[:-8] + "is")
        pats.append(re.compile(rf"\b{stem}\w{{0,8}}\b"))
    return pats

_REF_BLOCK_RE = re.compile(r"<referrals>\s*(.*?)\s*</referrals>", re.I | re.S)

def _extract_referrals_block(text: str) -> Tuple[str, list]:
    """Extrae <referrals>…</referrals> → (texto_sin_bloque, [{name,reason}])."""
    m = _REF_BLOCK_RE.search(text or "")
    if not m:
        return text, []
    body = m.group(1)
    lines = [ln.strip() for ln in body.splitlines() if ln.strip()]
    refs = []
    for ln in lines:
        parts = ln.split(":", 1)
        if parts:
            name = parts[0].strip()
            reason = parts[1].strip() if len(parts) > 1 else ""
            if name:
                refs.append({"name": name, "reason": reason})
    new_text = _REF_BLOCK_RE.sub("", text).strip()
    return new_text, refs

# Triggers multi-idioma
TRIGGERS = {
    "es": [
        r"\bte recomiendo\b",
        r"\brecomiendo (?:hablar|consultar|contactar) con\b",
        r"\brecomendar(?:ía|ia)\b",
        r"\bhablar con\b", r"\bconsultar con\b", r"\bcontactar con\b",
        r"\bderiv(?:ar(?:te)?|aría|aria)\s+a\b",
        r"\baconsejo (?:hablar|consultar) con\b",
    ],
    "en": [
        r"\bi recommend\b",
        r"\b(?:i )?(?:would|’d|d)\s+recommend\b",
        r"\brecommend(?:ing)?\b",
        r"\btalk to\b", r"\bspeak with\b",
        r"\bconsult (?:with|a|an)\b",
        r"\breach out to\b", r"\bcontact\b",
        r"\bshould see\b",
        r"\brefer (you )?to\b",
    ],
    "fr": [
        r"\bje (?:te|vous) conseille\b",
        r"\bje (?:te|vous) recommande\b",
        r"\brecommande(?:r)?\b",
        r"\bparler avec\b", r"\bconsulter\b", r"\bcontacter\b",
        r"\bprendre contact avec\b",
        r"\b(?:aller|voir)\s+un(?:e)?\b",
        r"\br(?:é|e)orienter vers\b",
        r"\br(?:é|e)f(?:é|e)rer \b"
    ]
}

def _collect_keywords(meta: dict) -> List[str]:
    """Admite keywords como lista o dict {es|en|fr:[...]}. Junta y normaliza."""
    kws = meta.get("keywords", [])
    out = []
    if isinstance(kws, dict):
        for lang_list in kws.values():
            if isinstance(lang_list, list):
                out.extend([str(x) for x in lang_list])
    elif isinstance(kws, list):
        out = [str(x) for x in kws]
    normed, seen = [], set()
    for k in out:
        k2 = _norm(k)
        if len(k2) >= 3 and k2 not in seen:
            seen.add(k2); normed.append(k2)
    return normed

def _fallback_detect_referrals(text: str, agents_map: Dict[str, dict], lang_code: str|None = None, current_agent_name: Optional[str] = None) -> list:
    """Heurística sobre la RESPUESTA del modelo. Evita auto-recomendación."""
    if not text:
        return []
    code = (lang_code or "en").split("-")[0]
    pats = TRIGGERS.get(code, TRIGGERS["en"])
    hay_trigger = any(re.search(p, text, flags=re.I) for p in pats)

    try:
        data = json.load(open(AGENTS_FILE, "r", encoding="utf-8"))
    except Exception:
        data = {}
    tnorm = _norm(text)

    best_name, best_score = None, 0
    for name, meta in data.items():
        kws = _collect_keywords(meta)
        score = 0
        for k in kws:
            for pat in _keyword_patterns(k):
                score += len(re.findall(pat, tnorm))
        if score > best_score:
            best_name, best_score = name, score

    if not hay_trigger and best_score >= 2:
        hay_trigger = True
    if not hay_trigger:
        return []

    for name in agents_map.keys():
        if current_agent_name and name == current_agent_name:
            continue
        if re.search(rf"(?<!\w){re.escape(name)}(?!\w)", text):
            return [{"name": name, "reason": ""}]
    if best_name and (not current_agent_name or best_name != current_agent_name):
        return [{"name": best_name, "reason": ""}]
    return []

def _score_text_with_keywords(text: str, agent_name: str, meta: dict) -> int:
    """Score por mención literal + keywords (morfología/acentos)."""
    if not text or not meta:
        return 0
    tnorm = _norm(text)
    score = 0
    if re.search(rf"(?<!\w){re.escape(agent_name)}(?!\w)", text, flags=re.I):
        score += 5
    for k in _collect_keywords(meta):
        for pat in _keyword_patterns(k):
            score += len(re.findall(pat, tnorm))
    return score

def infer_referral_from_user_query(user_text: str, current_agent_name: Optional[str], lang_code: Optional[str]) -> list:
    """Detecta a quién derivar usando SOLO la PREGUNTA del usuario. Evita auto-recomendación."""
    try:
        data = json.load(open(AGENTS_FILE, "r", encoding="utf-8"))
    except Exception:
        return []

    tlow = (user_text or "").strip()
    if not tlow:
        return []

    current_score = 0
    current_cat = None
    if current_agent_name and current_agent_name in data:
        current_meta = data[current_agent_name]
        current_cat = (current_meta.get("category") or "").lower()
        current_score = _score_text_with_keywords(tlow, current_agent_name, current_meta)

    scored = []
    for name, meta in data.items():
        if name == current_agent_name:
            continue
        s = _score_text_with_keywords(tlow, name, meta)
        if s > 0:
            scored.append((s, name, meta))
    if not scored:
        return []
    scored.sort(reverse=True, key=lambda x: x[0])

    picked = []
    for s, name, meta in scored:
        cand_cat = (meta.get("category") or "").lower()
        if cand_cat and cand_cat != current_cat:
            th = 1  # distinto ámbito: umbral permisivo
        else:
            th = max(2, current_score + 1)
        if s >= th:
            picked.append((s, name, meta))
        if len(picked) >= 2:
            break

    if not picked:
        return []

    code = (lang_code or "en")[:2]
    reason_by_cat = {
  "es": {
    "medical":    "tema médico",
    "engineering":"tema de ingeniería",
    "food":       "tema de alimentación",
    "leadership": "tema de liderazgo",
    "security":   "tema de seguridad y defensa",
    "knowledge":  "tema de conocimiento y docencia",
    "community":  "tema de comunidad y cohesión",
    "carpentry":  "tema de carpintería y taller",
    "default":    "fuera de mi ámbito"
  },
  "en": {
    "medical":    "medical topic",
    "engineering":"engineering topic",
    "food":       "food topic",
    "leadership": "leadership topic",
    "security":   "security & defense topic",
    "knowledge":  "knowledge & teaching topic",
    "community":  "community & cohesion topic",
    "carpentry":  "carpentry & workshop crafts topic",
    "default":    "outside my scope"
  },
  "fr": {
    "medical":    "sujet médical",
    "engineering":"sujet d'ingénierie",
    "food":       "sujet alimentaire",
    "leadership": "sujet de leadership",
    "security":   "sujet de sécurité & défense",
    "knowledge":  "sujet de connaissance & enseignement",
    "community":  "sujet de communauté & cohésion",
    "carpentry":  "sujet de menuiserie & atelier",
    "default":    "hors de mon domaine"
  }
}



    out = []
    for _, name, meta in picked:
        cat = (meta.get("category") or "").lower()
        reason = reason_by_cat.get(code, reason_by_cat["en"]).get(cat, reason_by_cat.get(code, reason_by_cat["en"])["default"])
        out.append({"name": name, "reason": reason})
    return out

def _build_referral_cards(refs: list, agents_map: Dict[str, dict]) -> list:
    cards = []
    for r in refs:
        nm = r.get("name", "")
        info = agents_map.get(nm)
        if info:
            cards.append({
                "name": info["name"],
                "profession": info["profession"],
                "avatar": info["avatar"],
                "category": info["category"],
                "reason": r.get("reason", ""),
                "href": f"agent://{quote(info['name'])}"
            })
    return cards

def _merge_referral_cards(meta: dict, new_cards: list) -> dict:
    meta = dict(meta or {})
    existing = { (it.get("name") or "").lower(): it for it in meta.get("referrals", []) }
    for card in new_cards:
        k = (card.get("name") or "").lower()
        if k and k not in existing:
            existing[k] = card
    merged = list(existing.values())
    if merged:
        meta["referrals"] = merged
        meta["suppress_wiki_links"] = True
    return meta

def _linkify_agent_mentions(text: str, names: list) -> str:
    """Enlaza la PRIMERA aparición de cada nombre a `agent://...`."""
    if not text or not names:
        return text
    def link_once(s, name):
        pattern = re.compile(rf"(?<!\[)(?<!\()\b({re.escape(name)})\b(?!\])", re.U)
        return pattern.sub(f"[\\1](agent://{quote(name)})", s, count=1)
    out = text
    for nm in names:
        out = link_once(out, nm)
    return out

def _find_mentioned_agents(text: str, agents_map: Dict[str, dict]) -> list:
    """Devuelve [{name, reason:''}, ...] si el nombre está en el texto."""
    mentions, used = [], set()
    for name in agents_map.keys():
        for _ in re.finditer(rf"(?<!\w){re.escape(name)}(?!\w)", text):
            k = name.lower()
            if k not in used:
                used.add(k)
                mentions.append({"name": name, "reason": ""})
            break
    return mentions

# ---- Small talk / respuestas cortas (¡ESTE BLOQUE FALTABA!)
SMALLTALK_PATTERNS = {
    "es": r"^\s*(hola|buenas|buenos días|buenas tardes|buenas noches|¿?qué tal|¿?cómo estás)\b",
    "en": r"^\s*(hi|hello|hey|good (morning|afternoon|evening)|how(?:’|')?s it going|how are you)\b",
    "fr": r"^\s*(salut|bonjour|bonsoir|ça va|comment ça va)\b",
}

def is_smalltalk(user_text: str, lang: str|None) -> bool:
    if not user_text: return False
    code = (lang or "en").split("-")[0]
    pat = SMALLTALK_PATTERNS.get(code, SMALLTALK_PATTERNS["en"])
    if re.search(pat, user_text, flags=re.I):
        return True
    return len(user_text.strip()) < 6

def looks_like_small_answer(ans: str) -> bool:
    """Evita referrals heurísticos si la respuesta es muy corta.
       (Las MENCIONES por nombre se aplican aparte)."""
    if not ans: return True
    s = re.sub(r"\s+", " ", ans).strip()
    return len(s) < 120 or s.count(".") + s.count("!") + s.count("?") <= 2
# ---- fin bloque faltante

def augment_with_referrals(answer_md: str, lang_code: Optional[str], current_agent_name: Optional[str] = None) -> Tuple[str, dict]:
    """Extrae bloque, aplica heurística y filtra self-referrals."""
    agents_map = _load_agents_full_map(lang_code)
    stripped, refs = _extract_referrals_block(answer_md)
    if current_agent_name:
        refs = [r for r in refs if (r.get("name") or "") != current_agent_name]
    if not refs:
        refs = _fallback_detect_referrals(stripped, agents_map, lang_code, current_agent_name)
    meta, shown = {}, stripped
    if refs:
        cards = _build_referral_cards(refs, agents_map)
        if cards:
            meta["referrals"] = cards
            meta["suppress_wiki_links"] = True
            shown = _linkify_agent_mentions(shown, [c["name"] for c in cards])
    return shown, meta

def enforce_mentions_linkcards(text: str, meta: dict, lang_code: Optional[str], current_agent_name: Optional[str]) -> Tuple[str, dict]:
    """
    Pase FINAL:
    - Crea tarjetas y links para NOMBRES mencionados (salvo el propio).
    - Si solo se menciona al propio agente, solo suprime wiki links.
    """
    agents_map = _load_agents_full_map(lang_code)
    all_mentions = _find_mentioned_agents(text, agents_map)
    mentions = [m for m in all_mentions if (m.get("name") or "") != (current_agent_name or "")]
    if not mentions:
        if all_mentions:
            meta = dict(meta or {}); meta["suppress_wiki_links"] = True
        return text, meta or {}
    meta = dict(meta or {})
    existing = { (it.get("name") or "").lower(): it for it in meta.get("referrals", []) }
    new_cards = _build_referral_cards(mentions, agents_map)
    merged = list(existing.values())
    for card in new_cards:
        k = (card.get("name") or "").lower()
        if k and k not in existing:
            merged.append(card); existing[k] = card
    if merged:
        meta["referrals"] = merged
        meta["suppress_wiki_links"] = True
        text = _linkify_agent_mentions(text, [c["name"] for c in merged])
    return text, meta

# ===== Prompting de alto nivel =====
def base_rules(lang_code: Optional[str] = None) -> str:
    """
    Devuelve reglas base en el idioma solicitado.
    Soporta: en, es, fr. Fallback: en.
    """
    code = (lang_code or LANG_CODE or "en").split("-")[0].lower()
    if code not in ("en", "es", "fr"):
        code = "en"

    texts = {
        "en": (
            "- Reply only in English. Be neutral and practical.\n"
            "- Output valid Markdown. Avoid excessive headings.\n"
        ),
        "es": (
            "- Responde solo en español. Sé neutral y práctico.\n"
            "- Genera Markdown válido. Evita los encabezados excesivos.\n"
        ),
        "fr": (
            "- Réponds uniquement en français. Reste neutre et pratique.\n"
            "- Produis un Markdown valide. Évite les titres excessifs.\n"
        ),
    }

    return texts[code]

def agent_prompt_block(agent, lang_code: Optional[str]):
    if not agent:
        return ""

    name          = (agent.get("name") or "").strip()
    instructions  = (agent.get("instructions") or "").strip()  # <- usamos 'instructions'
    category      = (agent.get("category") or "").strip()
    personality   = (agent.get("personality") or "").strip()
    profession    = (agent.get("profession") or "").strip()

    code = (lang_code or LANG_CODE or "en").split("-")[0].lower()
    if code not in ("en", "es", "fr"):
        code = "en"

    texts = {
        "en": (
            f"- Your name is {name} and you are {profession}.\n"
            f"- {instructions}\n"
            f"- Use a {personality} way of expressing yourself\n"
            "- Always speak in the first person (I). Do not refer to yourself by your own name.\n"
            "- Never recommend contacting yourself; if the user asks for you, just help directly.\n"
            f"- If the request is clearly outside the “{category}” domain, append EXACTLY at the very end:\n"
            "  <referrals>\n"
            "  Agent Name: short reason\n"
            "  </referrals>\n"
        ),
        "es": (
            f"- Te llamas {name} y eres {profession}.\n"
            f"- {instructions}\n"
            f"- Usa una forma de expresarte {personality}\n"
            "- Habla siempre en primera persona (yo) y no te refieras a ti por tu propio nombre.\n"
            "- Nunca te recomiendes a ti mismo/a; si el usuario te solicita, ayuda directamente.\n"
            f"- Si la petición está claramente fuera del ámbito “{category}”, añade EXACTAMENTE al final:\n"
            "  <referrals>\n"
            "  Agent Name: motivo breve\n"
            "  </referrals>\n"
        ),
        "fr": (
            f"- Tu t'appelles {name} et tu es {profession}.\n"
            f"- {instructions}\n"
            f"- Utilise une façon de t'exprimer {personality}\n"
            "- Parle toujours à la première personne (je) et ne te nomme pas par ton propre nom.\n"
            "- Ne te recommande jamais toi-même ; si l’utilisateur te sollicite, aide directement.\n"
            f"- Si la demande est clairement hors du domaine « {category} », ajoute EXACTEMENT à la fin :\n"
            "  <referrals>\n"
            "  Agent Name: raison courte\n"
            "  </referrals>\n"
        ),
    }

    return texts[code]

def agent_directory_block(lang_code: Optional[str]) -> str:
    directory = load_agents_directory(lang_code)
    if not directory:
        return ""

    code = (lang_code or LANG_CODE or "en").split("-")[0].lower()
    if code not in ("en", "es", "fr"):
        code = "en"

    headings = {
        "en": {
            "title": "### Referral Directory (compact)\n",
            "rules": (
                "Only recommend another expert when the user's question is clearly outside your scope.\n"
                "- No suggest referrals on greetings or small talk.\n"
                "- At most TWO referral and keep the reason short.\n"
            ),
        },
        "es": {
            "title": "### Directorio de derivaciones (compacto)\n",
            "rules": (
                "Recomienda a otro experto solo cuando la pregunta del usuario esté claramente fuera de tu ámbito.\n"
                "- No sugieras referencias en saludos o small talk.\n"
                "- Como máximo DOS referencias y con motivo breve.\n"
            ),
        },
        "fr": {
            "title": "### Répertoire d’orientation (compact)\n",
            "rules": (
                "Recommande un autre expert uniquement lorsque la question de l’utilisateur est clairement hors de ton périmètre.\n"
                "- NE propose d’orientation lors de salutations ou de small talk.\n"
                "- Au maximum DUE orientation avec une raison courte.\n"
            ),
        },
    }

    lines = []
    for a in directory:
        nm = a.get("name", "").strip()
        cat = a.get("category", "").strip()
        prof = a.get("profession", "").strip()
        if nm:
            lines.append(f"- {nm} · {cat} · {prof}")

    if not lines:
        return ""

    txt = headings[code]["title"] + headings[code]["rules"] + "\n".join(lines) + "\n"
    return txt

def system_prompt(agent=None, lang_code: Optional[str] = None) -> str:
    core = "You are Survival AI.\nRules:\n" + base_rules(lang_code)
    agent_block = agent_prompt_block(agent, lang_code) if agent else ""
    directory_block = agent_directory_block(lang_code) if agent else ""
    return core + ("\n" + agent_block if agent_block else "") + ("\n" + directory_block if directory_block else "")

def build_messages(user_text: str, agent=None, lang_code: Optional[str] = None):
    ses = get_session(agent)
    msgs = ses["history"] + [{"role":"user","content": user_text}]
    msgs.insert(0, {"role":"system","content": system_prompt(agent, lang_code)})
    return msgs

# ===== STATUS / CATEGORÍAS / AGENTES =====
@app.get("/api/status")
def status():
    cf = resolve_chat_format(MODEL_FILE) or "auto"
    return {
        "model_file": MODEL_FILE,
        "chat_format": cf,
        "lang": LANG_CODE,
        "lang_label": LANG_INFO["label"],
        "lang_flag": LANG_INFO["flag"],
    }

@app.get("/api/categories")
def get_categories(lang: str = None):
    code = (lang or LANG_CODE)[:2].lower()
    base_path = os.path.dirname(os.path.dirname(__file__))
    cats_path = os.path.join(base_path, "categories.json")
    with open(cats_path, "r", encoding="utf-8") as f:
        cats = json.load(f)
    out = []
    for key, meta in cats.items():
        labels = meta.get("labels", {})
        out.append({
            "key": key,
            "emoji": meta.get("emoji", "⭐"),
            "label": labels.get(code) or labels.get("en") or key
        })
    return out

@app.get("/api/agents")
def get_agents(lang: Optional[str] = Query(default=None)):
    base_path = os.path.dirname(os.path.dirname(__file__))
    agents_path = os.path.join(base_path, "agents.json")
    with open(agents_path, "r", encoding="utf-8") as f:
        agents = json.load(f)

    target = (lang or LANG_CODE)
    out = []
    for name, data in agents.items():
        def pick(field):
            val = data.get(field, "")
            if isinstance(val, dict):
                return val.get(target) or val.get("en") or next(iter(val.values()), "")
            return val
        out.append({
            "name": name,
            "category": data.get("category", ""),
            "profession": pick("profession"),
            "instructions": pick("instructions"),
            "personality": pick("personality"),
            "avatar": data.get("avatar",""),
            "greeting": data.get("greeting",""),
            "greetings": data.get("greetings", {}),
            "bio": pick("bio"),
        })
    return out

# ===== KIWIX / WIKIPEDIA OFFLINE =====
KIWIX_ADDR = os.getenv("KIWIX_ADDR", "127.0.0.1")
KIWIX_PORT = int(os.getenv("KIWIX_PORT", "8080"))

ZIM_CANDIDATES = {
    "en": [
        "wikipedia_en_all_maxi_2025-08.zim",
        "wikipedia_en_all_nopic_2025-08.zim",
        "wikipedia_en_all_mini_2025-06.zim",
    ],
    "es": [
        "wikipedia_es_all_maxi_2025-07.zim",
        "wikipedia_es_all_nopic_2025-08.zim",
        "wikipedia_es_all_mini_2025-08.zim",
    ],
    "fr": [
        "wikipedia_fr_all_maxi_2025-06.zim",
        "wikipedia_fr_all_nopic_2025-08.zim",
        "wikipedia_fr_all_mini_2025-08.zim",
    ],
}

def _zim_variant_from_name(fname: str) -> str:
    if "_maxi_" in fname: return "maxi"
    if "_nopic_" in fname: return "nopic"
    if "_mini_" in fname: return "mini"
    return "unknown"

def _kiwix_dirs():
    base_path = os.path.dirname(os.path.dirname(__file__))
    kiwix_dir = os.path.join(base_path, "kiwix")
    content_dir = os.path.join(kiwix_dir, "content")
    serve_exe = os.path.join(kiwix_dir, "kiwix-serve.exe")
    return kiwix_dir, content_dir, serve_exe

def _find_first_existing_zim(lang: Optional[str]) -> tuple[str|None, str|None, str|None]:
    code = (lang or LANG_CODE)[:2].lower()
    _, content_dir, _ = _kiwix_dirs()
    candidates = ZIM_CANDIDATES.get(code, ZIM_CANDIDATES.get("en", []))
    for fname in candidates:
        p = os.path.join(content_dir, fname)
        if os.path.exists(p):
            return p, fname, _zim_variant_from_name(fname)
    return None, None, None

@app.get("/api/wiki")
def open_wiki(lang: Optional[str] = Query(default=None)):
    zim_path, zim_file, variant = _find_first_existing_zim(lang)
    code = (lang or LANG_CODE)[:2].lower()

    if not zim_path:
        expected = ZIM_CANDIDATES.get(code, [])
        return {
            "status": "missing",
            "message": f"No ZIM found for '{code}'. Place one of these files into /kiwix/content/ (in this priority order):",
            "candidates": expected,
            "howto": "Download your preferred ZIM (maxi/nopic/mini) and copy it to kiwix/content. Then call /api/wiki again."
        }

    kiwix_dir, content_dir, serve_exe = _kiwix_dirs()
    if not os.path.exists(serve_exe):
        return {
            "status": "error",
            "message": f"kiwix-serve.exe not found at {serve_exe}. Include it in the project (offline installer/USB)."
        }

    # Cerrar instancias previas de kiwix-serve
    for p in psutil.process_iter(attrs=["name","cmdline"]):
        try:
            if "kiwix-serve" in (p.info["name"] or "").lower():
                p.kill()
        except Exception:
            pass

    import socket, time, subprocess as _sp
    _sp.Popen([serve_exe, zim_path, "--port", str(KIWIX_PORT), "--address", KIWIX_ADDR])

    for _ in range(60):
        try:
            with socket.create_connection((KIWIX_ADDR, KIWIX_PORT), timeout=0.25):
                break
        except Exception:
            time.sleep(0.25)

    return {
        "status": "ok",
        "message": f"Kiwix running for {zim_file} ({variant}) on http://{KIWIX_ADDR}:{KIWIX_PORT}",
        "zim_file": zim_file,
        "variant": variant,
        "lang": code
    }

@app.get("/api/wiki/candidates")
def wiki_candidates(lang: Optional[str] = Query(default=None)):
    code = (lang or LANG_CODE)[:2].lower()
    _, content_dir, _ = _kiwix_dirs()
    out = []
    for fname in ZIM_CANDIDATES.get(code, []):
        p = os.path.join(content_dir, fname)
        exists = os.path.exists(p)
        size = os.path.getsize(p) if exists else 0
        out.append({
            "file": fname,
            "variant": _zim_variant_from_name(fname),
            "exists": exists,
            "size_bytes": size
        })
    return {"lang": code, "candidates": out}

# ===== PROXY HACIA KIWIX =====
@app.api_route("/proxy/wiki/{path:path}", methods=["GET","POST"])
async def proxy_wiki(path: str, request: Request):
    url = f"http://{KIWIX_ADDR}:{KIWIX_PORT}/{path}"
    async with httpx.AsyncClient(follow_redirects=True) as client:
        if request.method=="POST":
            body = await request.body()
            r = await client.post(url, content=body,
                                  headers={k:v for k,v in request.headers.items() if k.lower()!="host"},
                                  params=dict(request.query_params))
        else:
            r = await client.get(url,
                                 headers={k:v for k,v in request.headers.items() if k.lower()!="host"},
                                 params=dict(request.query_params))
    excluded_headers = ["content-encoding","transfer-encoding","connection","content-length",
                        "x-frame-options","content-security-policy"]
    headers = {k:v for k,v in r.headers.items() if k.lower() not in excluded_headers}
    return StreamingResponse(r.aiter_bytes(), status_code=r.status_code, headers=headers)

# ===== STATIC PMTILES (byte-serving con Range) =====
from fastapi import Request, HTTPException
from fastapi.responses import Response, StreamingResponse, FileResponse
from pathlib import Path
import re

# /frontend/assets/maps
MAPS_DIR = (BASE_DIR.parent / "frontend" / "assets" / "maps").resolve()

def _safe_join_maps(subpath: str) -> Path:
    p = (MAPS_DIR / subpath).resolve()
    if not str(p).startswith(str(MAPS_DIR)):
        raise HTTPException(status_code=404, detail="Not found")
    return p

@app.head("/assets/maps/{subpath:path}")
def head_pmtiles(subpath: str):
    f = _safe_join_maps(subpath)
    if not f.exists() or not f.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    size = f.stat().st_size
    return Response(
        status_code=200,
        headers={
            "Content-Type": "application/octet-stream",
            "Content-Length": str(size),
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    )

def _parse_range(range_header: str, file_size: int) -> tuple[int,int] | None:
    m = re.match(r"bytes=(\d*)-(\d*)", (range_header or "").strip())
    if not m:
        return None
    start_s, end_s = m.groups()
    if start_s == "" and end_s == "":
        return None
    if start_s == "":
        length = int(end_s or "0")
        if length <= 0:
            return None
        start = max(file_size - length, 0)
        end = file_size - 1
    else:
        start = int(start_s)
        end = int(end_s) if end_s else file_size - 1
        if start >= file_size:
            return None
        end = min(end, file_size - 1)
    if start > end or start < 0:
        return None
    return (start, end)

@app.get("/assets/maps/{subpath:path}")
def get_pmtiles(subpath: str, request: Request):
    f = _safe_join_maps(subpath)
    if not f.exists() or not f.is_file():
        raise HTTPException(status_code=404, detail="Not found")

    size = f.stat().st_size
    rng = _parse_range(request.headers.get("range"), size)

    if rng:
        start, end = rng
        length = end - start + 1

        def _iter():
            with open(f, "rb") as fp:
                fp.seek(start)
                remaining = length
                chunk = 64 * 1024
                while remaining > 0:
                    data = fp.read(min(chunk, remaining))
                    if not data:
                        break
                    remaining -= len(data)
                    yield data

        headers = {
            "Content-Type": "application/octet-stream",
            "Content-Range": f"bytes {start}-{end}/{size}",
            "Content-Length": str(length),
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=31536000, immutable",
        }
        return StreamingResponse(_iter(), status_code=206, headers=headers)

    # Sin Range → 200 con Content-Length y Accept-Ranges (y 'inline' para evitar descargas al abrir la URL)
    resp = FileResponse(
        f,
        media_type="application/octet-stream",
        filename=f.name,
    )
    resp.headers["Accept-Ranges"] = "bytes"
    resp.headers["Content-Disposition"] = f'inline; filename="{f.name}"'
    resp.headers.setdefault("Cache-Control", "public, max-age=31536000, immutable")
    return resp



# ===== 📚 LIBRERÍA (docs/) =====
DOCS_ROOT = (BASE_DIR.parent / "docs").resolve()

def _lib_safe_path(rel_path: Optional[str]) -> Path:
    """Normaliza y asegura que la ruta quede dentro de DOCS_ROOT."""
    rel = (rel_path or "").strip().lstrip("/\\")
    candidate = (DOCS_ROOT / rel).resolve()
    if not str(candidate).startswith(str(DOCS_ROOT)):
        raise HTTPException(status_code=400, detail="Invalid path")
    return candidate

@app.get("/api/library/list")
def library_list(path: Optional[str] = Query(default="")):
    """
    Lista directorios y archivos a partir de /docs (raíz del proyecto).
    Respuesta:
      { path, parent, dirs:[{name,path}], files:[{name,path,size,mime,ext}] }
    """
    base = _lib_safe_path(path)
    if not base.exists():
        raise HTTPException(status_code=404, detail="Path not found")

    def _normpath(p: Path) -> str:
        return str(p).replace("\\", "/")

    if base.is_file():
        mime, _ = mimetypes.guess_type(str(base))
        return {
            "path": path or "",
            "parent": _normpath(Path(path or ".").parent),
            "dirs": [],
            "files": [{
                "name": base.name,
                "path": (path or base.name).replace("\\", "/"),
                "size": base.stat().st_size,
                "mime": mime or "application/octet-stream",
                "ext": base.suffix.lower()
            }]
        }

    dirs, files = [], []
    for entry in sorted(base.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
        if entry.name.startswith("."):
            continue
        if entry.is_dir():
            dirs.append({
                "name": entry.name,
                "path": _normpath(Path(path or "") / entry.name)
            })
        elif entry.is_file():
            mime, _ = mimetypes.guess_type(str(entry))
            files.append({
                "name": entry.name,
                "path": _normpath(Path(path or "") / entry.name),
                "size": entry.stat().st_size,
                "mime": mime or "application/octet-stream",
                "ext": entry.suffix.lower()
            })

    parent = _normpath(Path(path or ".").parent)
    return { "path": path or "", "parent": parent, "dirs": dirs, "files": files }

@app.get("/api/library/file")
def library_file(path: str = Query(...), download: bool = Query(False)):
    """
    Sirve un archivo de /docs. Si ?download=1 → fuerza descarga (attachment).
    """
    file_path = _lib_safe_path(path)
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    mime, _ = mimetypes.guess_type(str(file_path))
    resp = FileResponse(
        path=str(file_path),
        media_type=mime or "application/octet-stream",
        filename=file_path.name
    )
    if download:
        resp.headers["Content-Disposition"] = f'attachment; filename="{file_path.name}"'
    else:
        resp.headers["Content-Disposition"] = f'inline; filename="{file_path.name}"'
    return resp

# ===== CHAT =====
@app.post("/api/chat")
def chat(payload: dict):
    user_msg = str(payload.get("message","")).strip()
    if not user_msg:
        return {"response":"Tell me something."}

    lang = payload.get("lang")
    agent = payload.get("agent")

    msgs = build_messages(user_text=user_msg, agent=agent, lang_code=lang)
    out = llm.create_chat_completion(messages=msgs, **GEN_KW, stop=STOP_SEQS)
    raw = out["choices"][0]["message"]["content"]

    # Limpieza / Markdown
    answer_md = clean_answer(raw)

    # 1) Quitar bloque <referrals> y capturar refs si las hubiera
    base_no_block, refs = _extract_referrals_block(answer_md)

    # 1.1) Nombre del agente actual (si lo hay)
    current_agent_name = None
    if isinstance(agent, dict):
        current_agent_name = (agent.get("name") or "").strip() or None

    # 1.2) Reescritura a primera persona si el agente se auto-menciona
    base_no_block = selfify_current_agent_mentions(base_no_block, current_agent_name, lang)

    # 2) Small talk / respuesta corta
    if is_smalltalk(user_msg, lang) or looks_like_small_answer(base_no_block):
        display_md, meta = base_no_block, {}
    else:
        # 3) Caso normal: usar refs si venían en el bloque; si no, heurística (evita self)
        if refs and current_agent_name:
            refs = [r for r in refs if (r.get("name") or "") != current_agent_name]
        if refs:
            agents_map = _load_agents_full_map(lang)
            cards = _build_referral_cards(refs, agents_map)
            if cards:
                meta = {"referrals": cards, "suppress_wiki_links": True}
                display_md = _linkify_agent_mentions(base_no_block, [c["name"] for c in cards])
            else:
                display_md, meta = augment_with_referrals(base_no_block, lang, current_agent_name)
        else:
            display_md, meta = augment_with_referrals(base_no_block, lang, current_agent_name)

    # 3.1) Derivación por INTENCIÓN del usuario (pregunta) – evita self
    user_refs = infer_referral_from_user_query(user_msg, current_agent_name, lang)
    if user_refs:
        agents_map = _load_agents_full_map(lang)
        user_cards = _build_referral_cards(user_refs, agents_map)
        meta = _merge_referral_cards(meta, user_cards)

    # 3.2) Pase FINAL OBLIGATORIO: si aparecen nombres de agentes, link + tarjetas (evita self)
    display_md, meta = enforce_mentions_linkcards(display_md, meta, lang, current_agent_name)

    # Persistimos lo que se muestra (no el bloque oculto)
    ses = get_session(agent)
    ses["history"].append({"role":"user","content": user_msg})
    ses["history"].append({"role":"assistant","content": display_md})

    # Devolvemos meta para el frontend
    return {"response": display_md, "meta": meta}

@app.post("/api/reset")
def reset_conversation():
    global sessions; sessions = {}
    return {"status":"ok","message":"Conversation history cleared"}
