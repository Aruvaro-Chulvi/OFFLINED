from fastapi import FastAPI, Query, Request, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse, FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from llama_cpp import Llama
import json, os, re, math, locale, unicodedata
import hashlib
import subprocess
import requests
import psutil
from typing import Dict, Any, Optional, List, Tuple
import httpx
from pathlib import Path
from urllib.parse import quote
import mimetypes
import sys  # <-- NUEVO (para detectar modo "empaquetado")
import base64, time
import shutil  # <-- NUEVO: para guardar ficheros subidos
from pydantic import BaseModel

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
    elif lang.startswith("pt"): return "pt"
    return "en"

LANG_CODE = detect_language()
LANG_MAP = {
    "es": {"flag": "🇪🇸", "label": "Español"},
    "en": {"flag": "🇬🇧", "label": "English"},
    "fr": {"flag": "🇫🇷", "label": "Français"},
    "pt": {"flag": "🇵🇹", "label": "Português"},
}
LANG_INFO = LANG_MAP.get(LANG_CODE, LANG_MAP["en"])

def lang_info_from(code: Optional[str]):
    code = (code or "").lower()
    return LANG_MAP.get(code, LANG_MAP.get(LANG_CODE, LANG_MAP["en"]))

# ===== MODELOS =====
ALLOWED_MODELS = ["gpt-oss-20b-Q4_K_M.gguf"]
CHAT_FORMAT_MAP = {
  # "gpt-oss-20b-Q4_K_M.gguf": "harmony"
}
DEFAULT_MODEL = ALLOWED_MODELS[0]
CTX_TOKENS, REPLY_TOKENS = 4096, 512
SEED = 42
GEN_KW = dict(
    max_tokens=REPLY_TOKENS,
    temperature=0.2,
    top_p=0.9,
    top_k=40,
    repeat_penalty=1.12,
)

STOP_SEQS = [
    # Harmony format (gpt-oss): never stop on <|end|> or you'll cut after the analysis block
    "<|start|>system",
    "<|start|>developer",
    "<|start|>user",
    "<|start|>python",
    "<|start|>browser",
    "<|start|>functions.",
]

# ===== AUTO-CONTINUE (evita cortes sin subir max_tokens) =====
AUTO_CONTINUE_ENABLED = os.getenv("AUTO_CONTINUE", "1") == "1"
AUTO_CONTINUE_MAX_CALLS = int(os.getenv("AUTO_CONTINUE_MAX_CALLS", "4"))  # máximo trozos
AUTO_CONTINUE_CHUNK_TOKENS = int(os.getenv("AUTO_CONTINUE_CHUNK_TOKENS", str(REPLY_TOKENS)))  # tokens por trozo

# === Presupuestos de contexto y utilidades de conteo ===
SAFETY_TOKENS = 256                        # colchón para stops, formato, etc.
HARD_MAX_CTX  = CTX_TOKENS                 # por claridad
HISTORY_BUDGET = HARD_MAX_CTX - SAFETY_TOKENS

def _count_tokens_text(text: str) -> int:
    if not text:
        return 0
    # llama.cpp tokeniza bytes; add_bos=False para estimar "como chat"
    return len(llm.tokenize(text.encode("utf-8"), add_bos=False))

def _count_tokens_messages(msgs: List[dict]) -> int:
    total = 0
    for m in msgs:
        # Contamos solo el contenido; para modelos chat_template es buena aproximación
        total += _count_tokens_text(m.get("content",""))
    return total

def _dynamic_max_tokens(prompt_msgs: List[dict]) -> int:
    used = _count_tokens_messages(prompt_msgs)
    # Máximo de generación sin pasarnos de contexto
    avail = HARD_MAX_CTX - used - SAFETY_TOKENS
    return max(256, min(REPLY_TOKENS, avail))

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
    
def _summarizer_system(lang_code: Optional[str]) -> str:
    code = (lang_code or LANG_CODE or "en")[:2].lower()
    if code == "es":
        return ("Eres un compresor de diálogo. Resume la conversación en viñetas "
                "(<= 10), manteniendo: objetivos del usuario, decisiones, datos, "
                "restricciones y próximos pasos. No repitas texto literal. Máx ~150 tokens.")
    if code == "fr":
        return ("Tu es un compresseur de dialogue. Résume l’échange en puces (<= 10) "
                "en gardant : objectifs utilisateur, décisions, faits, contraintes et suites. "
                "Pas de verbatim. ~150 tokens max.")
    if code == "pt":
        return ("Você é um compressor de diálogo. Resuma a conversa em tópicos (<= 10) "
                "mantendo: objetivos do usuário, decisões, fatos, restrições e próximos passos. "
                "Sem trechos literais. ~150 tokens máx.")
    return ("You are a dialogue compressor. Summarize the chat into bullets (<= 10) "
            "preserving: user goals, decisions, facts, constraints, next steps. "
            "No verbatim. ~150 tokens max.")

def _serialize_history_for_summary(history: List[dict]) -> str:
    # Convierte el historial a un texto plano "User: ...\nAssistant: ..."
    out = []
    for m in history[-24:]:  # últimas 24 entradas (12 turnos aprox)
        role = m.get("role","")
        if role == "user":
            out.append(f"User: {m.get('content','')}")
        elif role == "assistant":
            out.append(f"Assistant: {m.get('content','')}")
    return "\n".join(out).strip()

def _summarize_history_if_needed(agent, lang_code: Optional[str]):
    """
    Si el prompt excede presupuesto, crea/actualiza memo y poda historial antiguo,
    conservando los últimos turnos + la memo sistemática.
    """
    ses = get_session(agent)
    history = ses.get("history", [])

    # 1) Construimos mensajes "candidatos" tal cual irían, para estimar uso:
    sys_msg = {"role": "system", "content": system_prompt(agent, lang_code)}
    candidate = [sys_msg] + history

    if _count_tokens_messages(candidate) <= HISTORY_BUDGET:
        return  # cabe, no hacemos nada

    # 2) Generar/actualizar memo
    memo = ses.get("memo", "")
    # construimos un lote pequeño para el summarizer:
    summ_msgs = [
        {"role": "system", "content": _summarizer_system(lang_code)},
        {"role": "user",   "content": _serialize_history_for_summary(history)}
    ]
    try:
        out = llm.create_chat_completion(
            messages=summ_msgs,
            max_tokens=180, temperature=0.1, top_p=0.9, repeat_penalty=1.1, stop=STOP_SEQS
        )
        memo_new = (out["choices"][0]["message"]["content"] or "").strip()
        if memo_new:
            memo = memo_new
            ses["memo"] = memo
    except Exception:
        # Si falla, mantenemos la memo previa (si hubiera) y seguimos
        memo = ses.get("memo", "")

    # 3) Reescribir history con memo + últimos turnos recientes
    #    Dejamos un "system memo" que no pisa el system principal:
    memo_block = {"role": "system",
                  "content": f"Conversation summary (persisted):\n{memo}\n"}

    # Conserva pocos turnos recientes hasta no pasarnos
    kept = []
    # Intenta conservar hasta 6 mensajes recientes (3 turnos)
    tail = history[-6:] if len(history) > 6 else history[:]
    # Vamos ajustando hacia atrás hasta que quepa
    while True:
        candidate2 = [sys_msg, memo_block] + tail
        if _count_tokens_messages(candidate2) <= HISTORY_BUDGET or not tail:
            break
        # si aún no cabe, recorta por delante del tail:
        tail = tail[2:] if len(tail) > 2 else []

    ses["history"] = [memo_block] + tail


# ===== Modelo activo =====
MODEL_FILE = "gpt-oss-20b-Q4_K_M.gguf"
BASE_DIR = Path(__file__).resolve().parent        # .../backend
# === Raíz del bundle (funciona en desarrollo y en PyInstaller) ===
def _bundle_root() -> Path:
    # PyInstaller onefile extrae en carpeta temporal (_MEIPASS)
    if getattr(sys, "_MEIPASS", None):
        return Path(sys._MEIPASS).resolve()
    # PyInstaller onefolder: el ejecutable vive en la carpeta final
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    # En desarrollo: carpeta raíz del repo (../)
    return BASE_DIR.parent

BUNDLE_ROOT = _bundle_root()
def _preconfigure_env_paths():
    """
    Si no hay KIWIX_CONTENT_DIR, intenta detectar C:\...\kiwix\content
    a partir de la ubicación del ejecutable (o del repo en desarrollo)
    y la exporta para el proceso actual.
    """
    try:
        if os.getenv("KIWIX_CONTENT_DIR"):
            return
        # Base: carpeta del exe (frozen) o backend en desarrollo
        base = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else BASE_DIR
        # Busca ../../kiwix/content (dos niveles por encima de dist/SurvivalAI)
        cand = (base.parent.parent / "kiwix" / "content").resolve()
        if cand.is_dir():
            os.environ["KIWIX_CONTENT_DIR"] = str(cand)
            print(f"[kiwix] KIWIX_CONTENT_DIR auto-set → {cand}")
    except Exception as e:
        print("[kiwix] preconfigure error:", e)

_preconfigure_env_paths()
FRONTEND_DIR = (BUNDLE_ROOT / "frontend").resolve()
MODELS_DIR   = (BUNDLE_ROOT / "models").resolve()
MODEL_PATH = str((MODELS_DIR / MODEL_FILE).resolve())

# ---- Static: support_images en la raíz del bundle ----
SUPPORT_IMAGES = (BUNDLE_ROOT / "support_images").resolve()
print("[static] /support_images ->", SUPPORT_IMAGES)

app.mount(
    "/support_images",
    StaticFiles(directory=str(SUPPORT_IMAGES)),
    name="support_images",
)



def resolve_chat_format(filename: str):
    # Por defecto None → llama.cpp usa el chat_template del GGUF
    return CHAT_FORMAT_MAP.get(filename)

def load_llm(path: str, filename: str):
    chat_format = resolve_chat_format(filename)

    # --- Threads: usar núcleos físicos por defecto (mejor en CPUs antiguas) ---
    physical_cores = psutil.cpu_count(logical=False) or (os.cpu_count() or 4)

    # Overrides por variables de entorno (para test rápido sin editar código)
    n_threads = int(os.getenv("LLAMA_THREADS", str(physical_cores)))
    n_threads_batch = int(os.getenv("LLAMA_THREADS_BATCH", str(n_threads)))

    n_batch = int(os.getenv("LLAMA_BATCH", "256"))

    # (Opcional pero MUY recomendable) log para confirmar qué está usando
    print(f"[LLAMA] physical_cores={physical_cores} | n_threads={n_threads} | n_threads_batch={n_threads_batch} | n_batch={n_batch}")

    kwargs = dict(
        model_path=path,
        n_ctx=CTX_TOKENS,
        n_threads=n_threads,
        n_threads_batch=n_threads_batch,
        n_batch=n_batch,
        seed=SEED,
        use_mmap=True,
        use_mlock=False,
        verbose=False,
    )
    if chat_format:
        kwargs["chat_format"] = chat_format
    return Llama(**kwargs)

import re

_FINAL_PREFIX = "FINAL ANSWER ONLY:"

def _continue_prompt(lang_code: str | None) -> str:
    code = (lang_code or "en")[:2].lower()
    prompts = {
        "es": "Continúa EXACTAMENTE desde donde lo dejaste. No repitas nada. No añadas introducción. No escribas 'FINAL ANSWER ONLY:' otra vez. Sigue con la siguiente palabra.",
        "en": "Continue EXACTLY from where you left off. Do not repeat anything. Do not add any preface. Do not write 'FINAL ANSWER ONLY:' again. Continue with the next word.",
        "fr": "Continue EXACTEMENT là où tu t'es arrêté. Ne répète rien. N’ajoute pas d’introduction. N’écris pas 'FINAL ANSWER ONLY:' à nouveau. Continue avec le mot suivant.",
        "pt": "Continue EXATAMENTE de onde parou. Não repita nada. Não adicione introdução. Não escreva 'FINAL ANSWER ONLY:' novamente. Continue com a próxima palavra.",
    }
    return prompts.get(code, prompts["en"])


def _strip_final_prefix(text: str) -> str:
    if not text:
        return text
    t = text.lstrip()
    if t.startswith(_FINAL_PREFIX):
        # quita el prefijo y un posible salto/espacio posterior
        t = t[len(_FINAL_PREFIX):].lstrip()
    return t


def _trim_overlap(prev: str, new: str, max_window: int = 250) -> str:
    """
    Si el modelo repite el final del texto anterior al empezar el nuevo chunk,
    intentamos eliminar ese solape.
    """
    if not prev or not new:
        return new

    prev_tail = prev[-max_window:]
    new_head = new[:max_window]

    # Busca el mayor solape: sufijo de prev_tail == prefijo de new_head
    best = 0
    max_k = min(len(prev_tail), len(new_head))
    for k in range(1, max_k + 1):
        if prev_tail[-k:] == new_head[:k]:
            best = k

    if best > 0:
        return new[best:]
    return new


def _looks_truncated(text: str) -> bool:
    """
    Heurística opcional: si acaba muy "en el aire".
    No es imprescindible; la señal principal es finish_reason == 'length'.
    """
    if not text:
        return False
    t = text.rstrip()
    # acaba en coma/dos puntos/guion, o abre un bloque típico sin cerrar
    if re.search(r"[,:\-\(\[]\s*$", t):
        return True
    # código fence abierto sin cerrar
    if t.count("```") % 2 == 1:
        return True
    # math block abierto sin cerrar
    if t.count("$$") % 2 == 1:
        return True
    return False


def chat_completion_autocontinue(llm, messages, gen_kw: dict, stop_seqs: list[str], lang_code: str | None):
    """
    Genera respuesta en varios chunks para evitar cortes con max_tokens bajo.
    """
    full = ""
    calls = 0
    local_msgs = list(messages)

    while True:
        calls += 1
        kw = dict(gen_kw)
        kw["max_tokens"] = AUTO_CONTINUE_CHUNK_TOKENS

        out = llm.create_chat_completion(
            messages=local_msgs,
            stop=stop_seqs,
            **kw
        )

        chunk = (out["choices"][0]["message"].get("content") or "")
        finish = out["choices"][0].get("finish_reason")  # suele ser 'stop' o 'length'

        # En el primer chunk dejamos el prefijo si lo usas.
        # En chunks siguientes, lo quitamos si aparece.
        if full:
            chunk = _strip_final_prefix(chunk)

        # Anti-solape
        chunk = _trim_overlap(full, chunk)

        full += chunk

        # Si terminó por stop, normalmente ya está completo
        if finish != "length":
            # Si quieres ser extra cuidadoso, puedes pedir continue si "parece truncado"
            # pero yo lo dejaría así al principio:
            break

        # Si llegó al límite, pedimos continuación (hasta un máximo de llamadas)
        if calls >= AUTO_CONTINUE_MAX_CALLS:
            break

        # Añadimos el texto ya generado como assistant y pedimos continuar
        local_msgs = list(messages) + [
            {"role": "assistant", "content": full},
            {"role": "user", "content": _continue_prompt(lang_code)},
        ]

    return full


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

AGENTS_FILE = str((BUNDLE_ROOT / "agents.json").resolve())

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
def looks_like_meta_plan(text: str) -> bool:
    if not text:
        return False
    t = text.strip()

    # Casos típicos que estás viendo
    bad_starts = (
        "we need to", "we should", "let's produce", "no internet references",
        "respond in spanish", "provide a", "use markdown", "we must"
    )
    if t.lower().startswith(bad_starts):
        return True

    # También detecta instrucciones internas frecuentes
    meta_markers = (
        "we need to respond", "no internet", "use markdown", "provide definitions",
        "let´s produce", "let's do it", "the instruction:"
    )
    tl = t.lower()
    return any(m in tl for m in meta_markers)


def extract_harmony_final(text: str) -> str:
    """
    GPT-OSS (Harmony) puede devolver:
      <|channel|>analysis<|message|>...
      <|channel|>final<|message|>...
    Si detectamos ese formato, devolvemos SOLO el contenido de 'final'.
    """
    if not text:
        return ""
    if "<|channel|>" not in text:
        return text

    # Captura bloques: channel -> content, hasta el siguiente <|channel|> o fin
    blocks = re.findall(r"<\|channel\|>(.*?)<\|message\|>(.*?)(?=<\|channel\|>|$)", text, flags=re.S)
    if not blocks:
        return text

    # Normaliza
    norm = [(c.strip().lower(), (m or "").strip()) for c, m in blocks if (m or "").strip()]

    # Prioridad: final
    for c, m in norm:
        if c == "final":
            return m

    # Si no hay final, evita analysis si hay alternativa
    non_analysis = [m for c, m in norm if c != "analysis"]
    if non_analysis:
        return non_analysis[-1]

    # Último recurso: lo último que haya
    return norm[-1][1] if norm else text

import re

# Compila regex una vez (mejor rendimiento)
_RX_HARMONY_ANY = re.compile(
    r"(?is)<\|channel\|>\s*(analysis|final|assistant|tool|system)\s*<\|message\|>"
)

_RX_TAG_BLOCKS = [
    # Bloques completos tipo <think>...</think>
    re.compile(r"(?is)<\s*(think|thinking|analysis|reasoning|reflection|deliberate)\s*>.*?<\s*/\s*\1\s*>"),
    # Variantes auto-cerradas raras (por si acaso)
    re.compile(r"(?is)<\s*(think|thinking|analysis|reasoning|reflection)\s*/\s*>"),
]

# Encabezados / secciones típicas de razonamiento que a veces el modelo imprime en texto
_RX_SECTION_HEADERS = re.compile(
    r"(?im)^\s*(?:#{1,6}\s*)?"
    r"(?:"
    r"thoughts?|reasoning|analysis|chain[-\s]*of[-\s]*thought|cot|"
    r"plan|internal\s+monologue|reflection|thinking"
    r")\s*[:\-–—]\s*$"
)

# Cabeceras inline tipo "Reasoning: ...", "Analysis: ...", "Thought: ..."
_RX_INLINE_PREFIX = re.compile(
    r"(?im)^\s*(thoughts?|reasoning|analysis|reflection|thinking|plan)\s*:\s*"
)

# Bloques tipo "```analysis ... ```" (algunos modelos los usan)
_RX_FENCED_ANALYSIS = re.compile(r"(?is)```(?:analysis|reasoning|thoughts|thinking)\s*.*?```")

# A veces sale como bloque entre delimitadores estilo OpenAI
_RX_BRACKET_ANALYSIS = re.compile(r"(?is)\[(?:analysis|reasoning|thoughts|thinking)\]\s*.*?(?=\n\s*\[|\Z)")

# Tokens chat template típicos que pueden quedar sueltos
_RX_CHAT_TOKENS = re.compile(
    r"(?is)"
    r"(?:<\|im_start\|>|<\|im_end\|>|<\|assistant\|>|<\|user\|>|<\|system\|>|<\|end\|>)"
)

def strip_thinking(text: str) -> str:
    if not text:
        return ""

    s = text

    # 0) Si viene en formato <|channel|>analysis/final, quédate con "final"
    # (usa tu función existente que ya hace esto)
    try:
        s = strip_model_emphasis(s)  # <- la que tienes justo arriba
    except Exception:
        pass

    # 1) Bloques XML típicos
    s = re.sub(r"(?is)<think\b[^>]*>.*?</think\s*>", "", s)
    s = re.sub(r"(?is)<thinking\b[^>]*>.*?</thinking\s*>", "", s)
    s = re.sub(r"(?is)<analysis\b[^>]*>.*?</analysis\s*>", "", s)
    s = re.sub(r"(?is)<reasoning\b[^>]*>.*?</reasoning\s*>", "", s)

    # 2) Fences de Markdown tipo ```analysis ... ```
    s = re.sub(r"(?is)```(?:analysis|reasoning|think|thoughts)\s*.*?```", "", s)

    # 3) Encabezados/secciones “Thinking/Analysis/Reasoning” (hasta antes de "Final/Answer" si aparece)
    s = re.sub(
        r"(?is)^\s*(?:#+\s*)?(analysis|reasoning|thinking|thoughts)\s*:?[\t ]*\n.*?(?=^\s*(?:#+\s*)?(final|answer|response)\s*:?\s*\n|\Z)",
        "",
        s,
        flags=re.M
    )

    # 4) Líneas sueltas tipo "Analysis:" / "Reasoning:" al inicio
    s = re.sub(r"(?im)^\s*(analysis|reasoning|thinking|thoughts)\s*:\s*$", "", s)

    # 5) Normaliza saltos
    s = re.sub(r"\n{3,}", "\n\n", s).strip()
    return s



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
    
def _resolve_lang(payload_lang: Optional[str], user_text: str) -> str:
    if payload_lang:
        return payload_lang

    t = user_text or ""
    tnorm = _norm(t)

    # ES
    if ("¿" in t) or ("¡" in t):
        return "es"
    if re.search(r"\b(que|como|cual|donde|por que|trucha|pesca|cana|anz(ue)lo|cebo)\b", tnorm):
        return "es"

    # PT (palabras y diacríticos muy típicos)
    if re.search(r"\b(ol[aá]|oi|voc[eê]|n[aã]o|por\s?qu[eê])\b", tnorm) or re.search(r"[çãõ]", t):
        return "pt"

    return (LANG_CODE or "en")

   
def _referrals_title_for(lang_code: str | None) -> str:
    code = (lang_code or LANG_CODE or "en").split("-")[0].lower()
    titles = {
        "es": "Si te interesa este tema en profundidad, te recomiendo hablar con:",
        "en": "If you want to dive deeper into this topic, I recommend talking to:",
        "fr": "Si tu veux approfondir ce sujet, je te recommande de parler avec:",
        "pt": "Se quiser aprofundar este tema, recomendo falar com:",
    }
    return titles.get(code, titles["en"])

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

def protect_latex_delimiters(s: str) -> str:
    if not s:
        return s
    # Para que marked no se coma \(...\) y \[...\]
    s = s.replace("\\(", "\\\\(").replace("\\)", "\\\\)")
    s = s.replace("\\[", "\\\\[").replace("\\]", "\\\\]")
    return s

import re

def normalize_latex_delimiters(text: str) -> str:
    if not text:
        return text

    # \[ ... \]  ->  $$ ... $$
    text = re.sub(
        r"\\\[\s*(.*?)\s*\\\]",
        r"$$\1$$",
        text,
        flags=re.S
    )

    # \( ... \)  ->  $ ... $
    text = re.sub(
        r"\\\(\s*(.*?)\s*\\\)",
        r"$\1$",
        text,
        flags=re.S
    )

    return text


def clean_answer(text: str, lang_code: Optional[str] = None) -> str:
    """
    Clean model output for the frontend:
    - Fix escaped math delimiters (\$ and \$$)
    - Fix common row-spacing glitches like \\$$2pt] -> \\[2pt]
    - Remove stray lines that are just "$"
    """
    s = (text or "").replace("\r\n", "\n").replace("\r", "\n")

    # Strip ending token if present
    s = re.sub(r"<\|end\|>\s*$", "", s).strip()

    # Fix escaped $ delimiters coming from the model
    s = s.replace(r"\$\$", "$$")
    s = s.replace(r"\$", "$")

    # Fix spacing glitch: \\$$2pt] or \$4pt] -> \\[2pt]
    s = re.sub(r"\\\\\$\$([0-9.]+pt\])", r"\\\\[\1", s)
    s = re.sub(r"\\\$\$([0-9.]+pt\])", r"\\\\[\1", s)
    s = re.sub(r"\\\$([0-9.]+pt\])", r"\\\\[\1", s)

    # Normalize \(..\) and \[..\]
    s = re.sub(r"\\\[(.*?)\\\]", r"$$\1$$", s, flags=re.S)
    s = re.sub(r"\\\((.*?)\\\)", r"$\1$", s, flags=re.S)

    # Remove stray "$" lines
    s = re.sub(r"(?m)^\s*\$\s*$", "", s)

    return s.strip()

def _load_agents_full_map(lang_code: Optional[str]) -> Dict[str, dict]:
    """Mapa: nombre -> {name, category, profession, avatar, keywords} (localizado, con keywords crudas)."""
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
            # ⬇️ sin esto, el detector por respuesta no verá nada
            "keywords": meta.get("keywords", {}),
        }
    return out

# ====== REFERRALS / MENCIÓN DE AGENTES ======
def _keyword_patterns(kw: str) -> List[re.Pattern]:
    """Variaciones morfológicas básicas (acento-insensible, ES/EN/FR)."""
    k = _norm(kw).strip()
    if len(k) < 3:
        return []
    pats: List[re.Pattern] = [re.compile(rf"\b{re.escape(k)}\w{{0,8}}\b")]

    # Stems largos (comodín)
    if len(k) >= 8:
        stem6 = re.escape(k[:6])
        pats.append(re.compile(rf"\b{stem6}\w{{0,10}}\b"))

    # ES: -ización → ...iza*
    if k.endswith("izacion"):
        stem = re.escape(k[:-7] + "iza")
        pats.append(re.compile(rf"\b{stem}\w{{0,8}}\b"))

    # FR: -isation → ...is*
    if k.endswith("isation"):
        stem = re.escape(k[:-8] + "is")
        pats.append(re.compile(rf"\b{stem}\w{{0,8}}\b"))

    # ES: -ador/-adora o -dor/-dora → raíz
    if re.search(r'(?:ador|adora)$', k) or re.search(r'(?:dor|dora)$', k):
        base = re.sub(r'(?:ador|adora|dor|dora)$', '', k)
        if len(base) >= 3:
            pats.append(re.compile(rf"\b{re.escape(base)}\w{{0,8}}\b"))

    # ES/FR: psicología/psicólogo/psicóloga → psicolog*
    if re.search(r'log(?:o|a|ia)$', k):
        base = re.sub(r'log(?:o|a|ia)$', 'log', k)
        pats.append(re.compile(rf"\b{re.escape(base)}\w{{0,8}}\b"))

    # EN: -ing/-er/-ist/-tion(s) → raíz
    if re.search(r'(ing|ers?|ists?|tions?)$', k):
        base = re.sub(r'(ing|ers?|ists?|tions?)$', '', k)
        if len(base) >= 3:
            pats.append(re.compile(rf"\b{re.escape(base)}\w{{0,8}}\b"))

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
    ],
    "pt": [
        r"\brecomendo\b",
        r"\brecomendaria\b", r"\beu (?:recomendo|recomendaria)\b",
        r"\bfalar com\b", r"\bconversar com\b",
        r"\bconsultar (?:com|um|uma)\b",
        r"\bentrar em contato com\b",
        r"\bdeveria ver\b", r"\bencaminhar para\b",
    ]
}

def _collect_keywords(meta: dict, lang_code: Optional[str]) -> List[str]:
    """
    SOLO keywords del idioma activo (o lista si es global) + nombre como alias débil.
    SIN profesión ni tokens de profesión (ignorados por diseño).
    Devuelve lista normalizada y deduplicada.
    """
    code = (lang_code or LANG_CODE or "en").split("-")[0].lower()
    out: List[str] = []

    # 1) keywords
    kws = meta.get("keywords", [])
    if isinstance(kws, dict):
        lang_list = kws.get(code) or []
        if isinstance(lang_list, list):
            out.extend([str(x) for x in lang_list if str(x).strip()])
    elif isinstance(kws, list):
        out.extend([str(x) for x in kws if str(x).strip()])

    # 2) nombre del agente como alias débil (para mención directa)
    nm = meta.get("name") or meta.get("Name")
    if isinstance(nm, str) and nm.strip():
        out.append(nm)

    # 3) normaliza / dedup / filtra cortas
    normed, seen = [], set()
    for k in out:
        k2 = _norm(k)
        if len(k2) >= 3 and k2 not in seen:
            seen.add(k2)
            normed.append(k2)
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
        kws = _collect_keywords(meta, lang_code)
        score = 0
        for k in kws:
            for pat in _keyword_patterns(k):
                score += len(re.findall(pat, tnorm))
        if score > best_score:
            best_name, best_score = name, score

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

def _keywords_for_lang_only(meta: dict, lang_code: str | None) -> list[str]:
    """
    Prefer the active language; if it's missing/empty, fallback to ALL languages.
    Returns normalized, de-duplicated keywords (>=3 chars).
    """
    code = (lang_code or LANG_CODE or "en").split("-")[0].lower()

    raw = meta.get("keywords", [])
    prefer = []
    pool_all = []

    if isinstance(raw, dict):
        # Prefer active lang
        prefer = raw.get(code) or []
        # Build union of all langs (backup)
        for vals in raw.values():
            if isinstance(vals, list):
                pool_all.extend(vals)
    elif isinstance(raw, list):
        prefer = raw
        pool_all = raw
    else:
        prefer = []
        pool_all = []

    def _clean_list(items):
        out, seen = [], set()
        for k in items or []:
            k2 = _norm(str(k))
            if len(k2) >= 3 and k2 not in seen:
                seen.add(k2); out.append(k2)
        return out

    # If preferred lang has items, use them; else, use the union of all
    prefer_clean = _clean_list(prefer)
    if prefer_clean:
        return prefer_clean

    return _clean_list(pool_all)

def simple_referrals_from_answer(answer_text: str,
                                 current_agent_name: str | None,
                                 lang_code: str | None,
                                 max_results: int = 1,
                                 min_kw_hits: int = 3,   # ajusta en la llamada si quieres 3
                                 return_debug: bool = False):
    """
    Dispara si: (Nombre) OR (>= min_kw_hits keywords).
    Profesión IGNORADA por diseño.
    Orden: (kw_hits * 4) + bonus(nombre).
    Regla extra: si el agente actual (self) puntúa >= mejor candidato, no recomendar a nadie.
    """
    agents_map = _load_agents_full_map(lang_code)
    raw = answer_text or ""
    tnorm = _norm(raw)
    rows, debug_rows = [], []

    # --- 1) Puntuar candidatos (EXCLUYENDO self para no recomendarse a sí mismo) ---
    for name, meta in agents_map.items():
        if current_agent_name and name == current_agent_name:
            continue  # no se recomienda a sí mismo

        # Nombre literal en el texto de respuesta
        has_name = bool(re.search(rf"(?<!\w){re.escape(name)}(?!\w)", raw))

        # Keywords del idioma preferido (o fallback a todas)
        kw_hits = 0
        for kw in _keywords_for_lang_only(meta, lang_code):
            for pat in _keyword_patterns(kw):
                if re.search(pat, tnorm):
                    kw_hits += 1
                    break

        # Disparo por nombre o por umbral de keywords
        cond = has_name or (kw_hits >= min_kw_hits)

        # Score: prioriza tema (keywords), luego nombre
        score = (kw_hits * 4) + (2 if has_name else 0)

        if return_debug:
            debug_rows.append({
                "name": name,
                "has_name": has_name,
                "kw_hits": kw_hits,
                "score": score,
                "cat": meta.get("category")
            })

        if cond:
            rows.append((score, name))

    rows.sort(key=lambda x: x[0], reverse=True)

    # --- 2) Calcular SELF-SCORE del agente actual con la MISMA métrica ---
    self_score = -1
    if current_agent_name and current_agent_name in agents_map:
        meta_self = agents_map[current_agent_name]
        has_name_self = bool(re.search(rf"(?<!\w){re.escape(current_agent_name)}(?!\w)", raw))
        kw_hits_self = 0
        for kw in _keywords_for_lang_only(meta_self, lang_code):
            for pat in _keyword_patterns(kw):
                if re.search(pat, tnorm):
                    kw_hits_self += 1
                    break
        self_score = (kw_hits_self * 4) + (2 if has_name_self else 0)

    # --- 3) Regla de supresión: si self >= mejor otro, NO recomendar ---
    best_other = rows[0][0] if rows else -1
    if self_score >= best_other and best_other >= 0:
        if return_debug:
            debug_rows.sort(key=lambda r: r["score"], reverse=True)
            return {"refs": [], "debug_simple": debug_rows, "self_score": self_score, "best_other": best_other}
        return []

    # --- 4) Construcción de picks si no se suprime ---
    picks = [{"name": n, "reason": ""} for score, n in rows[:max_results]]

    if return_debug:
        debug_rows.sort(key=lambda r: r["score"], reverse=True)
        return {"refs": picks, "debug_simple": debug_rows, "self_score": self_score, "best_other": best_other}
    return picks



def _score_text_with_keywords(text: str, agent_name: str, meta: dict, lang_code: Optional[str]) -> int:
    """Score por mención literal + keywords (SIN profesión)."""
    if not text or not meta:
        return 0

    tnorm = _norm(text)
    score = 0

    # mención exacta del nombre del agente
    if re.search(rf"(?<!\w){re.escape(agent_name)}(?!\w)", text, flags=re.I):
        score += 5

    # keywords del idioma actual (peso 1 por match)
    for k in _collect_keywords(meta, lang_code):
        for pat in _keyword_patterns(k):
            score += len(re.findall(pat, tnorm))

    return score



def infer_referral_from_user_query(user_text: str,
                                   current_agent_name: Optional[str],
                                   lang_code: Optional[str],
                                   max_results: int = 2,
                                   min_score: int = 3,
                                   return_debug: bool = False):
    """
    Puntúa TODOS los agentes contra la PREGUNTA del usuario (no la respuesta del modelo).
    - Evita recomendar al agente actual.
    - Ordena por score y, a igualdad, prioriza misma categoría del agente actual.
    - Devuelve [{"name":..., "reason":""}, ...] o si return_debug=True, {"refs":[...], "debug":[...]}.
    """
    tlow = (user_text or "").strip()
    if not tlow:
        return [] if not return_debug else {"refs": [], "debug": []}

    tnorm = _norm(tlow)

    # Usa el “full map” que ya incluye profession localizada y keywords crudas
    agents_map = _load_agents_full_map(lang_code)

    # Categoría del agente actual para desempates
    current_cat = None
    if current_agent_name and current_agent_name in agents_map:
        current_cat = str(agents_map[current_agent_name].get("category") or "").lower()

    scored = []
    debug_rows = []
    for name, meta in agents_map.items():
        if current_agent_name and name == current_agent_name:
            continue
        s = _score_text_with_keywords(tlow, name, meta, lang_code)
        if s > 0:
            scored.append((s, name, meta))
        if return_debug:
            debug_rows.append({"name": name, "score": s, "cat": meta.get("category")})

    if not scored:
        return [] if not return_debug else {"refs": [], "debug": debug_rows}

    # Orden: score desc; desempate: misma categoría que el agente actual
    def _rank_key(item):
        s, _n, m = item
        same = 1 if current_cat and (str(m.get("category") or "").lower() == current_cat) else 0
        return (s, same)

    scored.sort(key=_rank_key, reverse=True)

    picks = []
    for s, name, meta in scored:
        if s >= min_score:
            picks.append({"name": name, "reason": ""})
        if len(picks) >= max_results:
            break

    if return_debug:
        dbg = sorted(debug_rows, key=lambda r: (r["score"], 1 if current_cat and str(r.get("cat") or "").lower()==current_cat else 0), reverse=True)
        return {"refs": picks, "debug": dbg}

    return picks

    
def infer_referrals_from_model_answer(answer_text: str,
                                      current_agent_name: Optional[str],
                                      lang_code: Optional[str],
                                      max_results: int = 2,
                                      min_hits: int = 3,
                                      return_debug: bool = False):
    """
    Detección basada en la RESPUESTA del modelo:
    - Usa keywords del idioma activo (vía _collect_keywords(meta, lang_code)).
    - Match por substring normalizado y, si hace falta, por patrones morfológicos.
    - Evita recomendar al propio agente.
    """
    text = (answer_text or "").strip()
    if not text:
        return [] if not return_debug else {"refs": [], "debug": []}

    tnorm = _norm(text)  # minúsculas + sin acentos
    agents_map = _load_agents_full_map(lang_code)

    current_cat = None
    if current_agent_name and current_agent_name in agents_map:
        current_cat = str(agents_map[current_agent_name].get("category") or "").lower()

    scored = []
    debug_rows = []
    for name, meta in agents_map.items():
        if current_agent_name and name == current_agent_name:
            continue

        kws = _collect_keywords(meta, lang_code)  # SOLO idioma activo
        hits = 0
        reasons = []

        for k in kws:
            if not k:
                continue
            # 1) Substring normalizado (captura plurales/flexiones)
            if k in tnorm:
                hits += 1
                reasons.append(f"sub:{k}")
                continue
            # 2) Fallback: patrones morfológicos
            for pat in _keyword_patterns(k):
                if re.search(pat, tnorm):
                    hits += 1
                    reasons.append(f"pat:{k}")
                    break

        if hits >= min_hits:
            scored.append((hits, name, meta, reasons))
            if return_debug:
                debug_rows.append({"name": name, "hits": hits, "reasons": reasons, "cat": meta.get("category")})

    def _rank_key(item):
        s, _n, m, _r = item
        same = 1 if current_cat and (str(m.get("category") or "").lower() == current_cat) else 0
        return (s, same)

    scored.sort(key=_rank_key, reverse=True)

    picks = []
    for s, name, _meta, _reasons in scored:
        picks.append({"name": name, "reason": ""})
        if len(picks) >= max_results:
            break

    if return_debug:
        dbg = sorted(debug_rows, key=lambda r: (r["hits"], 1 if current_cat and str(r.get("cat") or "").lower()==current_cat else 0), reverse=True)
        return {"refs": picks, "debug": dbg}

    return picks

# ---------------- DEBUG & MENCIONES ----------------

def _list_all_agents(lang_code: Optional[str]) -> list[str]:
    mp = _load_agents_full_map(lang_code)
    return list(mp.keys())

def _extract_agent_mentions(text: str, agents_map: dict) -> list[str]:
    """Detecta menciones de nombre exacto de agentes en texto (case-insensitive)."""
    if not text:
        return []
    found, seen = [], set()
    for name in agents_map.keys():
        if re.search(rf"(?<!\w){re.escape(name)}(?!\w)", text, flags=re.I):
            if name not in seen:
                seen.add(name)
                found.append(name)
    return found

def debug_collect_scores(user_text: str,
                         answer_text: str,
                         current_agent_name: Optional[str],
                         lang_code: Optional[str]) -> dict:
    """
    Devuelve todo lo necesario para ver qué está ‘viendo’ el recomendador:
    - scores por INTENCIÓN (pregunta del usuario)
    - hits por RESPUESTA del modelo
    - menciones explícitas en user/answer
    """
    out = {"user_scores": [], "model_hits": [], "mentions_in_user": [], "mentions_in_answer": []}

    agents_map = _load_agents_full_map(lang_code)
    # 1) scores por intención (usa mismo scorer que infer_referral_from_user_query)
    tnorm = _norm(user_text or "")
    rows = []
    for name, meta in agents_map.items():
        if current_agent_name and name == current_agent_name:
            continue
        s = _score_text_with_keywords(tnorm, name, meta, lang_code)
        rows.append({"name": name, "score": s, "cat": meta.get("category")})
    rows.sort(key=lambda r: r["score"], reverse=True)
    out["user_scores"] = rows

    # 2) hits por respuesta del modelo (usa mismo detector que infer_referrals_from_model_answer)
    tnorm_a = _norm(answer_text or "")
    rows2 = []
    for name, meta in agents_map.items():
        if current_agent_name and name == current_agent_name:
            continue
        kws = _collect_keywords(meta, lang_code)
        hits, reasons = 0, []
        for k in kws:
            if not k: 
                continue
            if k in tnorm_a:
                hits += 1; reasons.append(f"sub:{k}"); continue
            for pat in _keyword_patterns(k):
                if re.search(pat, tnorm_a):
                    hits += 1; reasons.append(f"pat:{k}"); break
        if hits > 0:
            rows2.append({"name": name, "hits": hits, "reasons": reasons, "cat": meta.get("category")})
    rows2.sort(key=lambda r: r["hits"], reverse=True)
    out["model_hits"] = rows2

    # 3) menciones de nombres en user y answer
    out["mentions_in_user"] = _extract_agent_mentions(user_text or "", agents_map)
    out["mentions_in_answer"] = _extract_agent_mentions(answer_text or "", agents_map)

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
    "pt": r"^\s*(olá|oi|bom dia|boa tarde|boa noite|tudo bem|como vai)\b",
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
    - SOLO convierte NOMBRES de agentes mencionados en enlaces agent://...
    - NO crea tarjetas adicionales (las tarjetas vienen del detector simple).
    - Si ya hay referrals (del detector), asegura la cabecera localizada.
    """
    agents_map = _load_agents_full_map(lang_code)
    all_mentions = _find_mentioned_agents(text, agents_map)  # [{"name":...}, ...]
    names = [m["name"] for m in all_mentions if not current_agent_name or m["name"] != current_agent_name]

    if names:
        text = _linkify_agent_mentions(text, names)

    if meta and meta.get("referrals"):
        meta = dict(meta)
        meta["suppress_wiki_links"] = True
        if "referrals_title" not in meta:
            meta["referrals_title"] = _referrals_title_for(lang_code)
    elif names:
        # Solo hubo enlaces por mención; no añadimos tarjetas.
        meta = dict(meta or {})
        meta["suppress_wiki_links"] = True

    return text, meta

# ===== Prompt helpers =====

def build_harmony_prompt(messages: list, lang_code: Optional[str] = None) -> str:
    """Build a GPT-OSS harmony prompt. Forces final channel and uses ONE set of rules."""
    dev = base_rules(lang_code) + "\n" + latex_rules(lang_code)

    parts = []
    parts.append(f"<|start|>developer<|message|>{dev}<|end|>")

    for m in messages:
        role = (m or {}).get("role", "user")
        content = str((m or {}).get("content", "") or "")
        content = content.replace("\r\n", "\n").replace("\r", "\n")

        if role not in ("system", "user", "assistant"):
            role = "user"

        if role == "assistant":
            parts.append(f"<|start|>assistant<|channel|>final<|message|>{content}<|end|>")
        else:
            parts.append(f"<|start|>{role}<|message|>{content}<|end|>")

    # force final answer only
    parts.append("<|start|>assistant<|channel|>final<|message|>")
    return "\n".join(parts)


# ===== Anti-reasoning filter (OBLIGATORIO para GPT-OSS / Phi-4) =====

REASONING_MARKERS = (
    # planificación / meta típico
    "we need to",
    "we should",
    "we must",
    "let's",
    "let’s",
    "i will",
    "i should",
    "let me",
    "to answer this",
    "then explanation",
    "use markdown",
    "provide definition",
    "provide a",
    "do not mention",
    "don't mention",
    "avoid meta",
    "start with",
    "begin with",
    "follow-up question",
    "let's produce",
    "let’s produce",
    "let's do",
    "let’s do",
    "we might",
    "we can keep",
    "let us",
    "we want to",
    "we have to",
    # frases que aparecen en tus capturas
    "we must not mention",
    "we must not",
    "also make sure",
)

def strip_reasoning(text: str) -> str:
    """
    Elimina "reasoning/planning" cuando el modelo lo imprime en texto normal
    (sin tags), especialmente al PRINCIPIO de la respuesta.
    Mantiene el contenido útil posterior.
    """
    if not text:
        return ""

    s = text.replace("\r\n", "\n").strip()

    # 0) Si el modelo repite el prefijo, lo quitamos
    s = re.sub(r"(?im)^\s*final answer only:\s*", "", s).strip()

    lines = s.split("\n")
    out = []

    dropping = True          # al principio, estamos en "zona meta"
    dropped_any = False

    for line in lines:
        raw = line
        l = raw.strip()
        ll = l.lower()

        # Mientras estemos al inicio: si es línea meta, la saltamos
        if dropping:
            if not l:
                # Si ya hemos eliminado algo y llega un salto, cerramos la zona meta
                if dropped_any:
                    dropping = False
                continue

            if ll.startswith(REASONING_MARKERS) or looks_like_meta_plan(l):
                dropped_any = True
                continue

            # Si la línea es literalmente "Funciones ... ...", no es meta → empezamos a conservar
            dropping = False

        out.append(raw)

    cleaned = "\n".join(out).strip()

    # 1) Segunda pasada suave: elimina líneas sueltas meta que queden por el medio
    cleaned_lines = []
    for line in cleaned.split("\n"):
        l = line.strip()
        ll = l.lower()
        if ll.startswith(REASONING_MARKERS) or looks_like_meta_plan(l):
            continue
        cleaned_lines.append(line)

    return "\n".join(cleaned_lines).strip()


# ===== Prompting de alto nivel =====
def base_rules(lang_code: Optional[str] = None) -> str:
    """High-level behavior rules (no LaTeX details here; see latex_rules)."""
    code = (lang_code or LANG_CODE or "en").split("-")[0].lower()
    if code not in ("en", "es", "fr", "pt"):
        code = "en"

    texts = {
        "en": (
            "You are a helpful assistant.\n"
            "- Reply in the user's language.\n"
            "- Output plain text with minimal Markdown.\n"
            "- Do NOT use fenced code blocks for math.\n"
            "- Math must use ONLY $...$ and $$...$$.\n"
            "- Never use \\[ \\] or \\( \\).\n"
            "- Do NOT reveal internal reasoning or planning; output only the final answer.\n"
            "- Do not add forced structure (no mandatory lists/tables). Use whatever style fits.\n"
        ),
        "es": (
            "Eres un asistente útil.\n"
            "- Responde en el idioma del usuario.\n"
            "- Devuelve texto plano con Markdown mínimo.\n"
            "- NO uses bloques de código para matemáticas.\n"
            "- Las matemáticas deben usar SOLO $...$ y $$...$$.\n"
            "- Nunca uses \\[ \\] ni \\( \\).\n"
            "- NO reveles razonamiento interno ni planificación; escribe solo la respuesta final.\n"
            "- No fuerces estructura (sin obligación de listas/tablas). Usa el estilo que convenga.\n"
        ),
        "fr": (
            "Tu es un assistant utile.\n"
            "- Réponds dans la langue de l’utilisateur.\n"
            "- Fournis du texte brut avec un Markdown minimal.\n"
            "- N’utilise PAS de blocs de code pour les mathématiques.\n"
            "- Les mathématiques doivent utiliser UNIQUEMENT $...$ et $$...$$.\n"
            "- N’utilise jamais \\[ \\] ni \\( \\).\n"
            "- Ne révèle pas le raisonnement interne ni la planification ; donne uniquement la réponse finale.\n"
            "- Ne force pas de structure (pas d’obligation de listes/tableaux). Adapte le style.\n"
        ),
        "pt": (
            "Você é um assistente útil.\n"
            "- Responda no idioma do utilizador.\n"
            "- Produza texto simples com Markdown mínimo.\n"
            "- NÃO utilize blocos de código para matemática.\n"
            "- A matemática deve usar APENAS $...$ e $$...$$.\n"
            "- Nunca utilize \\[ \\] nem \\( \\).\n"
            "- NÃO revele raciocínio interno nem planejamento; escreva apenas a resposta final.\n"
            "- Não force estrutura (sem obrigação de listas/tabelas). Use o estilo adequado.\n"
        ),
    }
    return texts[code]



def agent_prompt_block(agent: Optional[dict], lang_code: Optional[str]) -> str:
    if not agent:
        return ""

    code = (lang_code or LANG_CODE or "en").split("-")[0].lower()
    if code not in ("en", "es", "fr", "pt"):
        code = "en"

    name = (agent.get("name") or "").strip()
    profession = pick_lang(agent.get("profession", ""), code).strip()
    instructions = pick_lang(agent.get("instructions", ""), code).strip()
    personality = pick_lang(agent.get("personality", ""), code).strip()

    # Nada de “formato obligatorio”: solo identidad + misión
    out = []
    if name or profession:
        out.append(f"You are {name or 'an expert assistant'}{(' (' + profession + ')') if profession else ''}.")
    if personality:
        out.append(f"Personality: {personality}")
    if instructions:
        out.append(f"Instructions: {instructions}")

    return "\n".join(out).strip()


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
                "- Do not suggest referrals on greetings or small talk.\n"
                "- At most TWO referrals; keep the reason short.\n"
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
                "- Ne propose pas d’orientation lors de salutations ou de small talk.\n"
                "- Au maximum DEUX orientations avec une raison courte.\n"
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

def model_prompt_block(lang_code: Optional[str]) -> str:
    return ""

def system_prompt(agent=None, lang_code: Optional[str] = None) -> str:
    """Minimal system message: identity + optional agent persona. (No extra LaTeX rules here.)"""
    code = (lang_code or LANG_CODE or "en")[:2].lower()

    hdr = {
        "es": (
            "Eres Offlined Knowledge, un asistente de IA que funciona sin conexión a internet. "
            "No recomiendes contactar servicios ni facilites hipervínculos a internet."
        ),
        "en": (
            "You are Offlined Knowledge, an offline AI assistant. "
            "Do not suggest contacting services or providing web links."
        ),
        "fr": (
            "Tu es Offlined Knowledge, un assistant IA hors connexion. "
            "Ne recommande pas de contacter des services et ne fournis pas de liens web."
        ),
        "pt": (
            "Você é o Offlined Knowledge, um assistente de IA offline. "
            "Não sugira contactar serviços nem forneça links da web."
        ),
    }.get(code, "You are Offlined Knowledge, an offline AI assistant.")

    parts = [hdr]

    if agent:
        name = (agent or {}).get("name", "") or ""
        profession = (agent or {}).get("profession", "") or ""
        personality = (agent or {}).get("personality", "") or ""
        instructions = (agent or {}).get("instructions", "") or ""

        # (opcionales; por si algún modo te los manda)
        role = (agent or {}).get("role", "") or ""
        behavior = (agent or {}).get("behavior", "") or ""

        labels = {
            "es": {
                "name": "Tu nombre es:",
                "expert": "Eres un experto en",
                "style": "Tu forma de hablar es:",
            },
            "en": {
                "name": "Your name is:",
                "expert": "You are an expert in",
                "style": "Your speaking style is:",
            },
            "fr": {
                "name": "Ton nom est:",
                "expert": "Tu es un expert en",
                "style": "Ta façon de parler est:",
            },
            "pt": {
                "name": "O teu nome é:",
                "expert": "Você é um especialista em",
                "style": "A tua forma de falar é:",
            },
        }
        L = labels.get(code, labels["en"])

        persona_lines = []

        if name:
            persona_lines.append(f"{L['name']} {name}.")
        if profession:
            persona_lines.append(f"{L['expert']} {profession}.")
        if personality:
            persona_lines.append(f"{L['style']} {personality}")

        # Si quieres mantener el role (opcional), lo dejo muy discreto:
        if role and role != profession:
            persona_lines.append(f"(role: {role})")

        # 🔥 IMPORTANTE: las instrucciones van DESPUÉS de esas líneas
        if instructions.strip():
            persona_lines.append("")  # línea en blanco
            persona_lines.append(instructions.strip())

        # Si algún modo te manda behavior y quieres que también cuente como instrucción extra:
        if behavior.strip():
            persona_lines.append("")
            persona_lines.append(behavior.strip())

        if persona_lines:
            parts.append("\n".join(persona_lines))

    return "\n\n".join([p for p in parts if str(p).strip()])
    
def latex_rules(lang_code: Optional[str] = None) -> str:
    """Rules to keep KaTeX happy and prevent model-generated LaTeX garbage."""
    code = (lang_code or LANG_CODE or "en").split("-")[0].lower()
    if code not in ("en", "es", "fr", "pt"):
        code = "en"

    texts = {
        "en": (
            "Math formatting (KaTeX-safe):\n"
            "- Use ONLY $...$ (inline) and $$...$$ (display).\n"
            "- NEVER output escaped dollars: do NOT use \\$ or \\$$ anywhere.\n"
            "- Do NOT use \\(...\\) or \\[...\\] as delimiters. Use $ / $$ only.\n"
            "- For matrices/cases/align/array/pmatrix/vmatrix, wrap the entire environment inside $$...$$.\n"
            "- For row spacing inside matrices use \\\\[2pt] (two backslashes + [2pt]).\n"
            "  IMPORTANT: never place $ or $$ near a line break like \\\\ or \\\\[2pt].\n"
            "- Use indices as subscripts: a_{11}, x_1, b_2 (NOT a{11} or x1).\n"
            "- Use valid LaTeX commands: \\frac, \\tfrac, \\cdot, \\neq, \\approx, \\left, \\right.\n"
            "- NEVER write things like $$2pt] or $$4pt] inside matrices/cases.\n"
            "  Line breaks with spacing MUST be \\\\[2pt] (two backslashes).\n"
            "- Do NOT indent $$ delimiters: they must start at the beginning of the line (no spaces).\n"
            "- Do NOT put formulas inside fenced code blocks ```.\n"
        ),
        "es": (
            "Formato matemático (KaTeX-safe):\n"
            "- Usa SOLO $...$ (en línea) y $$...$$ (bloque).\n"
            "- NUNCA escapes dólares: no uses \\$ ni \\$$ en ningún sitio.\n"
            "- NO uses \\(...\\) ni \\[...\\] como delimitadores. Usa solo $ / $$.\n"
            "- En matrices/cases/align/array/pmatrix/vmatrix, encierra TODO el entorno dentro de $$...$$.\n"
            "- Para espaciado de filas en matrices usa \\\\[2pt] (dos barras + [2pt]).\n"
            "  IMPORTANTE: nunca pongas $ o $$ cerca de un salto de línea tipo \\\\ o \\\\[2pt].\n"
            "- Escribe índices como subíndices: a_{11}, x_1, b_2 (NO a{11} ni x1).\n"
            "- Usa comandos LaTeX válidos: \\frac, \\tfrac, \\cdot, \\neq, \\approx, \\left, \\right.\n"
            "- NUNCA escribas algo como $$2pt] o $$4pt] dentro de matrices/cases.\n"
            "  El salto de línea con espaciado SIEMPRE es \\\\[2pt] (dos barras).\n"
            "- No indentes los delimitadores $$: deben empezar al principio de línea (sin espacios).\n"
            "- No metas fórmulas dentro de bloques de código ```.\n"
        ),
        "fr": (
            "Format maths (compatible KaTeX) :\n"
            "- Utilise UNIQUEMENT $...$ (inline) et $$...$$ (display).\n"
            "- N’échappe JAMAIS les dollars : n’utilise pas \\$ ni \\$$.\n"
            "- N’utilise pas \\(...\\) ni \\[...\\] comme délimiteurs. Utilise seulement $ / $$.\n"
            "- Pour matrices/cases/align/array/pmatrix/vmatrix, entoure tout l’environnement avec $$...$$.\n"
            "- Pour l’espacement de lignes dans les matrices, utilise \\\\[2pt] (deux antislash + [2pt]).\n"
            "  IMPORTANT : ne place jamais $ ou $$ près d’un retour à la ligne \\\\ ou \\\\[2pt].\n"
            "- Utilise des indices en exposant/sous-indice : a_{11}, x_1, b_2 (PAS a{11} ni x1).\n"
            "- Utilise des commandes LaTeX valides : \\frac, \\tfrac, \\cdot, \\neq, \\approx, \\left, \\right.\n"
            "- N’écris JAMAIS quelque chose comme $$2pt] ou $$4pt] à l’intérieur des matrices/cases.\n"
            "  Les retours à la ligne avec espacement DOIVENT être \\\\[2pt] (deux antislash).\n"
            "- N’indente pas les délimiteurs $$ : ils doivent commencer en début de ligne (sans espaces).\n"
            "- Ne mets pas de formules dans des blocs de code ```.\n"
        ),
        "pt": (
            "Formatação matemática (KaTeX-safe):\n"
            "- Use APENAS $...$ (inline) e $$...$$ (display).\n"
            "- NUNCA escape dólares: não use \\$ nem \\$$.\n"
            "- NÃO use \\(...\\) nem \\[...\\] como delimitadores. Use apenas $ / $$.\n"
            "- Em matrizes/cases/align/array/pmatrix/vmatrix, envolva todo o ambiente com $$...$$.\n"
            "- Para espaçamento de linha em matrizes use \\\\[2pt] (duas barras + [2pt]).\n"
            "  IMPORTANTE: nunca coloque $ ou $$ perto de uma quebra de linha \\\\ ou \\\\[2pt].\n"
            "- Use índices como subscritos: a_{11}, x_1, b_2 (NÃO a{11} nem x1).\n"
            "- Use comandos LaTeX válidos: \\frac, \\tfrac, \\cdot, \\neq, \\approx, \\left, \\right.\n"
            "- NUNCA escreva algo como $$2pt] ou $$4pt] dentro de matrizes/cases.\n"
            "  Quebras de linha com espaçamento DEVEM ser \\\\[2pt] (duas barras invertidas).\n"
            "- Não indente os delimitadores $$: eles devem começar no início da linha (sem espaços).\n"
            "- Não coloque fórmulas dentro de blocos de código ```.\n"
        ),
    }
    return texts[code]


def build_messages(user_text: str, agent=None, lang_code: Optional[str] = None):
    """Chat v2: minimal message builder (one system message + history + user)."""
    ses = get_session(agent)
    history = ses.get("history", [])
    msgs = [{"role": "system", "content": system_prompt(agent, lang_code)}]
    msgs.extend(history)
    msgs.append({"role": "user", "content": user_text})
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
    base_path = str(BUNDLE_ROOT)
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
    base_path = str(BUNDLE_ROOT)
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
            "birth_year": data.get("birth_year"),
            "birthplace": pick("birthplace"),
            "nationality": pick("nationality"),
            "bio": pick("bio"),
        })
    return out
    
   # ===== SUPPORTERS =====
@app.get("/api/supporters")
def get_supporters(lang: Optional[str] = Query(default=None)):
    base_path = str(BUNDLE_ROOT)
    supp_path = os.path.join(base_path, "supporters.json")
    if not os.path.exists(supp_path):
        return { "order": [], "labels": {}, "items": [] }

    code = (lang or LANG_CODE)[:2].lower()
    with open(supp_path, "r", encoding="utf-8") as f:
        raw = json.load(f)

    order = raw.get("order", [])
    labels = raw.get("labels", {})
    items  = raw.get("items", [])

    # Localiza etiquetas de categorías
    loc_labels = {}
    for k, d in labels.items():
        if isinstance(d, dict):
            loc_labels[k] = d.get(code) or d.get("en") or next(iter(d.values()), k)
        else:
            loc_labels[k] = str(d)

    # Pasa descripciones localizadas
    out_items = []
    for it in items:
        desc = it.get("desc")
        if isinstance(desc, dict):
            it = { **it, "desc": desc.get(code) or desc.get("en") or next(iter(desc.values()), "") }
        out_items.append(it)

    return { "order": order, "labels": loc_labels, "items": out_items } 
    

# ===== KIWIX / WIKIPEDIA OFFLINE =====
KIWIX_ADDR = os.getenv("KIWIX_ADDR", "127.0.0.1")
KIWIX_PORT = int(os.getenv("KIWIX_PORT", "8080"))

# ============================================================
# HTTPX CLIENT GLOBAL PARA PROXY KIWIX (con keep-alive)
# ============================================================
import httpx

KIWIX_CLIENT = httpx.AsyncClient(
    follow_redirects=True,
    timeout=httpx.Timeout(20.0, read=None),
    limits=httpx.Limits(
        max_keepalive_connections=20,
        max_connections=100,
    ),
)

ZIM_PREFIXES = {
    "en": [
        "wikipedia_en_all_maxi",
        "wikipedia_en_all_nopic",
        "wikipedia_en_all_mini",
    ],
    "es": [
        "wikipedia_es_all_maxi",
        "wikipedia_es_all_nopic",
        "wikipedia_es_all_mini",
    ],
    "fr": [
        "wikipedia_fr_all_maxi",
        "wikipedia_fr_all_nopic",
        "wikipedia_fr_all_mini",
    ],
    "pt": [
        "wikipedia_pt_all_maxi",
        "wikipedia_pt_all_nopic",
        "wikipedia_pt_all_mini",
    ],
}

from pathlib import Path

def _zim_dir() -> Path:
    """
    Devuelve el directorio donde están los .zim.
    Usa KIWIX_CONTENT_DIR si existe; si no, intenta /kiwix/content bajo el bundle.
    """
    env_dir = os.getenv("KIWIX_CONTENT_DIR")
    if env_dir:
        return Path(env_dir).resolve()
    # Fallback: /kiwix/content junto al ejecutable / repo
    return (BUNDLE_ROOT / "kiwix" / "content").resolve()
    
from typing import Optional, List

def pick_zim_for_lang(lang_code: str) -> Optional[str]:
    """
    Elige el mejor fichero ZIM para un idioma.
    - Ignora la fecha / sufijo.
    - Busca por prefijos de ZIM_PREFIXES[lang].
    - Si hay varios, se queda con el lexicográficamente mayor (normalmente el más nuevo).
    Devuelve SOLO el nombre del archivo (no la ruta completa) o None si no encuentra nada.
    """
    lang_short = (lang_code or "en").split("-")[0].lower()
    prefixes: List[str] = ZIM_PREFIXES.get(lang_short, [])
    zim_dir = _zim_dir()

    if not zim_dir.is_dir():
        print(f"[kiwix] ZIM dir not found: {zim_dir}")
        return None

    for prefix in prefixes:
        pattern = prefix + "*.zim"
        candidates = sorted(zim_dir.glob(pattern))
        if candidates:
            # Nos quedamos con el “más grande” lexicográficamente (suele ser la fecha más reciente)
            chosen = candidates[-1]
            print(f"[kiwix] Selected ZIM for {lang_short}: {chosen.name}")
            return chosen.name

    print(f"[kiwix] No ZIM candidates found for lang={lang_short} in {zim_dir}")
    return None


def _zim_variant_from_name(fname: str) -> str:
    if "_maxi_" in fname: return "maxi"
    if "_nopic_" in fname: return "nopic"
    if "_mini_" in fname: return "mini"
    return "unknown"

def _kiwix_dirs():
    """
    Devuelve (kiwix_dir, content_dir, serve_exe).
    Orden de búsqueda:
      1) $KIWIX_CONTENT_DIR (si existe)
      2) $KIWIX_DIR/content (si existe)
      3) En “frozen”:  <exe>/../../kiwix/content  (p.ej. C:\\survivalai-phi4\\kiwix\\content)
      4) Bundled:      <exe>/kiwix/content        (dentro de dist\\SurvivalAI)
    """
    base_path = str(BUNDLE_ROOT)  # <exe>/... en frozen; repo root en desarrollo

    # 1) Overrides por variable de entorno
    env_content = os.getenv("KIWIX_CONTENT_DIR")
    if env_content and os.path.isdir(env_content):
        kiwix_dir = os.path.dirname(env_content)
        serve_exe = os.path.join(kiwix_dir, "kiwix-serve.exe")
        if not os.path.exists(serve_exe):
            serve_exe = os.path.join(base_path, "kiwix", "kiwix-serve.exe")
        return kiwix_dir, env_content, serve_exe

    env_dir = os.getenv("KIWIX_DIR")
    if env_dir:
        content_dir = os.path.join(env_dir, "content")
        if os.path.isdir(content_dir):
            serve_exe = os.path.join(env_dir, "kiwix-serve.exe")
            if not os.path.exists(serve_exe):
                serve_exe = os.path.join(base_path, "kiwix", "kiwix-serve.exe")
            return env_dir, content_dir, serve_exe

    # 2) En portable: prueba ruta externa ../../kiwix/content
    if getattr(sys, "frozen", False):
        ext_root = Path(base_path).parent.parent
        ext_kiwix = (ext_root / "kiwix").resolve()
        ext_content = (ext_kiwix / "content").resolve()
        if ext_content.is_dir():
            serve_exe = str(ext_kiwix / "kiwix-serve.exe")
            if not os.path.exists(serve_exe):
                serve_exe = os.path.join(base_path, "kiwix", "kiwix-serve.exe")
            return str(ext_kiwix), str(ext_content), serve_exe

    # 3) Bundled por defecto (dentro de dist)
    kiwix_dir = os.path.join(base_path, "kiwix")
    content_dir = os.path.join(kiwix_dir, "content")
    serve_exe = os.path.join(kiwix_dir, "kiwix-serve.exe")
    return kiwix_dir, content_dir, serve_exe

def _candidate_content_dirs() -> list[str]:
    dirs: list[str] = []
    env_content = os.getenv("KIWIX_CONTENT_DIR")
    if env_content and os.path.isdir(env_content):
        dirs.append(env_content)
    env_dir = os.getenv("KIWIX_DIR")
    if env_dir and os.path.isdir(os.path.join(env_dir, "content")):
        dirs.append(os.path.join(env_dir, "content"))
    if getattr(sys, "frozen", False):
        base = str(BUNDLE_ROOT)
        ext_root = Path(base).parent.parent
        dirs.append(str((ext_root / "kiwix" / "content").resolve()))
    dirs.append(str((Path(BUNDLE_ROOT) / "kiwix" / "content").resolve()))
    # normaliza + únicos existentes
    seen, out = set(), []
    for d in dirs:
        d = str(Path(d).resolve())
        if os.path.isdir(d) and d not in seen:
            seen.add(d); out.append(d)
    return out

def _find_first_existing_zim(lang: Optional[str]) -> tuple[str | None, str | None, str | None]:
    """
    Busca un ZIM para el idioma dado, ignorando la fecha del archivo.
    - Prioriza prefijos en este orden: maxi → nopic → mini (según ZIM_PREFIXES[code]).
    - Recorre todos los content_dir que devuelve _candidate_content_dirs().
    - Si no encuentra nada para el idioma, hace fallback a 'en'.
    Devuelve (ruta_completa, nombre_archivo, variante) o (None, None, None).
    """

    def _search_for_code(code: str) -> tuple[str | None, str | None, str | None]:
        prefixes = ZIM_PREFIXES.get(code, [])
        if not prefixes:
            return None, None, None

        for content_dir in _candidate_content_dirs():
            try:
                files = os.listdir(content_dir)
            except Exception:
                continue

            # Para cada prefijo (maxi → nopic → mini)
            for prefix in prefixes:
                prefix_lower = prefix.lower()
                matches = [
                    f for f in files
                    if f.lower().startswith(prefix_lower) and f.lower().endswith(".zim")
                ]
                if matches:
                    # Elegimos el lexicográficamente mayor (normalmente la fecha más reciente)
                    matches.sort()
                    fname = matches[-1]
                    full = os.path.join(content_dir, fname)
                    return full, fname, _zim_variant_from_name(fname)

        return None, None, None

    code = (lang or LANG_CODE)[:2].lower()

    # 1) Intento en el idioma solicitado
    zim_path, zim_file, variant = _search_for_code(code)
    if zim_path:
        return zim_path, zim_file, variant

    # 2) Fallback a inglés si no se ha encontrado nada
    if code != "en":
        return _search_for_code("en")

    return None, None, None
    
 # ===== DEBUG: ¿dónde está mirando Kiwix? =====
@app.get("/api/wiki/where")
def wiki_where(lang: Optional[str] = Query(default=None)):
    kiwix_dir, content_dir, serve_exe = _kiwix_dirs()
    return {
        "bundle_root": str(BUNDLE_ROOT),
        "kiwix_dir": kiwix_dir,
        "content_dir": content_dir,
        "serve_exe_exists": os.path.exists(serve_exe),
        "content_exists": os.path.isdir(content_dir),
        "files": sorted(os.listdir(content_dir)) if os.path.isdir(content_dir) else []
    }

# === Estado de Kiwix para evitar respawns
KIWIX_STATE = {"proc": None, "zim": None}

def _kiwix_is_running() -> bool:
    p = KIWIX_STATE["proc"]
    return p is not None and p.poll() is None

@app.get("/api/wiki")
def open_wiki(lang: Optional[str] = Query(default=None)):
    zim_path, zim_file, variant = _find_first_existing_zim(lang)
    code = (lang or LANG_CODE)[:2].lower()

    if not zim_path:
        prefixes = ZIM_PREFIXES.get(code) or ZIM_PREFIXES.get("en", [])
        expected = [f"{p}*.zim" for p in prefixes]
        return {
            "status": "missing",
            "message": (
                f"No ZIM found for '{code}'. "
                "Place one of these files into /kiwix/content/ (in this priority order):"
            ),
            "candidates": expected,
            "howto": (
                "Download your preferred ZIM (maxi/nopic/mini) for that language "
                "and copy it to kiwix/content. Then call /api/wiki again."
            ),
        }

    kiwix_dir, content_dir, serve_exe = _kiwix_dirs()
    if not os.path.exists(serve_exe):
        return {
            "status": "error",
            "message": f"kiwix-serve.exe not found at {serve_exe}. Include it in the project (offline installer/USB)."
        }

    # 🔒 Si ya está corriendo con ese mismo ZIM, no lo relances
    if _kiwix_is_running() and KIWIX_STATE["zim"] == zim_path:
        return {
            "status": "ok",
            "message": f"Kiwix already running for {zim_file} ({variant}) on http://{KIWIX_ADDR}:{KIWIX_PORT}",
            "zim_file": zim_file,
            "variant": variant,
            "lang": code
        }

    # Si hay un proceso distinto, ciérralo con cuidado (sin barrer todos los kiwix-serve del sistema)
    if _kiwix_is_running():
        try:
            KIWIX_STATE["proc"].terminate()
        except Exception:
            pass

    import socket, time, subprocess as _sp, psutil as _ps
    proc = _sp.Popen([serve_exe, zim_path, "--port", str(KIWIX_PORT), "--address", KIWIX_ADDR])

    # Eleva prioridad (Windows) para que responda más ágil
    try:
        _ps.Process(proc.pid).nice(_ps.HIGH_PRIORITY_CLASS)
    except Exception:
        pass

    # Espera a que abra el puerto
    for _ in range(60):
        try:
            with socket.create_connection((KIWIX_ADDR, KIWIX_PORT), timeout=0.25):
                break
        except Exception:
            time.sleep(0.25)

    KIWIX_STATE["proc"] = proc
    KIWIX_STATE["zim"]  = zim_path

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

    candidates = []
    if os.path.isdir(content_dir):
        try:
            files = os.listdir(content_dir)
        except Exception:
            files = []

        prefix_base = f"wikipedia_{code}_"
        for fname in files:
            lower = fname.lower()
            if lower.startswith(prefix_base) and lower.endswith(".zim"):
                p = os.path.join(content_dir, fname)
                exists = os.path.exists(p)
                size = os.path.getsize(p) if exists else 0
                candidates.append({
                    "file": fname,
                    "variant": _zim_variant_from_name(fname),
                    "exists": exists,
                    "size_bytes": size,
                })

    return {
        "lang": code,
        "content_dir": content_dir,
        "candidates": candidates,
        "all_files": sorted(os.listdir(content_dir)) if os.path.isdir(content_dir) else [],
    }

# ===== TAXONOMIES (catalog + trees) =====
from pathlib import Path as _Path
import json as _json

TAXO_DIR = (BUNDLE_ROOT / "frontend" / "taxonomies").resolve()
CATALOG_FILE = (TAXO_DIR / "index.json").resolve()

def _safe_taxo_file(name: str, ext: str = ".json") -> _Path:
    p = (TAXO_DIR / f"{name}{ext}").resolve()
    if not str(p).startswith(str(TAXO_DIR)):
        raise HTTPException(status_code=404, detail="Not found")
    return p

@app.get("/api/taxonomy/catalog")
def taxonomy_catalog():
    if not CATALOG_FILE.exists():
        items = []
        if TAXO_DIR.exists():
            for f in TAXO_DIR.glob("*.json"):
                if f.name == "index.json":
                    continue
                items.append({
                    "id": f.stem,
                    "title": f.stem.capitalize(),
                    "description": ""
                })
        return {"items": items}
    with open(CATALOG_FILE, "r", encoding="utf-8") as fh:
        return _json.load(fh)

@app.get("/api/taxonomy/{tree_id}")
def taxonomy_tree(tree_id: str):
    f = _safe_taxo_file(tree_id)
    if not f.exists():
        raise HTTPException(status_code=404, detail="taxonomy not found")
    with open(f, "r", encoding="utf-8") as fh:
        return _json.load(fh)


# ============================================================
# PROXY OPTIMIZADO PARA KIWIX (usa cliente global con keep-alive)
# ============================================================
@app.api_route("/proxy/wiki/{path:path}", methods=["GET", "POST"])
async def proxy_wiki(path: str, request: Request):
    """
    Proxy hacia kiwix-serve, usando el cliente HTTPX global (keep-alive)
    y reescribiendo los enlaces HTML para que apunten a /proxy/wiki/content/...
    en lugar de /content/... directamente.
    """
    # URL interna hacia kiwix-serve (ej: 127.0.0.1:8080)
    url = f"http://{KIWIX_ADDR}:{KIWIX_PORT}/{path}"

    # Copiamos headers salvo Host (que suele dar guerra si se reenvía)
    headers = {k: v for k, v in request.headers.items() if k.lower() != "host"}
    params = dict(request.query_params)

    try:
        # GET o POST según el método original
        if request.method == "POST":
            body = await request.body()
            upstream = await KIWIX_CLIENT.post(
                url,
                content=body,
                headers=headers,
                params=params,
            )
        else:
            upstream = await KIWIX_CLIENT.get(
                url,
                headers=headers,
                params=params,
            )
    except Exception as e:
        return PlainTextResponse(f"Error proxying to Kiwix: {e}", status_code=502)

    # Headers que NO debemos reenviar tal cual
    excluded_headers = {
        "content-encoding",
        "transfer-encoding",
        "connection",
        "content-length",
        "x-frame-options",
        "content-security-policy",
    }

    response_headers = {
        k: v for k, v in upstream.headers.items()
        if k.lower() not in excluded_headers
    }

    content_type = upstream.headers.get("content-type", "") or ""
    lower_ct = content_type.lower()

    # 🔧 Si es HTML, reescribimos los enlaces /content/... -> /proxy/wiki/content/...
    if "text/html" in lower_ct:
        html = upstream.text

        # Prefijo público de nuestro proxy (el mismo que usas en script.js)
        proxy_prefix = "/proxy/wiki"

        # Reescribimos href/src que apuntan a /content/...
        for attr in ("href", "src"):
            # 1) Rutas relativas a la raíz del servidor
            html = html.replace(
                f'{attr}="/content/',
                f'{attr}="{proxy_prefix}/content/'
            )
            html = html.replace(
                f"{attr}='/content/",
                f"{attr}='{proxy_prefix}/content/"
            )

            # 2) Por si Kiwix mete URLs absolutas con host+puerto
            for port in ("8000", "8080"):
                html = html.replace(
                    f'{attr}="http://127.0.0.1:{port}/content/',
                    f'{attr}="{proxy_prefix}/content/'
                )
                html = html.replace(
                    f"{attr}='http://127.0.0.1:{port}/content/",
                    f"{attr}='{proxy_prefix}/content/"
                )

        # Devolvemos HTML ya reescrito
        # Dejamos que FastAPI calcule el content-length correcto
        media_type = content_type.split(";")[0] if content_type else "text/html"
        return Response(
            content=html,
            status_code=upstream.status_code,
            headers=response_headers,
            media_type=media_type,
        )

    # 🔁 Para cualquier otro tipo de contenido (imágenes, CSS, ZIM chunks…) usamos streaming
    return StreamingResponse(
        upstream.aiter_bytes(),
        status_code=upstream.status_code,
        headers=response_headers,
    )


# ===== STATIC PMTILES (byte-serving con Range) =====
from fastapi import Request, HTTPException
import re

# /frontend/assets/maps
MAPS_DIR = (BUNDLE_ROOT / "frontend" / "assets" / "maps").resolve()

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
DOCS_ROOT = (BUNDLE_ROOT / "docs").resolve()
MEDIA_ROOT = (BUNDLE_ROOT / "media").resolve()

# 🗑️ Papelera (trash)
TRASH_ROOT       = (BUNDLE_ROOT / "trash").resolve()
TRASH_DOCS_ROOT  = (TRASH_ROOT / "docs").resolve()
TRASH_MEDIA_ROOT = (TRASH_ROOT / "media").resolve()

# 🔄 Marker para detectar otras instancias de Offlined en otros discos
SYNC_MARKER_NAME = ".offlined_sync"

# Creamos un pequeño marker de texto en docs/ y media/ de ESTA instancia
for _root in (DOCS_ROOT, MEDIA_ROOT):
    try:
        marker_path = (_root / SYNC_MARKER_NAME).resolve()
        if not marker_path.exists():
            marker_path.write_text(
                "OFFLINED_SYNC_MARKER\nThis folder belongs to an Offlined installation.\n",
                encoding="utf-8"
            )
    except Exception as e:
        print("[sync] Warning: could not create marker in", _root, "->", e)


# Crear carpetas de papelera si no existen
TRASH_DOCS_ROOT.mkdir(parents=True, exist_ok=True)
TRASH_MEDIA_ROOT.mkdir(parents=True, exist_ok=True)

WHITEBOARD_JSON_DIR = (MEDIA_ROOT / "whiteboard-json").resolve()
PAINT_IMAGES_DIR   = (MEDIA_ROOT / "images" / "Paint Image Files").resolve()

# 📂 Archivos genéricos en media/files
FILES_DIR = (MEDIA_ROOT / "files").resolve()

# 🧰 Apps portables en media/portable_apps
PORTABLE_APPS_DIR = (MEDIA_ROOT / "portable_apps").resolve()
PORTABLE_APPS_ICONS_DIR = (PORTABLE_APPS_DIR / ".icons").resolve()

# 📅 Calendario en media/calendar
CALENDAR_DIR  = (MEDIA_ROOT / "calendar").resolve()
CALENDAR_FILE = (CALENDAR_DIR / "calendar_events.json").resolve()

# 🗒️ Bloc de notas en media/notebook (nota = 1 fichero JSON)
NOTEBOOK_DIR  = (MEDIA_ROOT / "notebook").resolve()

# 🎙️ Notas de audio en media/music/Audio Recordings
AUDIO_NOTES_DIR = (MEDIA_ROOT / "music" / "Audio Recordings").resolve()

# ⭐ Favoritos de mapas en media/locations
LOCATIONS_DIR  = (MEDIA_ROOT / "locations").resolve()
LOCATIONS_FILE = (LOCATIONS_DIR / "favorites.json").resolve()

for _d in (WHITEBOARD_JSON_DIR, PAINT_IMAGES_DIR, CALENDAR_DIR, NOTEBOOK_DIR, AUDIO_NOTES_DIR, LOCATIONS_DIR, PORTABLE_APPS_DIR, PORTABLE_APPS_ICONS_DIR):
    _d.mkdir(parents=True, exist_ok=True)

class WhiteboardSavePayload(BaseModel):
    name: Optional[str] = None
    pngDataUrl: str
    excalidraw: Dict[str, Any]


def _lib_safe_path(rel_path: Optional[str]) -> Path:
    """Normaliza y asegura que la ruta quede dentro de DOCS_ROOT."""
    rel = (rel_path or "").strip().lstrip("/\\")
    candidate = (DOCS_ROOT / rel).resolve()
    if not str(candidate).startswith(str(DOCS_ROOT)):
        raise HTTPException(status_code=400, detail="Invalid path")
    return candidate

def _media_safe_path(sub: str, rel_path: Optional[str]) -> Path:
    """
    Normaliza y asegura que la ruta quede dentro de MEDIA_ROOT/<sub>,
    donde sub ∈ {"video","music","images","files"}.
    """
    sub = (sub or "").strip().lower()
    if sub not in {"video", "music", "images", "files", "portable_apps"}:
        raise HTTPException(status_code=400, detail="Invalid media subroot")

    rel = (rel_path or "").strip().lstrip("/\\")
    base = (MEDIA_ROOT / sub)
    candidate = (base / rel).resolve()
    if not str(candidate).startswith(str(base.resolve())):
        raise HTTPException(status_code=400, detail="Invalid path")

    return candidate
    
def _move_docs_to_trash(path: str) -> None:
    """Mueve un archivo o carpeta de DOCS_ROOT a TRASH_DOCS_ROOT."""
    src = _lib_safe_path(path)
    if not src.exists():
        raise HTTPException(status_code=404, detail="Not found")

    # No permitir borrar la raíz de docs
    if src.resolve() == DOCS_ROOT.resolve():
        raise HTTPException(status_code=400, detail="Cannot delete docs root")

    rel = src.relative_to(DOCS_ROOT)
    dest = (TRASH_DOCS_ROOT / rel).resolve()
    dest.parent.mkdir(parents=True, exist_ok=True)

    # Evitar sobrescribir algo ya existente en la papelera
    if dest.exists():
        stem = dest.stem
        suffix = dest.suffix
        ts = int(time.time())
        dest = dest.with_name(f"{stem}_trashed_{ts}{suffix}")

    shutil.move(str(src), str(dest))

def _move_media_to_trash(sub: str, path: str) -> None:
    """Mueve un archivo o carpeta de MEDIA_ROOT/sub a TRASH_MEDIA_ROOT/sub."""
    src = _media_safe_path(sub, path)
    if not src.exists():
        raise HTTPException(status_code=404, detail="Not found")

    root = (MEDIA_ROOT / sub).resolve()
    if src.resolve() == root:
        raise HTTPException(status_code=400, detail="Cannot delete media root")

    rel = src.relative_to(root)
    dest = (TRASH_MEDIA_ROOT / sub / rel).resolve()
    dest.parent.mkdir(parents=True, exist_ok=True)

    if dest.exists():
        stem = dest.stem
        suffix = dest.suffix
        ts = int(time.time())
        dest = dest.with_name(f"{stem}_trashed_{ts}{suffix}")

    shutil.move(str(src), str(dest))


# ========================
# 📅 API CALENDARIO (JSON)
# ========================

@app.get("/api/calendar/events")
async def get_calendar_events() -> List[Dict[str, Any]]:
    """
    Devuelve la lista de eventos de calendario almacenados en
    media/calendar/calendar_events.json.
    Formato esperado: [ {id,title,start,end,allDay}, ... ]
    """
    if not CALENDAR_FILE.exists():
        return []
    try:
        with CALENDAR_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return data
        return []
    except Exception as e:
        print("[CAL] Error leyendo calendario:", e)
        # En caso de JSON corrupto, devolvemos lista vacía
        return []


@app.post("/api/calendar/events")
async def save_calendar_events(events: List[Any]):
    """
    Sobrescribe el fichero media/calendar/calendar_events.json con la lista
    de eventos recibida desde el frontend.
    """
    try:
        with CALENDAR_FILE.open("w", encoding="utf-8") as f:
            json.dump(events, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print("[CAL] Error guardando calendario:", e)
        raise HTTPException(status_code=500, detail="Could not save calendar events")
    return {"ok": True, "count": len(events)}
    
# =========================
# 🗺️ API MAPS FAVORITES (JSON)
# =========================

def _load_maps_favorites():
    """Devuelve favoritos en formato {folders:[], items:[]} (retrocompatible)."""
    if not LOCATIONS_FILE.exists():
        return {"folders": [], "items": []}

    try:
        with LOCATIONS_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return {"folders": [], "items": []}

    # Si el archivo viejo era una lista simple → convertir
    if isinstance(data, list):
        items = []
        for idx, f in enumerate(data):
            if not isinstance(f, dict):
                continue
            items.append({
                "id": f.get("id") or f"fav_{idx}",
                "name": f.get("name", ""),
                "lat": f.get("lat"),
                "lon": f.get("lon"),
                "zoom": f.get("zoom", 10),
                "folderId": f.get("folderId")  # normalmente None
            })
        return {"folders": [], "items": items}

    folders = data.get("folders") or []
    items   = data.get("items") or []

    # Normalizar ids
    for idx, it in enumerate(items):
        if not isinstance(it, dict):
            continue
        it.setdefault("id", f"fav_{idx}")
        it.setdefault("folderId", None)

    for idx, fld in enumerate(folders):
        if not isinstance(fld, dict):
            continue
        fld.setdefault("id", f"fld_{idx}")

    return {"folders": folders, "items": items}


def _save_maps_favorites(payload: dict):
    """Guarda favoritos en formato {folders:[], items:[]}."""
    if not isinstance(payload, dict):
        raise ValueError("Invalid maps favorites payload")

    folders = payload.get("folders") or []
    items   = payload.get("items") or []

    LOCATIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOCATIONS_FILE.open("w", encoding="utf-8") as f:
        json.dump(
            {"folders": folders, "items": items},
            f,
            ensure_ascii=False,
            indent=2
        )

@app.get("/api/maps/favorites")
async def get_map_favorites():
    """
    Devuelve favoritos en formato:
      { "folders": [...], "items": [...] }
    Retrocompatible con el formato antiguo (lista simple).
    """
    return _load_maps_favorites()


@app.post("/api/maps/favorites")
async def save_map_favorites(payload: Dict[str, Any]):
    """
    Sobrescribe el fichero de favoritos con el objeto completo
    { "folders": [...], "items": [...] }.
    """
    try:
      _save_maps_favorites(payload)
      items = payload.get("items") or []
      return {"ok": True, "count": len(items)}
    except Exception as e:
      print("[MAPS] Error guardando favoritos:", e)
      raise HTTPException(status_code=500, detail="Could not save map favorites")



# =========================
# 🎙️ API AUDIO NOTES (webm en media/music/Audio Recordings)
# =========================

def _audio_meta_file_for_id(note_id: str) -> Path:
  note_id = (note_id or "").strip()
  if not note_id or not re.match(r"^[A-Za-z0-9._-]+$", note_id):
      raise HTTPException(status_code=400, detail="Invalid audio note id")
  f = (AUDIO_NOTES_DIR / f"{note_id}.json").resolve()
  if not str(f).startswith(str(AUDIO_NOTES_DIR)):
      raise HTTPException(status_code=400, detail="Invalid audio note path")
  return f

def _audio_file_for_id(note_id: str) -> Path:
  note_id = (note_id or "").strip()
  if not note_id or not re.match(r"^[A-Za-z0-9._-]+$", note_id):
      raise HTTPException(status_code=400, detail="Invalid audio file id")
  f = (AUDIO_NOTES_DIR / f"{note_id}.webm").resolve()
  if not str(f).startswith(str(AUDIO_NOTES_DIR)):
      raise HTTPException(status_code=400, detail="Invalid audio file path")
  return f
  
def _audio_slug_for_title(title: str, fallback: str) -> str:
  """
  Genera un nombre de fichero seguro a partir del título de la nota.
  - Quita acentos
  - Reemplaza caracteres raros por "_"
  - Evita rutas fuera de AUDIO_NOTES_DIR
  """
  base = (title or "").strip()
  if not base:
      base = fallback

  # Quitar acentos
  s = unicodedata.normalize("NFD", base)
  s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")

  # Solo letras/números/puntos/guiones/guion_bajo
  s = re.sub(r"[^A-Za-z0-9._-]+", "_", s)

  # Evitar todo vacío
  s = s.strip("._-") or fallback
  return s


@app.get("/api/audio/notes")
async def list_audio_notes() -> List[Dict[str, Any]]:
  notes: List[Dict[str, Any]] = []
  if not AUDIO_NOTES_DIR.exists():
      return []
  for meta_path in AUDIO_NOTES_DIR.glob("*.json"):
      try:
          with meta_path.open("r", encoding="utf-8") as f:
              data = json.load(f)
      except Exception:
          continue
      note_id = data.get("id") or meta_path.stem
      title   = data.get("title") or "Untitled recording"
      file    = data.get("file") or f"music/Audio Recordings/{note_id}.webm"
      created = data.get("created_at")
      updated = data.get("updated_at") or created
      notes.append({
          "id": note_id,
          "title": title,
          "file": file,
          "created_at": created,
          "updated_at": updated
      })
  notes.sort(key=lambda n: n.get("updated_at") or n.get("created_at") or 0, reverse=True)
  return notes

@app.post("/api/audio/note")
async def save_audio_note(
    id: Optional[str] = Form(None),
    title: str = Form(""),
    file: UploadFile = File(...)
) -> Dict[str, Any]:
  """
  Guarda una nota de audio en:
    media/music/Audio Recordings/<slug_del_titulo>.webm

  El `id` sigue siendo el identificador lógico de la nota (para el frontend),
  pero el nombre físico del fichero se basa en el título.
  """
  now_ts = int(time.time())
  note_id = str(id or now_ts)
  title   = (title or "").strip() or "Untitled recording"

  meta_path = _audio_meta_file_for_id(note_id)

  # Leer metadata previa (si existe) para conservar created_at
  created_at = now_ts
  old_file_rel: Optional[str] = None
  if meta_path.exists():
      try:
          with meta_path.open("r", encoding="utf-8") as f:
              existing = json.load(f)
          created_at = existing.get("created_at", created_at)
          old_file_rel = existing.get("file")
      except Exception:
          pass

  # Nuevo nombre de fichero basado en el título
  slug = _audio_slug_for_title(title, note_id)
  audio_path = (AUDIO_NOTES_DIR / f"{slug}.webm").resolve()
  if not str(audio_path).startswith(str(AUDIO_NOTES_DIR)):
      raise HTTPException(status_code=400, detail="Invalid audio file path")

  # Guardar audio webm
  try:
      contents = await file.read()
      with audio_path.open("wb") as f:
          f.write(contents)
  except Exception as e:
      print("[AUDIO] Error guardando fichero:", e)
      raise HTTPException(status_code=500, detail="Could not save audio file")

  # Si el fichero viejo es distinto, se puede limpiar para evitar huérfanos
  if old_file_rel:
      try:
          old_name = Path(old_file_rel).name
          old_path = (AUDIO_NOTES_DIR / old_name).resolve()
          if old_path != audio_path and old_path.exists() and str(old_path).startswith(str(AUDIO_NOTES_DIR)):
              old_path.unlink()
      except Exception as e:
          print("[AUDIO] Aviso: no se pudo limpiar audio antiguo:", e)

  meta = {
      "id": note_id,
      "title": title,
      "file": f"music/Audio Recordings/{slug}.webm",
      "created_at": created_at,
      "updated_at": now_ts
  }
  try:
      with meta_path.open("w", encoding="utf-8") as f:
          json.dump(meta, f, ensure_ascii=False, indent=2)
  except Exception as e:
      print("[AUDIO] Error guardando metadata:", e)
      raise HTTPException(status_code=500, detail="Could not save audio metadata")

  return meta


@app.delete("/api/audio/note")
async def delete_audio_note(id: str = Query(..., description="audio note id")) -> Dict[str, Any]:
  """
  Borra la metadata JSON de la nota y el fichero .webm asociado.
  Para las notas nuevas, el fichero se determina a partir de meta["file"].
  Para notas antiguas (compatibilidad), se intenta también <id>.webm.
  """
  meta_path = _audio_meta_file_for_id(id)

  removed_meta  = False
  removed_audio = False

  # 1) Borrar metadata si existe
  meta_data: Optional[Dict[str, Any]] = None
  if meta_path.exists():
      try:
          with meta_path.open("r", encoding="utf-8") as f:
              meta_data = json.load(f)
      except Exception:
          meta_data = None

      try:
          meta_path.unlink()
          removed_meta = True
      except Exception as e:
          print("[AUDIO] Error borrando metadata:", e)

  # 2) Determinar ruta del audio a partir de meta["file"]
  audio_path: Optional[Path] = None
  if meta_data:
      file_rel = meta_data.get("file")
      if file_rel:
          # meta["file"] suele ser "music/Audio Recordings/xxx.webm"
          name = Path(file_rel).name
          candidate = (AUDIO_NOTES_DIR / name).resolve()
          if str(candidate).startswith(str(AUDIO_NOTES_DIR)):
              audio_path = candidate

  # 3) Compatibilidad: si no la hemos podido determinar, intentamos <id>.webm
  if audio_path is None:
      try:
          audio_path = _audio_file_for_id(id)
      except HTTPException:
          audio_path = None

  # 4) Borrar audio si tenemos ruta válida
  if audio_path is not None and audio_path.exists():
      try:
          audio_path.unlink()
          removed_audio = True
      except Exception as e:
          print("[AUDIO] Error borrando audio:", e)

  if not (removed_meta or removed_audio):
      raise HTTPException(status_code=404, detail="Audio note not found")

  return {"ok": True, "id": id, "meta_deleted": removed_meta, "audio_deleted": removed_audio}


# =========================
# 🗒️ API BLOC DE NOTAS (JSON por nota)
# =========================

def _notebook_file_for_id(note_id: str) -> Path:
    """
    Devuelve la ruta segura media/notebook/<note_id>.json
    y valida que el id no tenga cosas raras.
    """
    note_id = (note_id or "").strip()
    # Permitimos letras, números, guiones, guion bajo y punto
    if not note_id or not re.match(r"^[A-Za-z0-9._-]+$", note_id):
        raise HTTPException(status_code=400, detail="Invalid note id")
    f = (NOTEBOOK_DIR / f"{note_id}.json").resolve()
    if not str(f).startswith(str(NOTEBOOK_DIR)):
        raise HTTPException(status_code=400, detail="Invalid note path")
    return f


@app.get("/api/notebook/notes")
async def get_notebook_notes() -> List[Dict[str, Any]]:
    """
    Devuelve SOLO el listado de notas (metadatos) para la barra lateral.
    Formato: [ { "id": str, "title": str }, ... ]
    """
    notes: List[Dict[str, Any]] = []
    if not NOTEBOOK_DIR.exists():
        return notes

    for ent in sorted(NOTEBOOK_DIR.glob("*.json"), key=lambda p: p.name.lower()):
        try:
            with ent.open("r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            continue
        note_id = str(data.get("id") or ent.stem)
        title   = str(data.get("title") or ent.stem)
        notes.append({"id": note_id, "title": title})

    return notes


@app.get("/api/notebook/note")
async def get_notebook_note(id: str = Query(..., description="note id")) -> Dict[str, Any]:
    """
    Devuelve el contenido completo de una nota:
    { id, title, delta, created_at, updated_at }
    """
    f = _notebook_file_for_id(id)
    if not f.exists():
        raise HTTPException(status_code=404, detail="Note not found")
    try:
        with f.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception as e:
        print("[NOTES] Error leyendo nota:", e)
        raise HTTPException(status_code=500, detail="Could not read note")

    # Aseguramos campos básicos
    data.setdefault("id", id)
    data.setdefault("title", "Untitled")
    data.setdefault("delta", {"ops": []})
    return data


@app.post("/api/notebook/note")
async def save_notebook_note(note: Dict[str, Any]) -> Dict[str, Any]:
    """
    Crea o actualiza una nota.
    Body esperado: { id?, title, delta }
    Si id no viene, se genera uno nuevo.
    """
    now_ts = int(time.time())
    note_id = str(note.get("id") or now_ts)
    title   = (note.get("title") or "Untitled").strip() or "Untitled"
    delta   = note.get("delta") or {"ops": []}

    f = _notebook_file_for_id(note_id)

    created_at = now_ts
    if f.exists():
        # Si ya existe, conservamos created_at si lo teníamos
        try:
            with f.open("r", encoding="utf-8") as fh:
                existing = json.load(fh)
            created_at = existing.get("created_at", created_at)
        except Exception:
            pass

    data_to_save = {
        "id": note_id,
        "title": title,
        "delta": delta,
        "created_at": created_at,
        "updated_at": now_ts,
    }

    try:
        with f.open("w", encoding="utf-8") as fh:
            json.dump(data_to_save, fh, ensure_ascii=False, indent=2)
    except Exception as e:
        print("[NOTES] Error guardando nota:", e)
        raise HTTPException(status_code=500, detail="Could not save note")

    return data_to_save


@app.delete("/api/notebook/note")
async def delete_notebook_note(id: str = Query(..., description="note id")) -> Dict[str, Any]:
    """
    Elimina una nota (borra media/notebook/<id>.json).
    """
    f = _notebook_file_for_id(id)
    if not f.exists():
        raise HTTPException(status_code=404, detail="Note not found")
    try:
        f.unlink()
    except Exception as e:
        print("[NOTES] Error borrando nota:", e)
        raise HTTPException(status_code=500, detail="Could not delete note")
    return {"ok": True, "id": id}

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

        desc = None
        if sub == "portable_apps" and base.suffix.lower() == ".exe":
            try:
                desc = _exe_file_description(base)
            except Exception:
                desc = None

        return {
            "path": path or "",
            "parent": _norm_rel(base.parent),
            "dirs": [],
            "files": [{
                "name": base.name,
                "rel":  _norm_rel(base),
                "size": base.stat().st_size,
                "mime": mime or "application/octet-stream",
                "ext":  (base.suffix or "").lstrip(".").lower(),
                "desc": desc,
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

@app.delete("/api/library/delete")
def library_delete(path: str = Query(..., description="Ruta relativa dentro de docs")):
    """
    Mueve un archivo o carpeta dentro de /docs a la papelera (trash/docs).
    Si es carpeta, se mueve recursivamente.
    """
    _move_docs_to_trash(path)
    return {"status": "ok", "trashed": True}

# === Servir archivos de la LIBRERÍA (docs/) ===
@app.get("/api/library/file")
def library_file(
    path: str = Query(..., description="ruta relativa dentro de docs/"),
    disposition: Optional[str] = Query("inline"),
):
    file_path = _lib_safe_path(path)
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    mime, _ = mimetypes.guess_type(str(file_path))
    resp = FileResponse(
        path=str(file_path),
        media_type=mime or "application/octet-stream",
        filename=file_path.name
    )
    # inline para visualizar en el visor (iframe); attachment para descargar
    resp.headers["Content-Disposition"] = (
        f'inline; filename="{file_path.name}"'
        if (disposition or "inline") == "inline"
        else f'attachment; filename="{file_path.name}"'
    )
    return resp

@app.post("/api/library/upload")
async def library_upload(
    path: str = Form(""),
    file: UploadFile = File(...)
):
    """
    Sube un archivo a docs/<path>.
    path: ruta relativa dentro de docs/ (state.library.path en el frontend).
    """
    base_dir = _lib_safe_path(path)
    if base_dir.is_file():
        base_dir = base_dir.parent

    raw_name = file.filename or "uploaded-file"
    safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", raw_name).strip("._") or "uploaded-file"

    base_dir.mkdir(parents=True, exist_ok=True)
    dest = (base_dir / safe_name).resolve()

    # Última defensa: seguir dentro de DOCS_ROOT
    if not str(dest).startswith(str(DOCS_ROOT)):
        raise HTTPException(status_code=400, detail="Invalid upload path")

    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    rel = str(dest.relative_to(DOCS_ROOT)).replace("\\", "/")
    return {"status": "ok", "name": dest.name, "rel": rel}


@app.post("/api/library/mkdir")
def library_mkdir(
    path: str = Form(""),
    name: str = Form(...)
):
    """
    Crea una carpeta docs/<path>/<name>.
    """
    parent_dir = _lib_safe_path(path)

    safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", name).strip("._")
    if not safe_name:
        raise HTTPException(status_code=400, detail="Invalid folder name")

    target = (parent_dir / safe_name).resolve()
    if not str(target).startswith(str(DOCS_ROOT)):
        raise HTTPException(status_code=400, detail="Invalid folder path")

    target.mkdir(parents=False, exist_ok=True)
    rel = str(target.relative_to(DOCS_ROOT)).replace("\\", "/")
    return {"status": "ok", "name": safe_name, "rel": rel}

@app.get("/api/media/list")
def media_list(
    sub: str = Query(..., description="video|music|images|files"),
    path: Optional[str] = Query(default="")
):
    """
    Lista directorios/archivos a partir de /media/<sub>.
    Devuelve { path, parent, dirs:[{name,rel}], files:[{name,rel,size,mime,ext}] }
    """
    base = _media_safe_path(sub, path)
    if not base.exists():
        raise HTTPException(status_code=404, detail="Path not found")

    def _norm_rel(p: Path) -> str:
        ROOT = (MEDIA_ROOT / sub).resolve()
        return str(p.resolve()).replace(str(ROOT), "").replace("\\", "/").lstrip("/")

    if base.is_file():
        mime, _ = mimetypes.guess_type(str(base))
        return {
            "path": path or "",
            "parent": _norm_rel(base.parent),
            "dirs": [],
            "files": [{
                "name": base.name,
                "rel":  _norm_rel(base),
                "size": base.stat().st_size,
                "mime": mime or "application/octet-stream",
                "ext":  (base.suffix or "").lstrip(".").lower()
            }]
        }

    dirs, files = [], []
    for entry in base.iterdir():
        try:
            # 🧰 Portable Apps: solo carpetas + .exe (y ocultamos la cache .icons)
            if sub == "portable_apps":
                if entry.is_dir() and entry.name == ".icons":
                    continue
                if entry.is_file() and entry.suffix.lower() != ".exe":
                    continue
            if entry.is_dir():
                dirs.append({"name": entry.name, "rel": _norm_rel(entry)})
            elif entry.is_file():
                mime, _ = mimetypes.guess_type(str(entry))

                # ✅ aquí va esto:
                desc = None
                if sub == "portable_apps" and entry.suffix.lower() == ".exe":
                    try:
                        desc = _exe_file_description(entry)
                    except Exception:
                        desc = None

                files.append({
                    "name": entry.name,
                    "rel":  _norm_rel(entry),
                    "size": entry.stat().st_size,
                    "mime": mime or "application/octet-stream",
                    "ext":  (entry.suffix or "").lstrip(".").lower(),

                    # ✅ y aquí va esto:
                    "desc": desc,
                })
        except Exception:
            continue

    parent = _norm_rel(base.parent) if base != (MEDIA_ROOT / sub) else ""
    # Ordena por nombre (dirs y files)
    dirs.sort(key=lambda d: d["name"].lower())
    files.sort(key=lambda f: f["name"].lower())

    return {"path": path or "", "parent": parent, "dirs": dirs, "files": files}

@app.get("/api/sync/media/list")
def sync_media_list(
    peer: str = Query(..., description="peer id (ruta de la carpeta _internal del otro Offlined)"),
    sub: str = Query(..., description="video|music|images|files"),
    path: Optional[str] = Query(default="")
):
    """
    Lista directorios/archivos a partir de media/<sub> de OTRA instancia Offlined.
    Devuelve el mismo formato que /api/media/list para reaprovechar estilos:
      { path, parent, dirs:[{name,rel}], files:[{name,rel,size,mime,ext}] }
    """
    if sub not in ("video", "music", "images", "files"):
        raise HTTPException(status_code=400, detail="Invalid sub")

    peer_root = _resolve_peer_root(peer)
    if not peer_root:
        raise HTTPException(status_code=404, detail="Peer not found")

    base_root = (peer_root / "media" / sub).resolve()

    # Normalizamos el path relativo
    rel = (path or "").replace("\\", "/").lstrip("/")

    target = (base_root / rel).resolve()
    if not str(target).startswith(str(base_root)):
        raise HTTPException(status_code=400, detail="Invalid path")

    def _norm_rel(p: Path) -> str:
        return str(p.resolve()).replace(str(base_root), "").replace("\\", "/").lstrip("/")

    if target.is_file():
        mime, _ = mimetypes.guess_type(str(target))
        return {
            "path": rel,
            "parent": _norm_rel(target.parent) if target.parent != base_root else "",
            "dirs": [],
            "files": [{
                "name": target.name,
                "rel": _norm_rel(target),
                "size": target.stat().st_size,
                "mime": mime or "application/octet-stream",
                "ext": (target.suffix or "").lstrip(".").lower(),
            }]
        }

    dirs: List[Dict[str, str]] = []
    files: List[Dict[str, str]] = []

    try:
        for entry in target.iterdir():
            try:
                if entry.is_dir():
                    dirs.append({
                        "name": entry.name,
                        "rel": _norm_rel(entry)
                    })
                elif entry.is_file():
                    mime, _ = mimetypes.guess_type(str(entry))
                    files.append({
                        "name": entry.name,
                        "rel": _norm_rel(entry),
                        "size": entry.stat().st_size,
                        "mime": mime or "application/octet-stream",
                        "ext": (entry.suffix or "").lstrip(".").lower(),
                    })
            except Exception:
                continue
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Path not found")

    parent = _norm_rel(target.parent) if target != base_root else ""
    dirs.sort(key=lambda d: d["name"].lower())
    files.sort(key=lambda f: f["name"].lower())

    return {"path": rel, "parent": parent, "dirs": dirs, "files": files}

class SyncMediaImportPayload(BaseModel):
    peer: str                 # id del peer (ruta _internal)
    sub: str                  # video|music|images|files
    paths: List[str]          # rutas relativas dentro de media/<sub> del peer


@app.post("/api/sync/media/import")
def sync_media_import(payload: SyncMediaImportPayload):
    if payload.sub not in ("video", "music", "images", "files"):
        raise HTTPException(status_code=400, detail="Invalid sub")

    peer_root = _resolve_peer_root(payload.peer)
    if not peer_root:
        raise HTTPException(status_code=404, detail="Peer not found")

    src_root = (peer_root / "media" / payload.sub).resolve()
    dst_root = (MEDIA_ROOT / payload.sub).resolve()

    imported: List[str] = []

    for rel in payload.paths:
        if not rel:
            continue

        # Sanitizar un poco el relativo
        safe_rel = rel.replace("\\", "/").lstrip("/")
        if ".." in safe_rel:
            continue

        src = (src_root / safe_rel).resolve()
        if not str(src).startswith(str(src_root)) or not src.is_file():
            continue

        dst = (dst_root / safe_rel).resolve()
        dst.parent.mkdir(parents=True, exist_ok=True)

        # Si ya existe, generamos "nombre (1).ext", "nombre (2).ext", etc.
        final_dst = dst
        if final_dst.exists():
            stem = dst.stem
            suffix = dst.suffix
            counter = 1
            while final_dst.exists():
                final_dst = dst.with_name(f"{stem} ({counter}){suffix}")
                counter += 1

        shutil.copy2(src, final_dst)

        imported.append(
            str(final_dst.relative_to(dst_root)).replace("\\", "/")
        )

    return {"status": "ok", "imported": imported}

@app.get("/api/trash/list")
def trash_list(path: Optional[str] = Query(default="")):
    """
    Lista TODOS los archivos que hay en la papelera (trash/) en plano,
    sin carpetas, similar a la Papelera de Windows.

    Devuelve:
      - dirs: siempre []
      - files: lista de archivos con:
          name      → nombre del archivo
          path      → ruta relativa dentro de trash (ej: "docs/carpeta/archivo.txt")
          original  → ruta original a la que volverá (ej: "docs/carpeta")
          size, mime, ext → info básica
    """
    root = TRASH_ROOT
    if not root.exists():
        return {"path": "", "parent": "", "dirs": [], "files": []}

    def _norm(p: Path) -> str:
        return str(p).replace("\\", "/")

    files: List[Dict[str, Any]] = []

    # Recorremos recursivamente todo trash/
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        if p.name.startswith("."):
            # Omitir dotfiles si no los quieres ver
            continue

        rel = p.relative_to(root)               # ej: docs/Notas/archivo.txt
        rel_str = _norm(rel)
        parts = rel.parts

        original_location = ""

        if parts and parts[0] == "docs":
            # docs / [subcarpetas...] / archivo
            # Queremos algo tipo: "docs" o "docs/Notas/2025"
            if len(parts) > 2:
                # hay subcarpetas
                original_location = "docs/" + _norm(Path(*parts[1:-1]))
            else:
                # archivo directamente en docs/
                original_location = "docs"
        elif parts and parts[0] == "media":
            # media / sub / [subcarpetas...] / archivo
            # Queremos algo tipo: "media/images/Vacaciones"
            if len(parts) >= 2:
                sub = parts[1]  # video|music|images|files
                base_str = f"media/{sub}"
                if len(parts) > 3:
                    original_location = base_str + "/" + _norm(Path(*parts[2:-1]))
                else:
                    original_location = base_str
            else:
                original_location = "media"
        else:
            # por si en el futuro hay algo más
            original_location = "/"

        mime, _ = mimetypes.guess_type(str(p))
        files.append({
            "name": p.name,
            "path": rel_str,                 # ruta tal y como espera trash_restore
            "original": original_location,   # ruta donde volvería
            "size": p.stat().st_size,
            "mime": mime or "application/octet-stream",
            "ext": p.suffix.lower()
        })

    # Devolvemos siempre una lista plana
    return {
        "path": "",
        "parent": "",
        "dirs": [],
        "files": files
    }

from typing import List, Dict, Optional
from pathlib import Path
import psutil  # ya lo tienes importado arriba

def _find_offlined_peers() -> List[Dict[str, str]]:
    """
    Busca otras instalaciones de Offlined en otros discos.

    Asume la estructura:
      <letra>:/offlined/_internal/docs
      <letra>:/offlined/_internal/media

    y que en esos docs/media existe el marker .offlined_sync
    """
    peers: List[Dict[str, str]] = []

    this_root = BUNDLE_ROOT.resolve()
    try:
        this_drive = this_root.drive  # en Windows, por ej. 'C:\\'
    except Exception:
        this_drive = None

    try:
        partitions = psutil.disk_partitions(all=False)
    except Exception as e:
        print("[sync] disk_partitions error:", e)
        return []

    for part in partitions:
        try:
            mount = Path(part.mountpoint).resolve()
        except Exception:
            continue

        # En Windows, evitamos escanear la misma unidad de esta instancia
        if this_drive and hasattr(mount, "drive"):
            try:
                if mount.drive.lower() == this_drive.lower():
                    continue
            except Exception:
                pass

        # Heurística: buscamos <unidad>/offlined/_internal
        candidate_internal = (mount / "offlined" / "_internal").resolve()
        docs_dir = (candidate_internal / "docs").resolve()
        media_dir = (candidate_internal / "media").resolve()

        # Marcadores
        marker_docs  = (docs_dir / SYNC_MARKER_NAME)
        marker_media = (media_dir / SYNC_MARKER_NAME)

        if candidate_internal.exists() and (
            marker_docs.exists() or marker_media.exists()
        ):
            try:
                peers.append({
                    "id": str(candidate_internal),
                    "label": f"{mount} · offlined",
                    "docs_root": str(docs_dir),
                    "media_root": str(media_dir),
                })
            except Exception:
                continue

    return peers


def _resolve_peer_root(peer_id: str) -> Optional[Path]:
    """
    Devuelve la ruta _internal de un peer a partir de su id (ruta absoluta).
    """
    try:
        requested = Path(peer_id).resolve()
    except Exception:
        return None

    for peer in _find_offlined_peers():
        try:
            if Path(peer["id"]).resolve() == requested:
                return Path(peer["id"]).resolve()
        except Exception:
            continue
    return None

from fastapi import Query

@app.get("/api/sync/peers")
def sync_peers():
    """
    Devuelve las otras instancias de Offlined detectadas en otros discos.
    Formato: { peers: [{id, label, docs_root, media_root}, ...] }
    """
    peers = _find_offlined_peers()
    return {"peers": peers}

@app.post("/api/trash/restore")
def trash_restore(payload: Dict[str, str]):
    """
    Restaura un archivo/carpeta desde la papelera a su ubicación original.

    Espera JSON:
      { "path": "docs/lo/que/sea.txt" }
      { "path": "media/video/mi_video.mp4" }
    """
    rel = (payload.get("path") or "").strip()
    if not rel:
        raise HTTPException(status_code=400, detail="Missing trash path")

    src = (TRASH_ROOT / rel).resolve()
    if not str(src).startswith(str(TRASH_ROOT)) or not src.exists():
        raise HTTPException(status_code=404, detail="Trash item not found")

    parts = Path(rel).parts
    if not parts:
        raise HTTPException(status_code=400, detail="Invalid trash path")

    # docs → DOCS_ROOT
    if parts[0] == "docs":
        restore_root = DOCS_ROOT
        dest_rel = Path(*parts[1:]) if len(parts) > 1 else Path("restored")
    # media → MEDIA_ROOT/<sub>
    elif parts[0] == "media":
        if len(parts) < 2:
            raise HTTPException(status_code=400, detail="Invalid media trash path")
        sub = parts[1]
        restore_root = (MEDIA_ROOT / sub).resolve()
        dest_rel = Path(*parts[2:]) if len(parts) > 2 else Path("restored")
    else:
        raise HTTPException(status_code=400, detail="Unknown trash root")

    dest = (restore_root / dest_rel).resolve()
    dest.parent.mkdir(parents=True, exist_ok=True)

    # Si ya existe, renombrar
    if dest.exists():
        stem = dest.stem
        suffix = dest.suffix
        ts = int(time.time())
        dest = dest.with_name(f"{stem}_restored_{ts}{suffix}")

    shutil.move(str(src), str(dest))

    return {
        "status": "ok",
        "restored_to": str(dest_rel).replace("\\", "/")
    }

@app.delete("/api/trash/delete")
def trash_delete(path: str = Query(..., description="ruta relativa dentro de trash")):
    """
    Elimina definitivamente un archivo o carpeta de la papelera.
    """
    target = (TRASH_ROOT / path).resolve()
    if not str(target).startswith(str(TRASH_ROOT)) or not target.exists():
        raise HTTPException(status_code=404, detail="Trash item not found")

    try:
        if target.is_dir():
            shutil.rmtree(target)
        else:
            target.unlink()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Permanent delete failed: {e}")

    return {"status": "ok", "deleted": True}

@app.post("/api/media/open")
def media_open(
    sub: str = Query(..., description="video|music|images|files|portable_apps"),
    path: str = Query(..., description="ruta relativa dentro del subárbol")
):
    """
    Abre un archivo usando el programa por defecto del sistema.
    Windows: os.startfile(); macOS: open; Linux: xdg-open.
    """
    target = _media_safe_path(sub, path)
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    try:
        if sys.platform.startswith("win"):
            os.startfile(str(target))  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(target)])
        else:
            subprocess.Popen(["xdg-open", str(target)])
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Open failed: {e}")

    return {"status": "ok"}

# ===== PORTABLE APPS (icons) ==============================================

def _portable_icon_cache_path(exe_file: Path) -> Path:
    """Cache PNG filename based on path+mtime+size (stable, avoids re-extract)."""
    try:
        st = exe_file.stat()
        sig = f"{st.st_mtime_ns}_{st.st_size}"
    except Exception:
        sig = str(time.time_ns())

    key = hashlib.sha1((str(exe_file.resolve()) + "|" + sig).encode("utf-8", errors="ignore")).hexdigest()
    return (PORTABLE_APPS_ICONS_DIR / f"{key}.png").resolve()

def _extract_exe_icon_to_png(exe_file: Path, out_png: Path) -> bool:
    """Extract Windows associated icon to PNG using PowerShell (System.Drawing)."""
    if not sys.platform.startswith("win"):
        return False
    try:
        PORTABLE_APPS_ICONS_DIR.mkdir(parents=True, exist_ok=True)

        ps = (
            "Add-Type -AssemblyName System.Drawing; "
            f"$exe='{str(exe_file)}'; $png='{str(out_png)}'; "
            "$ic=[System.Drawing.Icon]::ExtractAssociatedIcon($exe); "
            "if ($ic -eq $null) { exit 2 }; "
            "$bmp=$ic.ToBitmap(); "
            "$bmp.Save($png,[System.Drawing.Imaging.ImageFormat]::Png); "
            "$bmp.Dispose(); $ic.Dispose();"
        )

        r = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
            capture_output=True,
            text=True,
        )
        return r.returncode == 0 and out_png.exists()
    except Exception as e:
        print("[portable_apps] icon extract failed:", e)
        return False

PORTABLE_APPS_DESC_CACHE = {}

def _exe_file_description(exe_file: Path) -> Optional[str]:
    if not sys.platform.startswith("win"):
        return None

    try:
        st = exe_file.stat()
        cache_key = f"{exe_file.resolve()}|{st.st_mtime_ns}|{st.st_size}"
        if cache_key in PORTABLE_APPS_DESC_CACHE:
            return PORTABLE_APPS_DESC_CACHE[cache_key]

        ps = (
            f"$p='{str(exe_file)}'; "
            "$vi=(Get-Item -LiteralPath $p).VersionInfo; "
            "$d=$vi.FileDescription; "
            "if ($d -eq $null) { $d='' }; "
            "Write-Output $d;"
        )

        r = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
            capture_output=True,
            text=True,
        )

        desc = (r.stdout or "").strip()
        if not desc:
            desc = None

        PORTABLE_APPS_DESC_CACHE[cache_key] = desc
        return desc
    except Exception as e:
        print("[portable_apps] description failed:", e)
        return None


@app.get("/api/portable_apps/icon")
def portable_apps_icon(path: str = Query(..., description="ruta relativa dentro de media/portable_apps")):
    """Devuelve un PNG con el icono del .exe (cacheado)."""
    exe_path = _media_safe_path("portable_apps", path)
    if not exe_path.exists() or not exe_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    if exe_path.suffix.lower() != ".exe":
        raise HTTPException(status_code=400, detail="Not an .exe")

    out_png = _portable_icon_cache_path(exe_path)
    if not out_png.exists():
        ok = _extract_exe_icon_to_png(exe_path, out_png)
        if not ok:
            raise HTTPException(status_code=404, detail="Icon not available")

    resp = FileResponse(path=str(out_png), media_type="image/png")
    resp.headers.setdefault("Cache-Control", "public, max-age=31536000, immutable")
    return resp

from starlette.responses import StreamingResponse

@app.get("/api/media/file")
def media_file(
    request: Request,
    sub: str = Query(..., description="video|music|images|files"),
    path: str = Query(...),
    disposition: Optional[str] = Query("inline"),
):
    file_path = _media_safe_path(sub, path)
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    size = file_path.stat().st_size
    mime, _ = mimetypes.guess_type(str(file_path))
    media_type = mime or "application/octet-stream"

    # Content-Disposition (inline para visor / attachment para descargar)
    content_disp = (
        f'inline; filename="{file_path.name}"'
        if (disposition or "inline") == "inline"
        else f'attachment; filename="{file_path.name}"'
    )

    range_header = request.headers.get("range")
    if range_header:
        # Reutiliza tu helper si ya lo tienes; si no, implementa uno equivalente.
        start, end = _parse_range(range_header, size)  # end inclusive
        if start is None or end is None:
            raise HTTPException(status_code=416, detail="Invalid Range")

        length = (end - start) + 1

        def _iter():
            with open(file_path, "rb") as fp:
                fp.seek(start)
                remaining = length
                chunk = 1024 * 1024  # 1MB
                while remaining > 0:
                    data = fp.read(min(chunk, remaining))
                    if not data:
                        break
                    remaining -= len(data)
                    yield data

        headers = {
            "Content-Type": media_type,
            "Content-Range": f"bytes {start}-{end}/{size}",
            "Content-Length": str(length),
            "Accept-Ranges": "bytes",
            "Content-Disposition": content_disp,
            # cache opcional (puedes quitarlo si no quieres)
            "Cache-Control": "public, max-age=31536000, immutable",
        }
        return StreamingResponse(_iter(), status_code=206, headers=headers)

    # Sin Range → 200 normal, PERO anunciando Accept-Ranges para que el navegador sepa que puede pedirlo
    resp = FileResponse(
        path=str(file_path),
        media_type=media_type,
        filename=file_path.name
    )
    resp.headers["Accept-Ranges"] = "bytes"
    resp.headers["Content-Disposition"] = content_disp
    resp.headers.setdefault("Cache-Control", "public, max-age=31536000, immutable")
    return resp

@app.post("/api/media/upload")
async def media_upload(
    sub: str = Form(...),
    path: str = Form(""),
    file: UploadFile = File(...)
):
    """
    Sube un archivo a media/<sub>/<path>.
    sub: "video" | "music" | "images" | "files"
    path: ruta relativa dentro de ese sub (state.library.path).
    """
    base_dir = _media_safe_path(sub, path)
    if base_dir.is_file():
        base_dir = base_dir.parent

    raw_name = file.filename or "uploaded-file"
    safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", raw_name).strip("._") or "uploaded-file"

    base_dir.mkdir(parents=True, exist_ok=True)
    dest = (base_dir / safe_name).resolve()

    root = (MEDIA_ROOT / sub).resolve()
    if not str(dest).startswith(str(root)):
        raise HTTPException(status_code=400, detail="Invalid upload path")

    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    rel = str(dest.relative_to(root)).replace("\\", "/")
    return {"status": "ok", "name": dest.name, "rel": rel}

@app.delete("/api/media/delete")
def media_delete(
    sub: str = Query(..., description="video|music|images|files"),
    path: str = Query(..., description="ruta relativa dentro del subárbol")
):
    """
    Mueve un archivo o carpeta dentro de media/<sub> a la papelera
    (trash/media/<sub>). Si es carpeta, se mueve recursivamente.
    """
    _move_media_to_trash(sub, path)
    return {"status": "ok", "trashed": True}

@app.post("/api/media/move")
def media_move(payload: Dict[str, str]):
    """
    Mueve un archivo o carpeta dentro de media/<sub>.

    El frontend envía un JSON:
      {
        "base":    "media/music" | "media/video" | "media/images",
        "path":    "ruta/origen/relativa",
        "newPath": "ruta/destino/relativa"  # carpeta destino (puede ser "")
      }
    """
    base = (payload.get("base") or "").strip()
    src_rel = (payload.get("path") or "").strip()
    dst_rel = (payload.get("newPath") or "").strip()

    if not base or not src_rel:
        raise HTTPException(status_code=400, detail="Missing base or path")

    # base viene como "media/music" → extraemos "music"
    if not base.startswith("media/"):
        raise HTTPException(status_code=400, detail="Invalid media base")
    sub = base.split("/", 1)[1].strip().lower()
    if sub not in {"video", "music", "images", "files"}:
        raise HTTPException(status_code=400, detail="Invalid media subroot")

    # Ruta origen absoluta (dentro de MEDIA_ROOT/sub)
    src_path = _media_safe_path(sub, src_rel)

    # newPath es la carpeta destino relativa (puede ser "" = raíz del sub)
    dest_dir = _media_safe_path(sub, dst_rel or "")

    if not dest_dir.exists() or not dest_dir.is_dir():
        raise HTTPException(status_code=400, detail="Destination is not a directory")

    root = (MEDIA_ROOT / sub).resolve()

    # Destino final: misma basename pero dentro de dest_dir
    target = (dest_dir / src_path.name).resolve()
    if not str(target).startswith(str(root)):
        raise HTTPException(status_code=400, detail="Invalid destination path")

    # Si origen y destino son iguales → nada que hacer
    if src_path.resolve() == target:
        rel = str(src_path.relative_to(root)).replace("\\", "/")
        return {"status": "ok", "name": src_path.name, "rel": rel}

    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        src_path.replace(target)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Move failed: {e}")

    rel = str(target.relative_to(root)).replace("\\", "/")
    return {"status": "ok", "name": target.name, "rel": rel}


@app.post("/api/media/mkdir")
def media_mkdir(
    sub: str = Form(...),
    path: str = Form(""),
    name: str = Form(...)
):
    """
    Crea una carpeta media/<sub>/<path>/<name>.
    """
    parent_dir = _media_safe_path(sub, path)

    safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", name).strip("._")
    if not safe_name:
        raise HTTPException(status_code=400, detail="Invalid folder name")

    target = (parent_dir / safe_name).resolve()
    root = (MEDIA_ROOT / sub).resolve()
    if not str(target).startswith(str(root)):
        raise HTTPException(status_code=400, detail="Invalid folder path")

    target.mkdir(parents=False, exist_ok=True)
    rel = str(target.relative_to(root)).replace("\\", "/")
    return {"status": "ok", "name": safe_name, "rel": rel}

@app.post("/api/whiteboard/save")
def whiteboard_save(payload: WhiteboardSavePayload):
    # Nombre base seguro para archivos
    raw_name = payload.name or f"drawing-{int(time.time())}"
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", raw_name).strip("._")
    if not safe:
        safe = f"drawing-{int(time.time())}"

    # Decodificar PNG desde data URL
    data_url = payload.pngDataUrl or ""
    if "," in data_url:
        _, b64 = data_url.split(",", 1)
    else:
        b64 = data_url

    try:
        png_bytes = base64.b64decode(b64)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid PNG data URL")

    # Guardar PNG en media/images/Paint Image Files
    png_filename = f"{safe}.png"
    png_path = (PAINT_IMAGES_DIR / png_filename).resolve()
    with open(png_path, "wb") as f:
        f.write(png_bytes)

    # Guardar JSON .excalidraw en media/whiteboard-json
    json_filename = f"{safe}.excalidraw.json"
    json_path = (WHITEBOARD_JSON_DIR / json_filename).resolve()
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(payload.excalidraw, f, ensure_ascii=False)

    return {
        "status": "ok",
        "pngFile": png_filename,
        "jsonFile": json_filename,
    }

@app.get("/api/whiteboard/load")
def whiteboard_load(file: str = Query(...)):
    # Normalizar y evitar path traversal
    name = (file or "").strip().lstrip("/\\")
    target = (WHITEBOARD_JSON_DIR / name).resolve()
    if not str(target).startswith(str(WHITEBOARD_JSON_DIR)) or not target.is_file():
        raise HTTPException(status_code=404, detail="Whiteboard file not found")

    with open(target, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data

# ===== UTILIDADES =====

def extract_final_text(text: str) -> str:
    if not text:
        return ""

    t = str(text)

    # Caso 1: bloque final estilo tokens
    marker = "<|channel|>final"
    if marker in t:
        t = t.split(marker, 1)[1]
        msg_marker = "<|message|>"
        if msg_marker in t:
            t = t.split(msg_marker, 1)[1]

    # Caso 2: reglas tipo "FINAL ANSWER ONLY:"
    if "FINAL ANSWER ONLY:" in t:
        t = t.split("FINAL ANSWER ONLY:", 1)[1]

    # Limpieza de tokens basura
    junk = [
        "<|end|>", "<|start|>", "<|assistant|>", "<|user|>", "<|system|>",
        "<|message|>", "<|channel|>", "<|final|>", "<|analysis|>"
    ]
    for j in junk:
        t = t.replace(j, "")

    return t.strip()

def completion_autocontinue(
    llm,
    prompt: str,
    gen_kw: dict,
    stop_seqs: list,
    max_calls: int,
    chunk_tokens: int,
) -> str:
    """
    Auto-continue para llama.cpp en modo COMPLETION:
    - llama al modelo por "trozos" (chunk_tokens)
    - si finish_reason == "length", concatena y sigue
    - si finish_reason == "stop" (u otro), termina
    """
    if not prompt:
        return ""

    full_raw = ""
    cur_prompt = prompt

    for _ in range(max_calls):
        kw = dict(gen_kw)
        kw["max_tokens"] = int(chunk_tokens)

        out = llm(cur_prompt, stop=stop_seqs, **kw)

        piece = (out.get("choices") or [{}])[0].get("text", "") or ""
        full_raw += piece

        finish = (out.get("choices") or [{}])[0].get("finish_reason", "") or ""

        # Si no ha cortado por límite de tokens, hemos terminado
        if finish != "length":
            break

        # Continuamos desde donde lo dejó: añadimos el texto generado al prompt
        cur_prompt += piece

        # Si por lo que sea no generó nada, evitamos bucle infinito
        if not piece.strip():
            break

    return full_raw


# ===== CHAT =====
@app.post("/api/chat")
def chat(payload: dict):
    user_msg = str(payload.get("message", "")).strip()
    if not user_msg:
        code = (payload.get("lang") or LANG_CODE or "en")[:2].lower()
        msg = {
            "es": "Dime algo para poder ayudarte.",
            "fr": "Dis-moi quelque chose pour que je puisse t’aider.",
            "pt": "Diga algo para que eu possa ajudar.",
            "en": "Tell me something so I can help.",
        }.get(code, "Tell me something so I can help.")
        return {"response": msg}

    lang = payload.get("lang")
    agent = payload.get("agent")

    # 1) Construir mensajes
    msgs = build_messages(user_text=user_msg, agent=agent, lang_code=lang)

    # 2) Detectar encartha (sin cambios)
    try:
        nm = (agent or {}).get("name", "") or ""
        role = (agent or {}).get("role", "") or ""
        is_encartha = bool(re.search(r"michael\s+encartha", nm, flags=re.I) or role == "wiki-encartha")
    except Exception:
        is_encartha = False

    # 3) Tokens dinámicos
    dyn_max = _dynamic_max_tokens(msgs)
    gen_kw = dict(GEN_KW)
    gen_kw["max_tokens"] = dyn_max

    try:
        # ===== GENERACIÓN =====

        prompt = build_harmony_prompt(msgs, lang_code=lang)

        stop_seqs = [
            "<|end|>",
            "<|start|>user",
            "<|start|>system",
            "<|start|>developer",
        ]

        if AUTO_CONTINUE_ENABLED:
            # trozos: no más de lo disponible en contexto
            chunk_tokens = min(int(AUTO_CONTINUE_CHUNK_TOKENS), int(dyn_max))

            raw = completion_autocontinue(
                llm=llm,
                prompt=prompt,
                gen_kw=gen_kw,
                stop_seqs=stop_seqs,
                max_calls=int(AUTO_CONTINUE_MAX_CALLS),
                chunk_tokens=int(chunk_tokens),
            )
        else:
            out = llm(prompt, stop=stop_seqs, **gen_kw)
            raw = out["choices"][0]["text"]

        # 5) 🔒 FILTRO ANTI-REASONING (AQUÍ, Y SOLO AQUÍ)
        final = extract_final_text(raw)
        final = strip_reasoning(final)
        final = clean_answer(final, lang)

        # 6) 🛟 Fallback si el modelo solo "pensó"
        if not final.strip():
            final = "[No answer generated]"

    except ValueError:
        code = (lang or LANG_CODE or "en")[:2].lower()
        msg_map = {
            "es": "⚠️ Se alcanzó el límite de contexto del modelo. Reinicia la conversación.",
            "fr": "⚠️ La fenêtre de contexte du modèle a été atteinte. Réinitialisez la conversation.",
            "pt": "⚠️ O limite de contexto do modelo foi atingido. Reinicie a conversa.",
            "en": "⚠️ The model’s context window was reached. Please reset the conversation.",
        }
        return {"response": msg_map.get(code, msg_map["en"]), "meta": {"error": "context_overflow"}}

    # ===== A PARTIR DE AQUÍ SOLO SE USA `final` =====
    answer_md = clean_answer(final)

    # Resolver idioma (para futuras cosas; aquí no forzamos estilos)
    lang = _resolve_lang(lang, user_msg)

    # Persistencia del historial (guardamos SOLO texto “puro”)
    ses = get_session(agent)
    ses["history"].append({"role": "user", "content": user_msg})
    ses["history"].append({"role": "assistant", "content": answer_md})

    if len(ses["history"]) > 60:
        ses["history"] = ses["history"][-60:]

    # “Vanilla”: sin meta, sin tarjetas, sin linkify, sin wikilinks
    return {"response": answer_md}



@app.post("/api/reset")
def reset_conversation():
    global sessions; sessions = {}
    return {"status":"ok","message":"Conversation history cleared"}


# ===== MÉTRICAS DEL SISTEMA (CPU/RAM/TEMP/BATERÍA) =====
@app.get("/api/metrics")
def metrics():
    import psutil
    from pathlib import Path
    import sys

    out = {
        "cpu": psutil.cpu_percent(interval=None),   # 0–100
        "ram": psutil.virtual_memory().percent,     # 0–100
        "temp_c": None,                             # puede ser None si no hay sensores
        "battery": None,                            # {percent, plugged} o None
        "disk": None,                               # lo rellenamos abajo
    }

    # Temperaturas (no siempre disponible en Windows)
    try:
        temps = psutil.sensors_temperatures(fahrenheit=False) or {}
        vals = []
        for arr in temps.values():
            for t in arr:
                if t.current is not None:
                    vals.append(t.current)
        if vals:
            out["temp_c"] = max(vals)
    except Exception:
        pass

    # Batería (si existe)
    try:
        b = psutil.sensors_battery()
        if b is not None:
            out["battery"] = {
                "percent": (b.percent or 0),
                "plugged": bool(b.power_plugged)
            }
    except Exception:
        pass

    # Disco donde está la app
    try:
        # Si estás congelado con PyInstaller, sys.executable es el .exe;
        # si no, usamos este propio fichero.
        base_path = Path(getattr(sys, "frozen", False) and sys.executable or __file__).resolve()
        # En Windows, .anchor será "C:\", "D:\", etc. En Linux, "/".
        root = base_path.anchor or str(base_path)
        du = psutil.disk_usage(root)

        out["disk"] = {
            "root": root,           # p.ej. "C:\"
            "total": du.total,      # bytes
            "used": du.used,        # bytes
            "free": du.free,        # bytes
            "percent": du.percent,  # 0–100
        }
    except Exception:
        out["disk"] = None

    return out
    
    
# === Servir el frontend (HTML/CSS/JS) ===
# Lo montamos al final para no interferir con /api/* ni con /assets/maps (PMTiles).
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="app")

# === Lanzador con ventana nativa (pywebview) ===
def _run_server_in_thread(host="127.0.0.1", port=8000):
    import threading, uvicorn
    def _serve():
        uvicorn.run(app, host=host, port=port, log_level="info")
    # NO daemon → si el principal termina, este hilo mantiene el proceso vivo
    # NO daemon: así el proceso no termina si _start_ui() devuelve
    t = threading.Thread(target=_serve, daemon=False)
    t.start()
    return t

def _start_ui(url) -> bool:
    import webbrowser, time
    time.sleep(0.8)
    webbrowser.open(url)
    return False


if __name__ == "__main__":
    host, port = "127.0.0.1", 8000
    t = _run_server_in_thread(host, port)
    import time
    time.sleep(0.8)  # respiro corto para que Uvicorn abra el socket
    _blocked = _start_ui(f"http://{host}:{port}/")
    # Si _start_ui() no bloquea (sin pywebview), mantenemos vivo el proceso:
    try:
        t.join()
    except KeyboardInterrupt:
        pass
        
@app.on_event("shutdown")
async def _close_kiwix_client():
    try:
        await KIWIX_CLIENT.aclose()
    except Exception:
        pass
