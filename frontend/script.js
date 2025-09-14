// ===== CONFIG =====
const BASE_URL = "http://127.0.0.1:8000";
const MODELS = [
  { file: "phi-4-mini-instruct-q4_k_m.gguf", label: "Phi-4 Mini" }
];

const MAP_ATTR = '© <a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a> · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
// Kiwix local (si cambias puerto/dirección en backend, refleja aquí)
const KIWIX_ORIGIN = "http://127.0.0.1:8080";

const SUPPORTED_LANGS = {
  en: { label: "English",  flag: "🇬🇧" },
  es: { label: "Español",  flag: "🇪🇸" },
  fr: { label: "Français", flag: "🇫🇷" }
};

let state = {
  mode: "llm",
  modelFile: MODELS[0].file,
  agents: [],
  categories: [],
  selectedAgent: null,
  selectedCategory: null,
  typing: false,
  lang: "en",
  lang_label: "English",
  lang_flag: "🇬🇧",

  // 🧵 Hilos locales por vista
  chats: {
    model: [],        // [{role:"user"|"bot", text:String, __html?:true}]
    agents: {}        // {"Name|Personality": [ ... ]}
  },

  // 🔗 Cache de enlaces wiki por mensaje (para re-decorar en re-render)
  // { "<threadId>": { <msgIndex>: [{term, title}, ...] } }
  wikiLinks: {},

  // 📚 Cache de existencia de artículos: { "zimId|Title_Enc": boolean }
  wikiExist: {},

  // 🏷️ Cache de título canónico
  wikiCanon: {},

  // 🗂️ Control de Wikipedia
  wiki: { started: false, url: "", zimId: null, pendingUrl: null },

  // 📚 Librería (docs/)
  library: { path: "", items: [], root: "" },

  // 🧷 Scroll por hilo
  scroll: {}  ,        // { "model": number, "agent:Name|Persona": number }
  recentAgents: []
};

// ===== MAPS (offline) =====
let _map = null;
let _pmproto = null;
let _mapReady = false;

// 👇 nuevas: recuerda el pmtiles y la primera capa detectada
let _pmtilesUrl = null;
let _vecLayerId = null;

// Convierte rutas relativas -> URL absoluta (mismo origen)
function absUrl(rel) {
  return new URL(rel.replace(/^\.?\//, ''), window.location.href).toString();
}

function ensureMapCanvas(){
  const mapsView = document.getElementById('mapsView');
  if (!mapsView) return null;
  let canvas = document.getElementById('map-canvas');
  if (!canvas){
    canvas = document.createElement('div');
    canvas.id = 'map-canvas';
    canvas.style.display = 'none';   // lo mostramos solo si todo va bien
    mapsView.appendChild(canvas);
  }
  return canvas;
}

// --- Helpers de estilo offline + parcheo de pmtiles:// ---
function getAppTheme(){
  return (document.documentElement.getAttribute("data-theme") || "light") === "dark" ? "dark" : "light";
}

function absolutizeAsset(u){
  if (!u) return u;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("/")) return `${BASE_URL}${u}`;         // p.ej. "/assets/..." → "http://127.0.0.1:8000/assets/..."
  return `${BASE_URL}/${u.replace(/^\.\//,'')}`;           // "./assets/..." → absoluto
}

async function loadLocalStyleAndPatch(pmtilesFileName = "planet.pmtiles") {
  const theme = getAppTheme();
  const styleUrl = `/assets/maps/styles/protomaps-${theme}.json`;
  const style = await (await fetch(styleUrl)).json();

  // Fuerza el .pmtiles a ir por tu backend
  const pmtilesAbs = `pmtiles://${BASE_URL}/assets/maps/${pmtilesFileName}`;
  
  for (const k of Object.keys(style.sources || {})) {
    const s = style.sources[k];
if (s && s.type === "vector") {
  s.url = pmtilesAbs;
  s.attribution = MAP_ATTR;   // ✅ así la AttributionControl recogerá el texto
}
  }

  // 🔧 sprite/glyphs ABSOLUTOS Y LOCALES (imprescindible si style = objeto)
  const defaultSpriteBase = `${BASE_URL}/assets/maps/basemaps-assets/sprites/v4/${theme}`;
  const defaultGlyphs     = `${BASE_URL}/assets/maps/basemaps-assets/fonts/{fontstack}/{range}.pbf`;

  style.sprite = style.sprite ? absolutizeAsset(style.sprite) : defaultSpriteBase;
  style.glyphs = style.glyphs ? absolutizeAsset(style.glyphs) : defaultGlyphs;

  return style;
}


// Fallback mínimo para PMTiles que NO sean el basemap de Protomaps
async function buildMinimalStyle(httpUrl) {
  let vecLayer = null;
  try {
    const meta = await new pmtiles.PMTiles(httpUrl).getMetadata();
    vecLayer = meta?.vector_layers?.[0]?.id || null;
  } catch {}

  const isDark = getAppTheme() === "dark";
  return {
    version: 8,
    sources: { basemap: { type: "vector", url: `pmtiles://${httpUrl}`, attribution: MAP_ATTR } },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": isDark ? "#0b0f14" : "#f7f5f0" } },
      ...(vecLayer ? [
        { id: "layer-fill", type: "fill", source: "basemap", "source-layer": vecLayer,
          paint: { "fill-color": isDark ? "#3b4756" : "#c7d9ff", "fill-opacity": 0.6 } },
        { id: "layer-line", type: "line", source: "basemap", "source-layer": vecLayer,
          paint: { "line-color": isDark ? "#93a3b5" : "#4966a3", "line-width": 0.5 } }
      ] : [])
    ]
  };
}

// Recarga el estilo del mapa al cambiar el tema (conservando cámara)
async function reloadMapStyleForTheme(pmtilesFileName = "planet.pmtiles"){
  if (!_map) return;

  const httpUrl = `${BASE_URL}/assets/maps/${pmtilesFileName}`;

  // 1) guarda la cámara para no “saltar”
  const center  = _map.getCenter();
  const zoom    = _map.getZoom();
  const pitch   = _map.getPitch();
  const bearing = _map.getBearing();

  try {
    // Detecta si el .pmtiles parece ser “basemap” Protomaps (capas típicas)
    let meta = null;
    try { meta = await new pmtiles.PMTiles(httpUrl).getMetadata(); } catch {}
    const names = new Set((meta?.vector_layers || []).map(l => l.id));
    const isProtomaps = ["water","roads","landuse","boundaries"].some(n => names.has(n));

    const style = isProtomaps
      ? await loadLocalStyleAndPatch(pmtilesFileName) // <- ya la tienes
      : await buildMinimalStyle(httpUrl);

    // 2) cambia el style sin recrear y sin diff (evita parpadeos inesperados)
    _map.setStyle(style, { diff: false });

  } catch {
    const fallback = await buildMinimalStyle(httpUrl);
    _map.setStyle(fallback, { diff: false });
  }

  // 3) cuando el style está listo, restaura la cámara
  _map.once("styledata", () => {
    try { _map.jumpTo({ center, zoom, pitch, bearing }); } catch {}
    try { _map.resize(); } catch {}
  });
}



// (opcional) placeholder por si algo falla al cargar mapas
function paintMapsPlaceholderV2(){
  const title = document.getElementById('mapsTitle');
  const p1    = document.getElementById('mapsP1');
  const p2    = document.getElementById('mapsP2');
  if (title) title.textContent = t('mapsTitle');
  if (p1) p1.textContent = t('mapsP1');
  if (p2) p2.textContent = t('mapsP2');
}

async function initOfflineMap() {
  const PMTILES_FILE = "planet.pmtiles";
  const httpUrl = `${BASE_URL}/assets/maps/${PMTILES_FILE}`;
  _pmtilesUrl = httpUrl;

  if (!window.pmtiles || !window.maplibregl) {
    console.error("Faltan pmtiles o maplibre en la página");
    return;
  }

  // Registrar el protocolo pmtiles una sola vez
  if (!_pmproto) {
    _pmproto = new pmtiles.Protocol();
    maplibregl.addProtocol("pmtiles", _pmproto.tile);
  }

  const canvas = ensureMapCanvas();
  if (!canvas) return;

  // Si ya existe el mapa, sólo recarga el style del tema
  if (_map) { await reloadMapStyleForTheme(PMTILES_FILE); return; }

  // Detectar si el .pmtiles es de Protomaps (para usar tu style local)
  let meta = null;
  try { meta = await new pmtiles.PMTiles(httpUrl).getMetadata(); } catch {}
  const names = new Set((meta?.vector_layers || []).map(l => l.id));
  const isProtomaps = ["water","roads","landuse","boundaries"].some(n => names.has(n));

  const style = isProtomaps
    ? await loadLocalStyleAndPatch(PMTILES_FILE)
    : await buildMinimalStyle(httpUrl);

  // ⚠️ IMPORTANTE: asignar a la variable global _map (NO "const _map")
  _map = new maplibregl.Map({
    container: 'map-canvas',
    style,
    center: [0, 20],
    zoom: 2,
    attributionControl: false
  });

  // Controles
  _map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  _map.addControl(new maplibregl.FullscreenControl(), "top-right");
  _map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
  _map.addControl(new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserHeading: true
  }), "top-right");

  // Atribución custom (Protomaps + OSM)
  _map.addControl(new maplibregl.AttributionControl({
    compact: false,
    customAttribution: MAP_ATTR
  }), "bottom-right");

  _map.on("load", () => { _mapReady = true; _map.resize(); });
}


// ===== I18N =====
const I18N = {
  en: {
    talkToModel: "💻 Model",
    talkToAgents: "👤 Agents",
    modeWiki: "🏛️ Wikipedia",
    modeLibrary: "📖 Library",
    selectAgent: "Select agent",
    typing: "typing",
    survivorInit: "Hello! I’m ready to help. Ask me anything, or switch to an expert agent anytime.",
    step1: "Step 1/2 · Browse",
    step2: "Step 2/2 · Review profile",
    allCategories: "All",
    startChat: "Start chat with this agent",
    back: "← Back",
    reset: "🔄️ Restart",
    modeToggle: "🌓 Mode",
    chatWithModel: "Chat with Model",
    survivorDetected: "**Survivor detected.** 🧰<br>This system is running offline. Internet and government services are no longer available.<br>You can ask me anything to help you survive. Or select a specialized agent to guide you.",
    modeModel: "Mode: Model",
    modeAgents: "Mode: Agents",
    send: "Send",
    talkWithName: "Talk with {name}",
    agentLabel: "Agent",
    modelLabel: "Model",
    professionLabel: "Profession",
    modelOnly: "Model Only",
    relatedArticlesTitle: "Related articles",
    searchInWikipedia: "Search in Wikipedia",
	modeSky: "🌙 Sky",
	skyTitle: "✨ Sky — coming in Version 2",
	skyP1: "Sky will be powered by Stellarium and work fully offline.",
	skyP2: "Estimated additional package size: ~10 GB. Included with the V2 installer/USB.",
	modeMaps: "🌍️ Maps",
	mapsTitle:"🌍️ Maps — coming in Version 2",
	mapsP1:   "Maps will use MapLibre, Proton Maps and PMTiles, with preloaded data for 100% offline use.",
	mapsP2:   "Estimated additional package size: ~120 GB. Included with the V2 installer/USB.",
    categoryLabel: "Category",
    noArticleFound: "No article found",
    agentsNeutralTitle: "Agents",
    // 🆕 referrals
    suggestedAgentsTitle: "Suggested agents",
    // 📚 Library
    libModeTag: "Mode: Library",
    libUp: "Up",
    libEmpty: "Empty folder",
    libView: "View",
    libDownload: "Download"
  },
  es: {
    talkToModel: "💻 Modelo",
    talkToAgents: "👤 Agentes",
    modeWiki: "🏛️ Wikipedia",
    modeLibrary: "📖 Librería",
    selectAgent: "Seleccionar agente",
    typing: "escribiendo",
    survivorInit: "¡Hola! Estoy listo para ayudarte. Pregúntame lo que necesites o cambia a un agente cuando quieras.",
    step1: "Paso 1/2 · Explorar",
    step2: "Paso 2/2 · Revisar perfil",
    allCategories: "Todas",
    startChat: "Iniciar chat con este agente",
    back: "← Volver",
    reset: "🔄️ Reiniciar",
    modeToggle: "🌓 Tema",
    chatWithModel: "Chatear con el Modelo",
    survivorDetected: "**Superviviente detectado.** 🧰<br>Este sistema se ejecuta sin conexión. Internet y los servicios gubernamentales ya no están disponibles.<br>Puedes preguntarme lo que quieras para ayudarte a sobrevivir. O seleccionar un agente especializado.",
    modeModel: "Modo: Modelo",
    modeAgents: "Modo: Agentes",
    send: "Enviar",
    talkWithName: "Hablar con {name}",
    agentLabel: "Agente",
    modelLabel: "Modelo",
    professionLabel: "Profesión",
    modelOnly: "Solo modelo",
    relatedArticlesTitle: "Artículos relacionados",
    searchInWikipedia: "Buscar en la Wikipedia",
	modeSky:  "🌙 Cielo",
	skyTitle: "✨ Cielo — disponible en la Versión 2",
	skyP1:    "El módulo Cielo estará basado en Stellarium y funcionará completamente offline.",
	skyP2:    "Tamaño estimado del paquete adicional: ~10 GB. Se incluirá en el instalador/USB de la V2.",
	modeMaps: "🌍️ Mapas",
	mapsTitle:"🌍️ Mapas — disponibles en la Versión 2",
	mapsP1:   "Los mapas estarán basados en MapLibre, Proton Maps y PMTiles, con datos precargados para uso 100% offline.",
	mapsP2:   "Tamaño estimado del paquete adicional: ~120 GB. Se incluirá en el instalador/USB de la V2.",
    categoryLabel: "Categoría",
    noArticleFound: "No se ha encontrado ningún artículo",
    agentsNeutralTitle: "Agentes",
    // 🆕 referrals
    suggestedAgentsTitle: "Agentes recomendados",
    // 📚 Library
    libModeTag: "Modo: Librería",
    libUp: "Arriba",
    libEmpty: "Carpeta vacía",
    libView: "Ver",
    libDownload: "Descargar"
  },
  fr: {
    talkToModel: "💻 Modèle",
    talkToAgents: "👤 Agents",
    modeWiki: "🏛️ Wikipédia",
    modeLibrary: "📖 Bibliothèque",
    selectAgent: "Choisir un agent",
    typing: "saisie en cours",
    survivorInit: "Bonjour ! Je suis prêt à vous aider. Posez-moi vos questions ou passez à un agent quand vous voulez.",
    step1: "Étape 1/2 · Parcourir",
    step2: "Étape 2/2 · Fiche",
    allCategories: "Toutes",
    startChat: "Démarrer le chat avec cet agent",
    back: "← Retour",
    reset: "🔄️ Redémarrer",
    modeToggle: "🌓 Mode",
    chatWithModel: "Discuter avec le Modèle",
    survivorDetected: "**Survivant détecté.** 🧰<br>Ce système fonctionne hors ligne. Internet et les services gouvernementaux ne sont plus disponibles.<br>Vous pouvez me demander n'importe quoi pour vous aider. Ou sélectionner un agent spécialisé.",
    modeModel: "Mode: Modèle",
    modeAgents: "Mode: Agents",
    send: "Envoyer",
    talkWithName: "Parler avec {name}",
    agentLabel: "Agent",
    modelLabel: "Modèle",
    professionLabel: "Profession",
    modelOnly: "Modèle seul",
    relatedArticlesTitle: "Articles connexes",
    searchInWikipedia: "Rechercher dans Wikipédia",
	modeSky:  "🌙 Ciel",
	skyTitle: "✨ Ciel — disponible dans la Version 2",
	skyP1:    "Le module Ciel s’appuiera sur Stellarium et fonctionnera entièrement hors ligne.",
	skyP2:    "Taille estimée du pack additionnel : ~10 Go. Inclus avec l’installateur/clé USB de la V2.",
	modeMaps: "🌍️ Cartes",
	mapsTitle:"🌍️ Cartes — disponibles dans la Version 2",
	mapsP1:   "Les cartes utiliseront MapLibre, Proton Maps et PMTiles, avec des données préchargées pour un usage 100 % hors ligne.",
	mapsP2:   "Taille estimée du pack additionnel : ~120 Go. Inclus avec l’installateur/clé USB de la V2.",
    categoryLabel: "Catégorie",
    noArticleFound: "Aucun article trouvé",
    agentsNeutralTitle: "Agents",
    // 🆕 referrals
    suggestedAgentsTitle: "Agents recommandés",
    // 📚 Library
    libModeTag: "Mode : Bibliothèque",
    libUp: "Haut",
    libEmpty: "Dossier vide",
    libView: "Voir",
    libDownload: "Télécharger"
  }
};

function t(key){
  const lang = state.lang || "en";
  return I18N[lang]?.[key] || I18N["en"][key] || key;
}
function tfmt(key, params = {}){
  const raw = t(key);
  return raw.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? String(params[k]) : ""));
}

// ===== DOM =====
const modeLLM = document.getElementById("modeLLM");
const modeAgents = document.getElementById("modeAgents");
const modeWiki = document.getElementById("modeWiki");
const modeLibrary = document.getElementById("modeLibrary"); // 📚 NUEVO

const chatView = document.getElementById("chatView");
const agentsSteps = document.getElementById("agentsSteps");

const chat = document.getElementById("chat");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const latency = document.getElementById("latency");
const tokenEst = document.getElementById("tokenEst");
const themeToggle = document.getElementById("themeToggle");

const currentModeTag = document.getElementById("currentModeTag");
const activeAgentTag = document.getElementById("activeAgentTag");
const activeModelTag = document.getElementById("activeModelTag");
const activeProfessionTag = document.getElementById("activeProfessionTag");

const step0 = document.getElementById("step0");
const categoriesGrid = document.getElementById("categoriesGrid");
const catFilters = document.getElementById("catFilters");
const agentsGrid = document.getElementById("agentsGrid");
const step1 = document.getElementById("step1");
const step2 = document.getElementById("step2");
const agentPreview = document.getElementById("agentPreview");
const backToCats = document.getElementById("backToCats");
const backToList = document.getElementById("backToList");
const confirmAgent = document.getElementById("confirmAgent");

const chatTitle = document.getElementById("chatTitle");
const chatAvatar = document.getElementById("chatAvatar");

const selectAgentBtn = document.getElementById("selectAgentBtn");

const batteryFill = document.getElementById("batteryFill");
const batteryPct = document.getElementById("batteryPct");


// 📚 Librería DOM
const libraryView = document.getElementById("libraryView");
const libUpBtn = document.getElementById("libUpBtn");
const libPathLabel = document.getElementById("libPathLabel");
const libList = document.getElementById("libList");
const libEmpty = document.getElementById("libEmpty");

// Sky DOM
const modeSky = document.getElementById("modeSky");
const skyView = document.getElementById("skyView");

// Idioma en footer
let langFlagEl, langNameEl;

// ===== helpers de foco =====
function focusEditor() {
  if (chatView.classList.contains("hidden")) return;
  input.focus({ preventScroll: true });
  const end = input.value.length;
  try { input.setSelectionRange(end, end); } catch {}
}

// --- helpers i18n de agente ---
function L(val){
  if (val && typeof val === "object") {
    const lang = state.lang || "en";
    return String(val[lang] || val.en || Object.values(val)[0] || "");
  }
  return String(val || "");
}

function pickGreeting(agent){
  if (!agent) return null;
  const lang = state.lang || "en";

  // 1) greetings: { es: "..."/["..."], en: "..."/["..."] }
  const g = agent.greetings;
  if (g && typeof g === "object") {
    const val = g[lang] ?? g.en ?? null;
    if (Array.isArray(val) && val.length) return val[Math.floor(Math.random()*val.length)];
    if (typeof val === "string" && val.trim()) return val.trim();
  }

  // 2) greeting: puede ser string o objeto por idioma
  const gg = agent.greeting;
  if (gg){
    if (typeof gg === "string" && gg.trim()) return gg.trim();
    if (typeof gg === "object") {
      const v2 = gg[lang] ?? gg.en ?? null;
      if (Array.isArray(v2) && v2.length) return v2[Math.floor(Math.random()*v2.length)];
      if (typeof v2 === "string" && v2.trim()) return v2.trim();
    }
  }

  // 3) fallback elegante si no hay greeting en el perfil (sin profesión)
  if (lang === "es") {
    return `¡Hola! me llamo ${agent.name}. ¿En qué puedo ayudarte?`;
  } else if (lang === "fr") {
    return `Bonjour ! Je m'appelle ${agent.name}. Comment puis-je vous aider ?`;
  }
  return `Hi! My name is ${agent.name}. How can I help?`;
} // ✅ ¡esta llave faltaba en tu versión!

// ===== KIWIX CLIENT HELPERS =====
function escapeRegex(s){ return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
const _HOST_RE = escapeRegex(KIWIX_ORIGIN.replace(/^https?:\/\//,""));

async function resolveStartUrl(lang) {
  // Arranca Kiwix y detecta el ZIM disponible (maxi → nopic → mini)
  const r = await fetch(`${BASE_URL}/api/wiki?lang=${encodeURIComponent(lang)}`);
  const data = await r.json();
  if (data.status !== "ok") {
    const candidates = (data.candidates || []).join("\n• ");
    throw new Error(
      (data.message || "No ZIM found.") +
      (candidates ? `\nCandidates:\n• ${candidates}` : "")
    );
  }
  const zimId = data.zim_file.replace(/\.zim$/,"");
  state.wiki.zimId = zimId;   // cachea el elegido
  const landing = getLandingArticle(lang);
  const encoded = encodeURIComponent(landing).replace(/%2F/g, "/");
  return `${KIWIX_ORIGIN}/viewer#${zimId}/${encoded}`;
}

function getLandingArticle(lang) {
  const map = {
    es: ["Wikipedia:Offline", "Portada"],
    en: ["User:The_other_Kiwix_guy/Landing", "Main_Page"],
    fr: ["Wikipédia:Hors-ligne", "Wikipédia:Accueil_principal"]
  };
  const arr = map[lang] || map.en;
  return arr[0];
}

// ===== INIT =====
function init(){
  restorePrefs();
  state.library.sort = state.library.sort || "name";
  state.library.filter = state.library.filter || "";
  attachEvents();
  setActiveModelTag();
  setupBattery();

  // 🔁 Historial de agentes recientes
  loadRecentAgents();        // ← lee localStorage → state.recentAgents
  ensureRecentsBar();        // ← crea el contenedor debajo del botón si no existe
  renderRecentAgentsBar();   // ← lo pinta / oculta según toque

  showBackendModel().then(async ()=>{
    applyTranslations();
    if (activeProfessionTag) activeProfessionTag.classList.add("tag--profession");

    // Pinta la vista guardada (llm/agents/wiki/library)
    await setMode(state.mode);

    // Precarga para tener avatares válidos en la barra de recientes
    fetchCategories().catch(()=>{});
    fetchAgents().finally(()=> renderRecentAgentsBar());

    // Asegura saludo del LLM si el arranque fue en frío
    ensureInitialGreeting();

    requestAnimationFrame(focusEditor);
  });
}
init();


// Detecta tipo de navegación
function getNavigationType(){
  try {
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav && nav.type) return nav.type;
    if (performance && performance.navigation) {
      return performance.navigation.type === 1 ? 'reload' : 'navigate';
    }
  } catch {}
  return 'navigate';
}

function restorePrefs(){
  const navType = getNavigationType();
  const fromLangSwitch = sessionStorage.getItem('langSwitching') === '1';
  
  if (!fromLangSwitch) {
    try { localStorage.removeItem('recentAgents'); } catch {}
    state.recentAgents = [];  // limpia en RAM también
  }

  if (navType === 'reload') {
    if (!fromLangSwitch) localStorage.removeItem('langOverride');
    localStorage.removeItem('mode');
    state.mode = 'llm';
    sessionStorage.removeItem('langSwitching');
  }

  const savedLangOverride = localStorage.getItem("langOverride");
  if (savedLangOverride && SUPPORTED_LANGS[savedLangOverride]) {
    state.lang = savedLangOverride;
    state.lang_label = SUPPORTED_LANGS[savedLangOverride].label;
    state.lang_flag = SUPPORTED_LANGS[savedLangOverride].flag;
  }

  const savedModel = localStorage.getItem("modelFile");
  if (savedModel) state.modelFile = savedModel;

  if (navType !== 'reload') {
    const savedMode = localStorage.getItem("mode");
    if (savedMode) state.mode = savedMode;
  }

  const savedTheme = localStorage.getItem("theme") || "light";
  document.documentElement.setAttribute("data-theme", savedTheme);
}

function setActiveModelTag(info){
  const label = t("modelLabel");
  if (info && info.model_file){
    activeModelTag.textContent = `${label}: ${info.model_file} (${info.chat_format})`;
  } else {
    const modelObj = MODELS.find(m=>m.file===state.modelFile);
    const modelName = modelObj ? modelObj.label : state.modelFile;
    activeModelTag.textContent = `${label}: ${modelName}`;
  }
}


// ===== TRANSLATIONS =====
function applyTranslations(){
  // Botones de modo (header)
  modeLLM.textContent = t("talkToModel");
  modeAgents.textContent = t("talkToAgents");
  document.getElementById("modeWiki").textContent = t("modeWiki");
  if (modeLibrary) modeLibrary.textContent = t("modeLibrary");
  // ✨ Sky (botón)
  const modeSky = document.getElementById("modeSky");
  if (modeSky) modeSky.textContent = t("modeSky");
  // 🗺️ Maps (botón)
  const modeMaps = document.getElementById("modeMaps");
  if (modeMaps) modeMaps.textContent = t("modeMaps");


  // ✨ Sky (placeholder: títulos y párrafos)
  const skyTitle = document.getElementById("skyTitle");
  const skyP1    = document.getElementById("skyP1");
  const skyP2    = document.getElementById("skyP2");
  if (skyTitle) skyTitle.textContent = t("skyTitle");
  if (skyP1)    skyP1.textContent    = t("skyP1");
  if (skyP2)    skyP2.textContent    = t("skyP2");
  
  // 🗺️ Maps (placeholder)
  const mapsTitle = document.getElementById("mapsTitle");
  const mapsP1 = document.getElementById("mapsP1");
  const mapsP2 = document.getElementById("mapsP2");
  if (mapsTitle) mapsTitle.textContent = t("mapsTitle");
  if (mapsP1)    mapsP1.textContent    = t("mapsP1");
  if (mapsP2)    mapsP2.textContent    = t("mapsP2");

  // Resto de tu función (sin cambios)
  const step0Title = document.getElementById("step0Title");
  if (step1) step1.querySelector("h3").textContent = t("step1");
  if (step2) step2.querySelector("h3").textContent = t("step2");

  if (backToCats) backToCats.textContent = t("back");
  backToList.textContent = t("back");
  confirmAgent.textContent = t("startChat");
  document.getElementById("resetChat").textContent = t("reset");
  document.getElementById("themeToggle").textContent = t("modeToggle");
  sendBtn.textContent = `✅️ ${t("send")}`;

  if (selectAgentBtn) {
    const label = t("selectAgent");
    selectAgentBtn.textContent = `👤 ${label}`;
    selectAgentBtn.setAttribute("aria-label", label);
    selectAgentBtn.setAttribute("title", label);
  }

  const flagSpan = document.getElementById("langFlag");
  const nameSpan = document.getElementById("langName");
  if (flagSpan) flagSpan.textContent = state.lang_flag || (SUPPORTED_LANGS[state.lang]?.flag || "");
  if (nameSpan) nameSpan.textContent = state.lang_label || (SUPPORTED_LANGS[state.lang]?.label || "English");

  // 📚 Librería
  if (libUpBtn) {
    libUpBtn.textContent = "↑";
    libUpBtn.title = t("libUp");
    libUpBtn.setAttribute("aria-label", t("libUp"));
  }
  if (libEmpty) libEmpty.textContent = t("libEmpty");

  updateFlagActive();
}

// ===== EVENTS =====
function attachEvents(){
  modeLLM.addEventListener("click", ()=> { setMode("llm"); requestAnimationFrame(focusEditor);});
  modeAgents.addEventListener("click", ()=> setMode("agents"));

  const modeWikiBtn = document.getElementById("modeWiki");
  if (modeWikiBtn){
    modeWikiBtn.addEventListener("click", ()=> setMode("wiki"));
  }

  // 📚 Librería
  if (modeLibrary){
    modeLibrary.addEventListener("click", ()=> setMode("library"));
  }
  
    // ✨ Sky (placeholder)
  const modeSkyBtn = document.getElementById("modeSky");
  if (modeSkyBtn){
    modeSkyBtn.addEventListener("click", ()=> setMode("sky"));
  }
    // Map (placeholder)
  const modeMapsBtn = document.getElementById("modeMaps");
if (modeMapsBtn){
  modeMapsBtn.addEventListener("click", ()=> setMode("maps"));
}
  

  if (selectAgentBtn){
    selectAgentBtn.addEventListener("click", ()=>{
      saveCurrentScroll();
      state.mode = "agents";
      localStorage.setItem("mode","agents");

      agentsSteps.classList.remove("hidden");
      chatView.classList.add("hidden");
      if (activeProfessionTag) activeProfessionTag.classList.add("hidden");

      if (step0) step0.classList.add("hidden");      // 👈 NO usamos Step 0
      if (step1) step1.classList.remove("hidden");   // 👈 listado visible
      if (step2) step2.classList.add("hidden");
      // Cargar datos y pintar filtros + listado
      fetchCategories()
        .then(()=> fetchAgents())
        .catch(()=> fetchAgents())
        .finally(()=>{
          renderCategoryFilters();
          renderAgentsList();
        });
    });
  }

  document.querySelectorAll('.actions-right .flag').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const code = btn.dataset.lang;
      if (code && code !== state.lang) setLangOverrideAndReload(code);
    });
  });

  sendBtn.addEventListener("mousedown", (e) => e.preventDefault());
  sendBtn.addEventListener("click", (e) => { e.preventDefault(); trySend(); });

  if (backToCats){
    backToCats.addEventListener("click", ()=>{
      state.selectedCategory = null;
      step1.classList.add("hidden");
      step2.classList.add("hidden");
      step0.classList.remove("hidden");
      activeAgentTag.classList.add('hidden');
      if (activeProfessionTag) activeProfessionTag.classList.add("hidden");
    });
  }

  backToList.addEventListener("click", ()=>{
    step2.classList.add("hidden");
    setTimeout(()=> step1.classList.remove("hidden"), 10);
  });

  confirmAgent.addEventListener("click", () => {
    if (!state.selectedAgent) return;
    goToAgentChat(state.selectedAgent);
  });

  input.addEventListener("keydown", (e)=>{
    if (e.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey){
      e.preventDefault();
      trySend();
    }
  });

themeToggle.addEventListener("click", ()=>{
  const html = document.documentElement;
  const isLight = html.getAttribute("data-theme")==="light";
  html.setAttribute("data-theme", isLight ? "dark" : "light");
  localStorage.setItem("theme", isLight ? "dark" : "light");
  refreshWikiQuickBtnStyle();

  // 👇 NUEVO: si estamos en mapas, aplica el estilo nuevo ya cargado
  if (state.mode === "maps" && _mapReady) {
    reloadMapStyleForTheme("planet.pmtiles");
  }
});

  document.getElementById("resetChat").addEventListener("click", async ()=>{
    state.chats = { model: [], agents: {} };
    state.wikiLinks = {};
    chat.innerHTML = "";

    // 🔄 limpia también el historial de avatares recientes
    state.recentAgents = [];
    saveRecentAgents();
    renderRecentAgentsBar();

    try {
      await fetch(`${BASE_URL}/api/reset`, { method: "POST" });
      if (state.mode === "llm") {
        addMessage("bot", t("survivorInit")); // 👈 NO wiki
        renderConversation();
        if (activeProfessionTag) activeProfessionTag.classList.add("hidden");
      } else if (state.mode === "agents" && state.selectedAgent) {
        const greet = pickGreeting(state.selectedAgent);
        if (greet) addMessage("bot", greet); // 👈 NO wiki
        renderConversation();
      }
      requestAnimationFrame(focusEditor);
    } catch (err) {
      addMessage("bot", `⚠️ Could not reset: ${err.message}`);
    }
  });

  // ✅ ÚNICO bloque de clicks para referrals y chips → SOLO abrir chat, sin pasar contexto
  document.addEventListener("click", async (e)=>{
    // 1) wikilinks
    const wiki = e.target.closest && e.target.closest('a.wiki-link');
    if (wiki){
      e.preventDefault();
      const title = wiki.getAttribute('data-wiki-title') || (wiki.textContent || "").trim();
      if (title) { try { await openWikiArticle(title); } catch {} }
    }

    // 2) enlaces a agentes (desde texto)
    const link = e.target.closest && e.target.closest('a.agent-link');
    if (link){
      e.preventDefault();
      if (state.mode !== "agents") return;   // referrals solo en Agents
      const name = link.getAttribute('data-agent-name') || link.textContent || "";
      if (name) openAgentByName(name);
      return;
    }

    // 3) tarjetas de referral (dentro del chat)
    const card = e.target.closest && e.target.closest('.ref-card');
    if (card){
      e.preventDefault();
      if (state.mode !== "agents") return;   // referrals solo en Agents
      const name = card.getAttribute('data-agent-name') || "";
      if (name) openAgentByName(name);
      return;
    }

    // 4) chips de recientes (debajo del botón del header)
    const chip = e.target.closest && e.target.closest('.recent-chip');
    if (chip){
      e.preventDefault();
      const name = chip.getAttribute('data-agent-name') || chip.getAttribute('title') || '';
      if (name) await openAgentByName(name);
      return;
    }

    // 5) 📚 Librería: filas y acciones
    const row = e.target.closest && e.target.closest('.lib-row');
    if (row){
      const type = row.getAttribute('data-type');
      const rel  = row.getAttribute('data-rel'); // ruta relativa desde root
      if (!type || !rel) return;
      // por defecto: abrir
      e.preventDefault();
      if (type === "dir") libraryNavigateTo(rel);
      else libraryOpen(rel);
      return;
    }
  });

  // 🆕 Chips del historial de agentes recientes (duplicado para asegurar)
  document.addEventListener('click', async (e)=>{
    const chip = e.target.closest && e.target.closest('.recent-chip');
    if (chip){
      e.preventDefault();
      const name = chip.getAttribute('data-agent-name') || chip.getAttribute('title') || '';
      if (name) await openAgentByName(name);
    }
  });

  // 📚 Librería: botón Arriba
  if (libUpBtn) {
    libUpBtn.addEventListener("click", (e)=>{
      e.preventDefault();
      libraryGoUp();
    });
  }

  // Selección → botón rápido Wikipedia
  const debouncedShow = (()=> {
    let t = 0;
    return ()=> { clearTimeout(t); t = setTimeout(showWikiQuickButtonForSelection, 30); };
  })();

  document.addEventListener("mouseup", debouncedShow);
  document.addEventListener("keyup", (e)=>{
    if (e.key && (e.key.startsWith("Arrow") || e.key === "Shift" || e.key === "Control" || e.key === "Alt")) {
      debouncedShow();
    }
  });
  window.addEventListener("scroll", hideWikiQuickUI, { passive: true });
  
  // Selección → botón rápido Wikipedia
  document.addEventListener("mouseup", debouncedShow);
  document.addEventListener("keyup", (e)=>{ /* ... */ });
  window.addEventListener("scroll", hideWikiQuickUI, { passive: true });

  // ⌨️ Navegación por teclado en Library
  document.addEventListener("keydown", onLibKeydown);
}


// ===== LANG SWITCH HELPERS =====
function updateFlagActive(){
  document.querySelectorAll('.actions-right .flag').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.lang === state.lang);
  });
}

function setLangOverrideAndReload(code){
  if (!SUPPORTED_LANGS[code]) return;
  localStorage.setItem('langOverride', code);
  sessionStorage.setItem('langSwitching', '1');
  fetch(`${BASE_URL}/api/reset`, { method: "POST" }).finally(()=>{
    location.reload();
  });
}

// ===== CATEGORIES =====
const KEYWORD_RULES = {
  medical:     ["surgeon","medic","psychological","first aid","nurse","paramedic","trauma","clinic"],
  engineering: ["mechanic","electric","water","chemist","purifier","low-tech","radio","generator","structural","engineer"],
  food:        ["farmer","forager","fish","fisher","animal","keeper","cook","nutrition","hunter"],
  leadership:  ["strategist","planner","facilitator","teacher","companion","entertainer","group","scout"]
};

function guessCategoryByProfession(agent){
  const prof = (L(agent?.profession) || "").toLowerCase();
  for (const key of Object.keys(KEYWORD_RULES)) {
    if (KEYWORD_RULES[key].some(m=> prof.includes(m))) return key;
  }
  return "other";
}

function getAgentCategory(agent){
  return (agent && agent.category) ? String(agent.category).toLowerCase() : guessCategoryByProfession(agent);
}

function localCatsFallback(){
  const BASE = [
    { key: "medical",    emoji: "🩺", label: {en:"Medical",      es:"Sanidad",    fr:"Santé"} },
    { key: "engineering",emoji: "⚙️", label: {en:"Engineering",  es:"Ingeniería", fr:"Ingénierie"} },
    { key: "food",       emoji: "🍲", label: {en:"Food & Harvest",es:"Alimentos",  fr:"Nourriture"} },
    { key: "leadership", emoji: "🧭", label: {en:"Leadership",   es:"Liderazgo",  fr:"Leadership"} },
    { key: "other",      emoji: "🧩", label: {en:"Other",        es:"Otros",      fr:"Autres"} }
  ];
  const lang = state.lang || "en";
  return BASE.map(c => ({ key: c.key, emoji: c.emoji, label: c.label[lang] || c.label.en }));
}


async function fetchCategories(){
  try {
    const res = await fetch(`${BASE_URL}/api/categories?lang=${encodeURIComponent(state.lang)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cats = await res.json();
    if (Array.isArray(cats) && cats.length) {
      state.categories = cats;
    } else {
      state.categories = localCatsFallback();
    }
  } catch (e) {
    state.categories = localCatsFallback();
  }
}

function getCategoryMeta(key){
  return state.categories.find(c=>c.key === key) || null;
}

function tCatLabel(key){
  const m = getCategoryMeta(key);
  return m ? m.label : key;
}

function buildCategoryCounts(list){
  const counts = {};
  state.categories.forEach(c => counts[c.key] = 0);
  for (const a of list) {
    const k = getAgentCategory(a);
    if (counts.hasOwnProperty(k)) counts[k] += 1;
    else counts["other"] = (counts["other"] || 0) + 1;
  }
  return counts;
}

function renderCategories(){
  if (!categoriesGrid) return;
  const counts = buildCategoryCounts(state.agents);
  categoriesGrid.innerHTML = "";
  state.categories.forEach(cat=>{
    if (!counts[cat.key]) return;
    const card = document.createElement("div");
    card.className = "category-card";
    card.innerHTML = `
      <span class="category-emoji">${cat.emoji || "🧩"}</span>
      <span class="category-name">${cat.label || cat.key}</span>
      <span class="category-count">${counts[cat.key]}</span>
    `;
    card.addEventListener("click", ()=> chooseCategory(cat.key));
    categoriesGrid.appendChild(card);
  });
}

function renderCategoryFilters(){
  if (!catFilters) return;

  const counts = buildCategoryCounts(state.agents);
  const total = state.agents.length;

  catFilters.innerHTML = "";

  // Chip "Todas/All/Toutes"
  const allBtn = document.createElement("button");
  allBtn.className = "filter-chip" + (state.selectedCategory ? "" : " active");
  allBtn.dataset.cat = "__all__";
  allBtn.textContent = `${t("allCategories")}`;
  const allCount = document.createElement("span");
  allCount.className = "count";
  allCount.textContent = `• ${total}`;
  allBtn.appendChild(allCount);
  allBtn.addEventListener("click", ()=>{
    state.selectedCategory = null;
    renderCategoryFilters();
    renderAgentsList();
  });
  catFilters.appendChild(allBtn);

  // Resto de categorías con conteo > 0
  state.categories.forEach(cat=>{
    const n = counts[cat.key] || 0;
    if (!n) return;

    const btn = document.createElement("button");
    btn.className = "filter-chip" + (state.selectedCategory === cat.key ? " active" : "");
    btn.dataset.cat = cat.key;
    btn.innerHTML = `${cat.emoji || "⭐"} ${cat.label}`;
    const span = document.createElement("span");
    span.className = "count";
    span.textContent = `• ${n}`;
    btn.appendChild(span);

    btn.addEventListener("click", ()=>{
      state.selectedCategory = cat.key;
      renderCategoryFilters();
      renderAgentsList();
    });

    catFilters.appendChild(btn);
  });
}


function chooseCategory(catKey){
  state.selectedCategory = catKey;
  if (step0) step0.classList.add("hidden");
  if (step1) step1.classList.remove("hidden");
  if (step2) step2.classList.add("hidden");
  renderCategoryFilters();
  renderAgentsList();
}

// ===== MODE =====
async function setMode(mode){
  saveCurrentScroll();

  // Oculta el botón rápido si cambiamos de sección
  try { hideWikiQuickUI(); } catch {}

  state.mode = mode;
  localStorage.setItem("mode", mode);

  const chatContainer = document.getElementById("chatContainer");
  const wikiView = document.getElementById("wikiView");

  // ✨ SKY & 🗺️ MAPS: refs
  const skyView   = document.getElementById("skyView");
  const modeSky   = document.getElementById("modeSky");
  const mapsView  = document.getElementById("mapsView");
  const modeMaps  = document.getElementById("modeMaps");

  modeLLM.classList.remove("active");
  modeAgents.classList.remove("active");
  modeWiki.classList.remove("active");
  if (modeLibrary) modeLibrary.classList.remove("active");
  // ✨ & 🗺️ quitar active
  if (modeSky)  modeSky.classList.remove("active");
  if (modeMaps) modeMaps.classList.remove("active");

  if (mode === "llm") {
    modeLLM.classList.add("active");

    chatContainer.classList.remove("hidden");
    wikiView.classList.add("hidden");
    if (libraryView) libraryView.classList.add("hidden");
    // ✨ & 🗺️ ocultar
    if (skyView)  skyView.classList.add("hidden");
    if (mapsView) mapsView.classList.add("hidden");

    chatView.classList.remove("hidden");
    agentsSteps.classList.add("hidden");

    currentModeTag.textContent = t("modeModel");

    activeAgentTag.classList.remove("hidden");
    activeAgentTag.textContent = `${t("agentLabel")}: ${t("modelOnly")}`;

    chatTitle.textContent = t("chatWithModel");

    chatAvatar.classList.remove("hidden");
    chatAvatar.innerHTML = `<img src="avatars/model_only.png" 
      alt="Model Only" style="width:100%;height:100%;border-radius:6px;"/>`;

    if (selectAgentBtn) selectAgentBtn.classList.add("hidden");
    if (activeProfessionTag) activeProfessionTag.classList.add("hidden");

    if (!state.chats.model.length){
      addMessage("bot", t("survivorInit")); // 👈 saludo sin wiki
    } else {
      normalizeModelGreeting();
    }
    renderConversation();
    requestAnimationFrame(focusEditor);

  } else if (mode === "agents") {
    modeAgents.classList.add("active");

    chatContainer.classList.remove("hidden");
    wikiView.classList.add("hidden");
    if (libraryView) libraryView.classList.add("hidden");
    // ✨ & 🗺️ ocultar
    if (skyView)  skyView.classList.add("hidden");
    if (mapsView) mapsView.classList.add("hidden");

    chatView.classList.remove("hidden");
    agentsSteps.classList.add("hidden");

    if (selectAgentBtn) selectAgentBtn.classList.remove("hidden");

    currentModeTag.textContent = t("modeAgents");

    if (state.selectedAgent){
      activeAgentTag.classList.remove("hidden");
      activeAgentTag.textContent = `${t("agentLabel")}: ${state.selectedAgent.name}`;

      const prof = L(state.selectedAgent.profession) || "";
      if (activeProfessionTag){
        if (prof) {
          activeProfessionTag.classList.remove("hidden");
          activeProfessionTag.textContent = `${t("professionLabel")}: ${prof}`;
          activeProfessionTag.classList.add("tag--profession");
        } else {
          activeProfessionTag.classList.add("hidden");
        }
      }

      chatTitle.textContent = tfmt("talkWithName", { name: state.selectedAgent.name });

      chatAvatar.classList.remove("hidden");
      if (state.selectedAgent.avatar) {
        chatAvatar.innerHTML = `<img src="${state.selectedAgent.avatar}" alt="${state.selectedAgent.name}" style="width:100%;height:100%;border-radius:6px;"/>`;
      } else {
        chatAvatar.textContent = initials(state.selectedAgent.name);
      }

      const k = agentKey(state.selectedAgent);
      if (!state.chats.agents[k] || state.chats.agents[k].length === 0){
        const greet = pickGreeting(state.selectedAgent);
        if (greet) addMessage("bot", greet); // 👈 saludo sin wiki
      }
      renderConversation();
      requestAnimationFrame(focusEditor);

    } else {
      activeAgentTag.classList.add("hidden");
      if (activeProfessionTag) activeProfessionTag.classList.add("hidden");
      chatTitle.textContent = t("agentsNeutralTitle");
      chatAvatar.classList.remove("hidden");
      chatAvatar.innerHTML = `<img src="avatars/model_only.png" alt="agent" style="width:100%;height:100%;border-radius:6px;opacity:.4;"/>`;
      chat.innerHTML = "";
    }

  } else if (mode === "wiki") {
    modeWiki.classList.add("active");

    chatContainer.classList.add("hidden");
    wikiView.classList.remove("hidden");
    if (libraryView) libraryView.classList.add("hidden");
    // ✨ & 🗺️ ocultar
    if (skyView)  skyView.classList.add("hidden");
    if (mapsView) mapsView.classList.add("hidden");

    if (selectAgentBtn) selectAgentBtn.classList.add("hidden");
    if (activeProfessionTag) activeProfessionTag.classList.add("hidden");

    // ⚠️ oculta el botón rápido al cambiar de sección
    try { hideWikiQuickUI(); } catch {}

    const iframe = document.getElementById("wikiFrame");

    try {
      const startUrl = await resolveStartUrl(state.lang);
      state.wiki.started = true;
      const targetUrl = state.wiki.pendingUrl || startUrl;
      state.wiki.url = targetUrl;
      iframe.src = targetUrl;       // carga directa
      state.wiki.pendingUrl = null;
    } catch (err) {
      console.error(err);
      toast(err.message || "Wiki not available.");
    }

  } else if (mode === "library") {
    if (modeLibrary) modeLibrary.classList.add("active");

    chatContainer.classList.add("hidden");
    wikiView.classList.add("hidden");
    if (selectAgentBtn) selectAgentBtn.classList.add("hidden");
    if (activeProfessionTag) activeProfessionTag.classList.add("hidden");
    // ✨ & 🗺️ ocultar
    if (skyView)  skyView.classList.add("hidden");
    if (mapsView) mapsView.classList.add("hidden");

    if (libraryView) libraryView.classList.remove("hidden");
    document.documentElement.classList.toggle("full-bleed-library", mode === "library");

    currentModeTag.textContent = t("libModeTag");
    ensureLibToolbarExtras();

    // Inicializa y lista
    await libraryEnsurePath();
    await libraryListRender();
    return; // nada más

  }  else if (mode === "sky") {
    if (modeSky) modeSky.classList.add("active");

    // ocultar resto
    if (chatContainer) chatContainer.classList.add("hidden");
    if (wikiView)      wikiView.classList.add("hidden");
    if (libraryView)   libraryView.classList.add("hidden");
    if (mapsView)      mapsView.classList.add("hidden");
    chatView?.classList.add("hidden");
    agentsSteps?.classList.add("hidden");

    // mostrar sky
    skyView?.classList.remove("hidden");

    // etiquetas auxiliares
    if (selectAgentBtn) selectAgentBtn.classList.add("hidden");
    if (activeProfessionTag) activeProfessionTag.classList.add("hidden");
    activeAgentTag?.classList.add("hidden");

    currentModeTag.textContent = t("modeSky"); // "✨ Sky/Cielo/Ciel"
    return;

// 🗺️ MAPS: ahora con mapa real
} else if (mode === "maps") {
  if (modeMaps) modeMaps.classList.add("active");

  // ocultar resto
  if (chatContainer) chatContainer.classList.add("hidden");
  if (wikiView)      wikiView.classList.add("hidden");
  if (libraryView)   libraryView.classList.add("hidden");
  if (skyView)       skyView.classList.add("hidden");
  chatView?.classList.add("hidden");
  agentsSteps?.classList.add("hidden");

  // mostrar maps
  mapsView?.classList.remove("hidden");

  // etiquetas auxiliares
  if (selectAgentBtn) selectAgentBtn.classList.add("hidden");
  if (activeProfessionTag) activeProfessionTag.classList.add("hidden");
  activeAgentTag?.classList.add("hidden");

  currentModeTag.textContent = t("modeMaps");

  // --- Inicialización real del mapa ---
  const canvas = ensureMapCanvas();
  const placeholder = mapsView ? mapsView.querySelector('.empty-state') : null;

  try {
    if (placeholder) placeholder.style.display = 'none';
    if (canvas) canvas.style.display = 'block';

    await initOfflineMap();

    if (_map) _map.resize();
  } catch (err) {
    console.error('Error iniciando mapas:', err);
    // Volvemos al placeholder V2 si algo falla
    if (canvas) canvas.style.display = 'none';
    if (placeholder) {
      placeholder.style.display = 'block';
      paintMapsPlaceholderV2();
    }
  }
  return;
}

  
  renderRecentAgentsBar();
}



// ===== AGENTS =====
async function fetchAgents(){
  try{
    const res = await fetch(`${BASE_URL}/api/agents?lang=${encodeURIComponent(state.lang)}`);
    const data = await res.json();
    state.agents = Array.isArray(data) ? data : [];
    renderCategories();
    renderAgentsList();
  }catch(err){
    toast("⚠️ Could not load agents.");
  }
}

function renderAgentsList(){
  agentsGrid.innerHTML = "";

  const list = state.agents.filter(a=>{
    const cat = getAgentCategory(a);
    if (state.selectedCategory && cat !== state.selectedCategory) return false;
    return true;
  });

  list.forEach(a=>{
    const card = document.createElement("div");
    card.className = "agent-card";

    const avatarHTML = a.avatar
      ? `<img src="${a.avatar}" alt="${escapeHTML(a.name)}"/>`
      : initials(a.name);

    card.innerHTML = `
      <div class="agent-avatar">${avatarHTML}</div>
      <div class="agent-info">
        <div class="name">${escapeHTML(a.name)}</div>
        <div class="separator"></div>
        <div class="profession">${escapeHTML(L(a.profession)||"")}</div>
      </div>
    `;
    card.addEventListener("click", ()=> previewAgent(a));
    agentsGrid.appendChild(card);
  });
  requestAnimationFrame(scrollAgentsListToTop);
}
function scrollAgentsListToTop() {
  const scrollers = [
    document.getElementById("agentsSteps"),  // ← el que tiene overflow-y:auto
    document.getElementById("step1"),
    document.getElementById("agentsGrid")
  ];
  for (const el of scrollers) {
    if (el && typeof el.scrollTop === "number") el.scrollTop = 0;
  }

  // Por si el scroll activo es el de la ventana:
  if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "auto" });
}


function previewAgent(agent){
  state.selectedAgent = agent;
  step1.classList.add("hidden");
  step2.classList.remove("hidden");

  const avatarHTML = agent.avatar
    ? `<img src="${agent.avatar}" class="large-avatar" alt="${escapeHTML(agent.name)}"/>`
    : `<div class="large-avatar">${initials(agent.name)}</div>`;

  agentPreview.innerHTML = `
    ${avatarHTML}
    <div class="details">
      <h4 class="title">${escapeHTML(agent.name)}</h4>
      <p><strong>Profession:</strong> ${escapeHTML(L(agent.profession)||"")}</p>
      <p><strong>Instructions:</strong> ${escapeHTML(L(agent.instructions)||"")}</p>
      <p><strong>Personality:</strong> ${escapeHTML(L(agent.personality)||"")}</p>
    </div>
  `;
}

// ===== CHAT =====
function trySend(){
  const text = input.value.trim();
  if(!text || state.typing) return;
  purgeTrailingWikiInfoForCurrentThread();

  input.value = "";

  addMessage("user", text);
  sendToBackend(text);

  requestAnimationFrame(focusEditor);
}

async function sendToBackend(userText){
  const started = performance.now();
  setBusy(true);

  let payload = { message: userText, lang: state.lang };
  if (state.mode === "agents" && state.selectedAgent){
    payload.agent = state.selectedAgent;
  }

  let typingBubble, typingIdx, stopSpin;

  try {
    const arr = currentThreadArray();

    // 1) bubble "typing"
    typingBubble = addMessage("bot", `${t("typing")} |`);
    typingIdx = arr.length - 1;

    // 2) spinner
    stopSpin = startTypingIndicator(typingBubble, t("typing"));

    // 3) request
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();

    // --- TEXTO crudo
    const replyRaw = (data && data.response) ? String(data.response) : "(empty response)";

    // --- Detectar referrals (antes de limpiar), y luego quitar self
    const allRefs = detectReferrals(replyRaw);
    let referredAgents = filterOutSelf(allRefs);
    // ✅ Referrals SOLO en modo Agents
    if (state.mode !== "agents") referredAgents = [];
    const hasOtherRefs = referredAgents.length > 0;

    // --- Limpiar agent:// y, si hay referrals a OTROS (solo Agents), quitar Kiwix/Wikipedia del texto
    let replyClean = sanitizeAgentMarkup(replyRaw);
    if (hasOtherRefs) replyClean = stripKiwixLinks(replyClean);

    // 4) métricas
    const ms = Math.max(0, Math.round(performance.now() - started));
    latency.textContent = `⏱️ ${ms} ms`;
    tokenEst.textContent = `🧮 ~${estimateTokens(replyClean)} tokens`;

    // 5) pintar respuesta definitiva
    if (stopSpin) stopSpin();
    await typeMessage(replyClean, typingBubble);
    if (typingIdx != null) arr[typingIdx].text = replyClean;

    // 6) Post-procesado:
    if (hasOtherRefs){
      // a) nombres clicables → abre chat
      try { decorateBubbleWithAgentLinks(typingBubble, referredAgents); } catch {}
      // b) tarjetas debajo
      const html = buildReferralCardsHTML(referredAgents);
      addMessage("bot", html, { asHTML: true });
    } else {
      // Sin referrals (o solo a sí mismo): Wikipedia activa
      const threadId = currentThreadId();
      await enrichWithWikiLinks(typingBubble, replyClean, { threadId, msgIndex: typingIdx });
    }

  } catch (err) {
    if (stopSpin) stopSpin();
    const msg = `⚠️ ${err.message}`;
    if (typingBubble){
      typingBubble.innerHTML = renderMarkdown(msg);
      const arr = currentThreadArray();
      if (typingIdx != null && arr[typingIdx]) arr[typingIdx].text = msg;
    } else {
      addMessage("bot", msg);
    }
  } finally {
    setBusy(false);
  }
}



// addMessage con soporte HTML persistente
function addMessage(who, text, opts = {}){
  const arr = currentThreadArray();
  const msg = { role: who, text };
  if (opts.asHTML) msg.__html = true;     // <- preservar HTML (p.ej. tarjetas/referrals)
  if (opts.__wikiInfo) msg.__wikiInfo = true;
  arr.push(msg);
  return renderRow(who, text, msg);        // ← devuelve <div.bubble>
}

async function typeMessage(fullText, bubble) {
  state.typing = true;
  let buffer = "";
  const chunks = chunkString(fullText, 8);
  for (const c of chunks) {
    buffer += c;
    bubble.innerHTML = renderMarkdown(buffer);
    chat.scrollTop = chat.scrollHeight;
    await sleep(20);
  }
  state.typing = false;
}


function setBusy(b){
  sendBtn.disabled = b;
}

// ===== UTIL =====
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
function chunkString(str, size){
  const out = [];
  for (let i=0;i<str.length;i+=size) out.push(str.slice(i, i+size));
  return out;
}
function estimateTokens(text){
  return Math.max(1, Math.round(text.length / 4));
}
function initials(name=""){
  const parts = name.trim().split(/\s+/).slice(0,2);
  return parts.map(p=>p[0]?.toUpperCase()||"").join("");
}
function escapeHTML(s=""){
  return s.replace(/[&<>"']/g, ch => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[ch]));
}
function sanitizeAgentMarkup(s){
  if (!s) return "";
  let out = String(s);
  out = out.replace(/\[([^\]]+)\]\(agent:\/\/[^\)]+\)/gi, '$1'); // [Doc](agent://...) → Doc
  out = out.replace(/agent:\/\/[^\s)]+/gi, '');                  // agent://Doc%20... suelto → (quita)
  return out;
}
function stripKiwixLinks(s){
  if (!s) return "";
  let out = String(s);
  // Dinámico para KIWIX_ORIGIN
  const linkPattern = new RegExp(`\\[([^\\]]+)\\]\\((?:https?:\\/\\/)?${_HOST_RE}[^\\)]*\\)`, "gi");
  const urlPattern  = new RegExp(`\\b(?:https?:\\/\\/)?${_HOST_RE}[^\\s\\)]+`, "gi");
  out = out.replace(linkPattern, '$1');
  out = out.replace(/\[([^\]]+)\]\((?:https?:\/\/)?(?:\w+\.)?wikipedia\.org[^\)]*\)/gi, '$1');
  out = out.replace(urlPattern, '');
  out = out.replace(/\b(?:https?:\/\/)?(?:\w+\.)?wikipedia\.org[^\s)]+/gi, '');
  return out;
}
function toast(msg){
  try {
    if (typeof window.toast === "function") window.toast(msg);
    else addMessage("bot", msg);
  } catch { console.log(msg); }
}

// ===== RECENT AGENTS (últimos 5) 🆕 =====
function loadRecentAgents(){
  try {
    const raw = localStorage.getItem("recentAgents");
    const arr = JSON.parse(raw || "[]");
    if (Array.isArray(arr)) state.recentAgents = arr.slice(0, 5);
  } catch { state.recentAgents = []; }
}
function saveRecentAgents(){
  try { localStorage.setItem("recentAgents", JSON.stringify(state.recentAgents || [])); } catch {}
}

// Crea el contenedor justo bajo el botón "Seleccionar agente" si no existe
function ensureRecentsBar(){
  const btn = document.getElementById('selectAgentBtn');
  if (!btn) return null;

  let bar = document.getElementById('recentAgentsBar');
  if (!bar){
    bar = document.createElement('div');
    bar.id = 'recentAgentsBar';
    bar.className = 'recent-agents';
    btn.parentElement.appendChild(bar);
  }
  return bar;
}



// Inserta/mueve al frente y recorta a 5
function rememberRecentAgent(agent){
  if (!agent || !agent.name) return;
  const key = normName(agent.name); // usa tu normName de referrals
  const filtered = (state.recentAgents || []).filter(a => normName(a.name) !== key);
  filtered.unshift({
    name: agent.name,
    avatar: agent.avatar || "",
    profession: L(agent.profession) || ""
  });
  state.recentAgents = filtered.slice(0, 5);
  saveRecentAgents();
  renderRecentAgentsBar();
}

// Pinta/oculta la fila de avatares 48×48
function renderRecentAgentsBar(){
  const bar = ensureRecentsBar();
  if (!bar) return;

  const list = state.recentAgents || [];
  if (state.mode !== "agents" || !list.length) {
    bar.classList.add("hidden");
    bar.innerHTML = "";
    return;
  }

  bar.classList.remove("hidden");

  bar.innerHTML = list.map(a=>{
    const title = escapeHTML(a.name + (a.profession ? ` — ${a.profession}` : ""));
    if (a.avatar) {
      return `<button class="recent-chip" title="${title}" data-agent-name="${escapeHTML(a.name)}">
                <img src="${a.avatar}" alt="${escapeHTML(a.name)}"/>
              </button>`;
    }
    return `<button class="recent-chip" title="${title}" data-agent-name="${escapeHTML(a.name)}">
              <span class="initials">${escapeHTML(initials(a.name))}</span>
            </button>`;
  }).join("");
}


// útil para matching y normalizaciones
function stripAccents(s){
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// ===== MARKDOWN RENDERER =====
function renderMarkdown(md = "") {
  const lines = String(md || "").split(/\r?\n/);

  let html = "";
  let inUl = false, inOl = false, inP = false, inCode = false;

  const closeP = () => { if (inP) { html += "</p>"; inP = false; } };
  const closeLists = () => {
    if (inUl) { html += "</ul>"; inUl = false; }
    if (inOl) { html += "</ol>"; inOl = false; }
  };
  const closeAll = () => {
    if (inCode) { html += "</code></pre>"; inCode = false; }
    closeP(); closeLists();
  };

  const inline = (s) => {
    s = escapeHTML(s);
    // **bold**
    s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    // *em*  (evita chocar con **)
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    // `code`
    s = s.replace(/`([^`]+?)`/g, "<code>$1</code>");
    // autolink http(s)
    s = s.replace(/\bhttps?:\/\/[^\s<]+/g, (url) =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
    );
    return s;
  };

  for (const raw of lines) {
    const line = raw;

    // ``` fenced code ```
    if (/^\s*```/.test(line)) {
      if (!inCode) {
        closeP(); closeLists();
        html += "<pre><code>";
        inCode = true;
      } else {
        html += "</code></pre>";
        inCode = false;
      }
      continue;
    }
    if (inCode) {
      html += escapeHTML(line) + "\n";
      continue;
    }

    // línea en blanco -> cerrar bloques
    if (/^\s*$/.test(line)) {
      closeP(); closeLists();
      continue;
    }

    // Headings compactos: ### / ####
    let m;
    if ((m = line.match(/^\s*###\s+(.+)$/))) {
      closeAll();
      html += `<h3>${inline(m[1])}</h3>`;
      continue;
    }
    if ((m = line.match(/^\s*####\s+(.+)$/))) {
      closeAll();
      html += `<h4>${inline(m[1])}</h4>`;
      continue;
    }

    // Ordered list: "1. " … (1–2 dígitos)
    if ((m = line.match(/^\s{0,2}(\d{1,2})\.\s+(.*)$/))) {
      closeP();
      if (inUl) { html += "</ul>"; inUl = false; }
      if (!inOl) { html += "<ol>"; inOl = true; }
      html += `<li>${inline(m[2])}</li>`;
      continue;
    }

    // Unordered list: "- " o "* "
    if ((m = line.match(/^\s{0,2}[-*]\s+(.*)$/))) {
      closeP();
      if (inOl) { html += "</ol>"; inOl = false; }
      if (!inUl) { html += "<ul>"; inUl = true; }
      html += `<li>${inline(m[1])}</li>`;
      continue;
    }

    // Párrafo (línea normal)
    if (!inP) { closeLists(); html += "<p>"; inP = true; }
    html += inline(line) + " ";
  }

  closeAll();
  return html.trim();
}


// ===== HILOS DE CHAT =====
function agentKey(a){
  return a ? `${a.name}|${a.personality||""}` : "default";
}
function currentThreadArray(){
  if (state.mode === "agents"){
    if (state.selectedAgent){
      const k = agentKey(state.selectedAgent);
      if (!state.chats.agents[k]) state.chats.agents[k] = [];
      return state.chats.agents[k];
    }
    return [];
  }
  return state.chats.model;
}

function renderRow(who, text, msgObj){
  const row = document.createElement("div");
  row.className = `msg ${who}`;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  if (who === "user"){
    avatar.innerHTML = `<img src="avatars/user.png" alt="You"/>`;
  } else {
    if (state.mode === "agents" && state.selectedAgent?.avatar){
      avatar.innerHTML = `<img src="${state.selectedAgent.avatar}" alt="${state.selectedAgent.name}"/>`;
    } else {
      avatar.innerHTML = `<img src="avatars/model_only.png" alt="Model Only"/>`;
    }
  }

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (msgObj && msgObj.__html) {
    bubble.innerHTML = msgObj.text;              // <- preservar HTML (p.ej. tarjetas/referrals)
  } else {
    bubble.innerHTML = renderMarkdown(text);
  }

  row.appendChild(avatar);
  row.appendChild(bubble);
  chat.appendChild(row);
  chat.scrollTop = chat.scrollHeight;

  return bubble;
}

function renderConversation(){
  chat.innerHTML = "";
  const arr = currentThreadArray();
  const tid = currentThreadId();
  const cache = state.wikiLinks[tid] || {};

  for (let i=0; i<arr.length; i++){
    const m = arr[i];
    const bubble = renderRow(m.role, m.text, m);
    // Si hay cache de enlaces para este mensaje bot y NO es html crudo, re-decora inline
    if (m.role === "bot" && !m.__html && cache[i] && Array.isArray(cache[i]) && cache[i].length){
      try { decorateBubbleForWiki(bubble, cache[i]); } catch {}
    }
  }
  restoreCurrentScroll();
}

// Normaliza saludo antiguo → nuevo
function normalizeModelGreeting(){
  const arr = state.chats.model || [];
  if (!arr.length) return;
  const first = arr[0];
  if (first && first.role === "bot") {
    if (/Registro de supervivencia iniciado|Survivor log initiated|Journal de survie démarré/i.test(first.text)) {
      first.text = t("survivorInit");
      renderConversation();
    }
  }
}
// Asegura saludo inicial del LLM en arranque en frío
function ensureInitialGreeting(){
  if (state.mode === 'llm' && (!state.chats.model || state.chats.model.length === 0)) {
    addMessage('bot', t('survivorInit')); // saludo sin wiki
    renderConversation();
  }
}
// ===== SCROLL HELPERS =====
function currentThreadId(){
  if (state.mode === "agents" && state.selectedAgent){
    return `agent:${agentKey(state.selectedAgent)}`;
  }
  if (state.mode === "llm") return "model";
  return null;
}
function saveCurrentScroll(){
  const id = currentThreadId();
  if (!id || !chat) return;
  if (!state.scroll) state.scroll = {};
  state.scroll[id] = chat.scrollTop || 0;
}
function restoreCurrentScroll(){
  const id = currentThreadId();
  if (!id || !chat) return;
  const top = (state.scroll && typeof state.scroll[id] === "number") ? state.scroll[id] : null;
  if (top == null){
    chat.scrollTop = chat.scrollHeight;
  } else {
    const maxTop = Math.max(0, chat.scrollHeight - chat.clientHeight);
    chat.scrollTop = Math.min(Math.max(0, top), maxTop);
  }
}
function purgeTrailingWikiInfoForCurrentThread(){
  const arr = currentThreadArray();
  if (!arr || !arr.length) return;
  let removed = false;
  while (arr.length && arr[arr.length - 1].__wikiInfo) {
    arr.pop();                  // quita SOLO los avisos del final
    removed = true;
  }
  if (removed) renderConversation(); // re-pintamos; no afecta índices previos
}

// ===== TYPING SPINNER =====
function startTypingIndicator(bubble, label){
  const frames = ["|","/","-","\\"];
  let i = 0;
  let stopped = false;

  function paint(){
    if (stopped) return;
    bubble.textContent = `${label} ${frames[i]}`;
    i = (i + 1) % frames.length;
  }
  paint();
  const id = setInterval(paint, 120);

  return function stop(){
    stopped = true;
    clearInterval(id);
  };
}

// ===== BATTERY =====
async function setupBattery(){
  if (navigator.getBattery){
    try{
      const batt = await navigator.getBattery();
      const update = ()=>{
        const pct = Math.round(batt.level * 100);
        batteryFill.style.width = pct + "%";
        batteryPct.textContent = pct + "%";
      };
      update();
      batt.addEventListener("levelchange", update);
    }catch{
      fallbackBattery();
    }
  }else{
    fallbackBattery();
  }
}

function fallbackBattery(){
  batteryFill.style.width = "100%";
  batteryPct.textContent = "AC";
}

// ===== BACKEND STATUS =====
async function showBackendModel(){
  try{
    const res = await fetch(`${BASE_URL}/api/status`);
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = await res.json();
    if (info && info.model_file){
      state.modelFile = info.model_file;
      state.lang = info.lang || state.lang || "en";
      state.lang_label = info.lang_label || state.lang_label;
      state.lang_flag = info.lang_flag || state.lang_flag;
      setActiveModelTag(info);
    }

    const savedLangOverride = localStorage.getItem("langOverride");
    if (savedLangOverride && SUPPORTED_LANGS[savedLangOverride]) {
      state.lang = savedLangOverride;
      state.lang_label = SUPPORTED_LANGS[savedLangOverride].label;
      state.lang_flag = SUPPORTED_LANGS[savedLangOverride].flag;
    }

    return true;
  }catch(e){
    // silencioso
  }
  return false;
}

// ===== WIKI LINKING CORE =====
function getZimIdForLang(lang){
  if (state.wiki && state.wiki.zimId) return state.wiki.zimId;
  if (lang === "es") return "wikipedia_es_all_maxi_2025-08";
  if (lang === "fr") return "wikipedia_fr_all_maxi_2025-06";
  return "wikipedia_en_all_maxi_2025-08";
}
function encodeWikiTitle(title){
  return encodeURIComponent(String(title).trim().replace(/\s+/g, "_"));
}

// Variantes mínimas para probar el mismo título tal cual y capitalizado
function buildDirectTitleVariants(raw){
  const t = String(raw||"").trim().replace(/\s+/g, " ");
  if (!t) return [];
  const variants = [t, ucFirstWord(t), titleCase(t)];
  return Array.from(new Set(variants));
}

// Intenta abrir DIRECTO el artículo usando /content/<zimId>/<Title>
async function openDirectByContent(raw){
  await ensureWikiReady();
  const zimId = state.wiki.zimId || getZimIdForLang(state.lang);

  for (const title of buildDirectTitleVariants(raw)){
    const enc = encodeWikiTitle(title);
    const contentUrl = `${KIWIX_ORIGIN}/content/${zimId}/${enc}`;

    try {
      const head = await fetch(contentUrl, { method: "HEAD" });
      if (head.ok) {
        const viewerUrl = `${KIWIX_ORIGIN}/viewer#${zimId}/${enc}`;
        state.wiki.pendingUrl = viewerUrl;
        setMode("wiki");
        return true;
      }
    } catch {}
  }
  return false;
}

async function ensureWikiReady(){
  if (state.wiki.started && state.wiki.zimId) return;
  try {
    const r = await fetch(`${BASE_URL}/api/wiki?lang=${state.lang}`);
    const data = await r.json().catch(()=>null);
    if (data && data.status === "ok" && data.zim_file) {
      state.wiki.zimId = data.zim_file.replace(/\.zim$/,"");
    }
  } catch {}
  state.wiki.started = true;
}

// ===== STOPWORDS / utilidades n-gramas / estilos botón rápido =====
const BASE_STOP = {
  es: [
    "el","la","los","las","lo","un","una","unos","unas","al","del",
    "este","esta","estos","estas","ese","esa","esos","esas","aquel","aquella","aquellos","aquellas",
    "mi","mis","tu","tus","su","sus","nuestro","nuestra","nuestros","nuestras",
    "vuestro","vuestra","vuestros","vuestras","cualquier","ningun","ningún","ninguna","alguno","alguna",
    "algunos","algunas","otro","otra","otros","otras","cada","mismo","misma","mismos","mismas",
    "yo","tú","tu","usted","ustedes","vos","vosotros","vosotras",
    "él","el","ella","ello","ellos","ellas","se","me","te","nos","os","le","les","lo","la","los","las",
    "y","e","o","u","ni","pero","sino","aunque","que","porque","pues","si","sí","mas","más","sin","embargo",
    "a","ante","bajo","cabe","con","contra","de","desde","durante","en","entre","hacia","hasta","mediante",
    "para","por","segun","según","sin","so","sobre","tras","via",
    "que","qué","quien","quién","quienes","quiénes","cual","cuál","cuales","cuáles",
    "cuanto","cuánto","cuanta","cuánta","cuantos","cuántos","cuantas","cuántas",
    "donde","dónde","adonde","adónde","como","cómo","cuando","cuándo",
    "no","sí","ya","aun","aún","aqui","aquí","ahi","ahí","alli","allí","alla","allá",
    "muy","mas","más","menos","tan","tanto","tanta","tantos","tantas",
    "tambien","también","tampoco","siempre","nunca","quizá","quizas","quizás",
    "solo","sólo","apenas","casi","hoy","ayer","mañana","manana","ahora","antes","despues","después","luego",
    "igual","todavia","todavía","a veces","aveces",
    "cero","uno","una","dos","tres","cuatro","cinco","seis","siete","ocho","nueve",
    "diez","once","doce","trece","catorce","quince","veinte",
    "lunes","martes","miercoles","miércoles","jueves","viernes","sabado","sábado","domingo",
    "enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","setiembre",
    "octubre","noviembre","diciembre",
    "hola","adios","adiós","chao","chau","buen","buenos","buenas",
    "gracias","favor","porfavor","por","favor","de","nada","disculpa","disculpe","perdon","perdón","vale","ok","okay","okey",
    "ser","soy","eres","es","somos","son",
    "estar","estoy","estas","estás","esta","está","estais","estáis","estan","están",
    "haber","he","has","ha","hemos","han","hay","habia","había","hubo","habra","habrá",
    "ir","voy","vas","va","vamos","van",
    "poder","puedo","puedes","puede","podemos","pueden",
    "querer","quiero","quieres","quiere","queremos","quieren",
    "hacer","hago","haces","hace","hacemos","hacen",
    "decir","digo","dices","dice","decimos","dicen",
    "ver","veo","ves","ve","ven","vio",
    "dar","doy","das","da","damos","dan",
    "saber","se","sé","sabes","sabe","sabemos","saben",
    "venir","vengo","vienes","viene","venimos","vienen",
    "poner","pongo","pones","pone","ponemos","ponen",
    "salir","salgo","sales","sale","salimos","salen",
    "tema","temas","pregunta","preguntas","respuesta","respuestas",
    "problema","problemas","solucion","solución","soluciones",
    "consejo","consejos","ayuda","ayudas","ejemplo","ejemplos",
    "paso","pasos","lista","listas","nota","notas","idea","ideas",
    "truco","trucos","cosa","cosas","gente","persona","personas",
    "alguien","nadie","todos","todas","todo","toda","parte","partes",
    "tipo","tipos","forma","formas","manera","maneras","nivel","niveles",
    "modo","modos","caso","casos","veces","tiempo","dia","día",
    "noche","semana","mes","año","anos","años","lugar","lugares","zona","zonas","sitio","sitios",
    "incluso","entonces","tambien","también"
  ],
  en: [
    "the","a","an","some","any","each","every","either","neither","both","other","another","such",
    "this","that","these","those","my","mine","your","yours","his","her","hers","our","ours","their","theirs",
    "i","me","we","us","you","he","him","she","her","it","they","them","one","ones","someone","anyone","everyone","noone","nobody","somebody",
    "and","or","but","nor","so","yet","if","then","than","because","while","although","though","however",
    "of","to","in","on","at","for","from","by","with","as","about","into","onto","over","under","above","below",
    "between","among","before","after","during","through","across","against","without","within","around","near","via","per",
    "not","no","yes","also","too","very","just","still","even","only","here","there","now","then","soon","late","early",
    "today","tonight","yesterday","tomorrow","how","why","where","when",
    "zero","one","two","three","four","five","six","seven","eight","nine","ten","eleven","twelve",
    "monday","tuesday","wednesday","thursday","friday","saturday","sunday",
    "jan","feb","mar","apr","may","jun","jul","aug","sep","sept","oct","nov","dec",
    "hi","hello","hey","thanks","thank","please","pls","sorry","bye","goodbye","welcome","ok","okay","yep","yup","nope",
    "be","am","is","are","was","were","been","being",
    "have","has","had","having",
    "do","does","did","done","doing",
    "will","would","can","could","may","might","must","shall","should",
    "go","goes","went","gone","get","gets","got",
    "make","makes","made","do","does","did",
    "say","says","said","see","saw","seen",
    "know","knew","known","want","wants","wanted",
    "need","needs","needed","like","likes","liked",
    "love","hate","tell","tells","told","give","gives","gave",
    "find","finds","found","take","takes","took","come","comes","came",
    "use","uses","used","try","tries","tried","work","works","call","calls","called",
    "thing","things","people","person","place","time","case","part","type","way","level","mode",
    "good","bad","best","worst","new","old","same","other"
  ],
  fr: [
    "le","la","les","un","une","des","du","de","d","au","aux","ce","cet","cette","ces","mon","ma","mes",
    "ton","ta","tes","son","sa","ses","notre","nos","votre","vos","leur","leurs",
    "je","tu","il","elle","on","nous","vous","ils","elles",
    "me","te","se","lui","leur","le","la","les","y","en","moi","toi","soi","celui","celle","ceux","celles",
    "et","ou","mais","ni","donc","or","car","si","que","quoique","bienque","parce","que","comme","lorsque","puisque",
    "à","a","chez","dans","sur","sous","entre","vers","avec","sans","pour","par","selon","contre","avant","apres","après",
    "depuis","pendant","derriere","derrière","devant","autour","parmi","jusque","jusqu a","jusqu’à","outre",
    "oui","non","bien","mal","tres","très","peu","plus","moins","aussi","encore","deja","déjà","jamais","toujours",
    "souvent","parfois","peutetre","peut-être","ici","la","là","la-bas","là-bas","hier","demain","maintenant",
    "qui","que","quoi","ou","où","quand","comment","pourquoi","lequel","laquelle","lesquels","lesquelles",
    "zero","zéro","un","deux","trois","quatre","cinq","six","sept","huit","neuf","dix","onze","douze",
    "lundi","mardi","jeudi","samedi","dimanche","mercredi","vendredi",
    "jan","fev","fév","mar","avr","mai","juin","juil","aout","août","sep","oct","nov","dec","déc",
    "bonjour","salut","bonsoir","merci","svp","ok","daccord","d'accord","pardon",
    "etre","être","suis","es","est","sommes","etes","êtes","sont",
    "avoir","ai","as","a","avons","avez","ont",
    "aller","vais","vas","va","allons","allez","vont",
    "pouvoir","peux","peut","peuvent",
    "devoir","dois","doit","devons",
    "vouloir","veux","veut",
    "venir","viens","vient","venons",
    "faire","fais","fait",
    "dire","dis","dit","dites","disent",
    "voir","vois","voit","voyons","voient",
    "savoir","sais","sait","savons","savez","savent",
    "chose","choses","gens","personne","personnes","temps","jour","nuit","semaine","mois","annee","année",
    "cas","partie","type","types","maniere","manière","façon","façons","niveau","niveaux","mode","modes"
  ]
};

const MONTHS = {
  es: ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"],
  en: ["january","february","march","april","may","june","july","august","september","october","november","december"],
  fr: ["janvier","février","fevrier","mars","avril","mai","juin","juillet","août","aout","septembre","octobre","novembre","décembre","decembre"]
};

// Set global con todas las variantes normalizadas (sin tildes)
const MONTH_SET_ALL = (() => {
  const s = new Set();
  for (const arr of Object.values(MONTHS)) {
    for (const w of arr) s.add(normKey(w));
  }
  return s;
})();

// Devuelve true si alguno de los tokens del término es un mes (en ES/EN/FR)
function containsMonthWord(term) {
  const tokens = String(term||"").split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    if (MONTH_SET_ALL.has(normKey(tok))) return true;
  }
  return false;
}

function withCapitalizedVariants(list, locale){
  const out = new Set();
  for (const w of list){
    if (!w) continue;
    const s = String(w).normalize("NFC");
    out.add(s);
    const cap = s.charAt(0).toLocaleUpperCase(locale) + s.slice(1);
    out.add(cap);
  }
  return out;
}

const STOPWORDS = {
  es: withCapitalizedVariants(BASE_STOP.es, "es-ES"),
  en: withCapitalizedVariants(BASE_STOP.en, "en-US"),
  fr: withCapitalizedVariants(BASE_STOP.fr, "fr-FR")
};
function themePalette(){
  const theme = document.documentElement.getAttribute("data-theme") || "light";
  if (theme === "dark") {
    return {
      bg:        "rgba(5,10,17,.6)",
      fg:        "#e6e8ea",
      border:    "rgba(235,245,255,.16)",
      hoverBg:   "rgba(235,245,255,.10)",
      shadow:    "0 8px 24px rgba(0,0,0,.35)",
      warnBg:    "rgba(255, 196, 0, .12)",
      warnBorder:"rgba(255, 196, 0, .35)",
      warnFg:    "#ffd24d",
      mutedFg:   "rgba(230,232,234,.7)"
    };
  }
  return {
    bg:        "rgba(255,255,255,.9)",
    fg:        "#1f2937",
    border:    "rgba(15,23,42,.12)",
    hoverBg:   "rgba(2,6,23,.06)",
    shadow:    "0 10px 30px rgba(2,6,23,.12)",
    warnBg:    "rgba(255, 211, 77, .18)",
    warnBorder:"rgba(255, 196, 0, .35)",
    warnFg:    "#8a5a00",
    mutedFg:   "rgba(31,41,55,.6)"
  };
}

function styleQuickBtn(btn, variant = "normal"){
  const p = themePalette();
  btn.style.position = "absolute";
  btn.style.zIndex = "9999";
  btn.style.height = "32px";
  btn.style.padding = "0 12px";
  btn.style.borderRadius = "999px";
  btn.style.border = `1px solid ${variant==="warning" ? p.warnBorder : p.border}`;
  btn.style.background = (variant==="warning") ? p.warnBg : p.bg;
  btn.style.color = (variant==="warning") ? p.warnFg : p.fg;
  btn.style.fontSize = "12px";
  btn.style.fontWeight = "600";
  btn.style.lineHeight = "32px";
  btn.style.cursor = "pointer";
  btn.style.boxShadow = p.shadow;
  btn.style.whiteSpace = "nowrap";
  btn.style.backdropFilter = "blur(6px)";
  btn.style.userSelect = "none";

  if (variant === "loading") {
    btn.style.opacity = "0.85";
    btn.style.pointerEvents = "none";
    btn.style.color = p.mutedFg;
  } else {
    btn.style.opacity = "1";
    btn.style.pointerEvents = "auto";
  }

  btn.dataset.variant = variant;

  btn.onmouseenter = ()=>{
    if (btn.dataset.variant === "normal") {
      btn.style.background = themePalette().hoverBg;
    }
  };
  btn.onmouseleave = ()=>{
    styleQuickBtn(btn, btn.dataset.variant || "normal");
  };
}

function refreshWikiQuickBtnStyle(){
  if (wikiQuickBtn && wikiQuickBtn.style.display !== "none") {
    styleQuickBtn(wikiQuickBtn, wikiQuickBtn.dataset.variant || "normal");
  }
}




function normalizeForNgrams(s){
  return String(s || "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[*_~`#>]+/g, " ")
    .replace(/[.,;:!?¡¿()\[\]{}"“”'‘’«»<>…—–\-_/\\|·•]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeWordsSimple(s){
  const words = String(s || "").split(" ").filter(Boolean);
  return words.map(w => ({ raw: w, lower: w.toLowerCase() }));
}
function normKey(s){
  return stripAccents(String(s||"")).toLowerCase();
}
function isStopWord(word){
  const sw = STOPWORDS[state.lang] || STOPWORDS.es;
  return sw.has(normKey(word));
}
function buildAccentMap(s){
  let base = "";
  const map = [];
  let origIndex = 0;
  for (const ch of s){
    const n = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    for (let k=0;k<n.length;k++){
      base += n[k];
      map.push(origIndex);
    }
    origIndex += ch.length;
  }
  return { base, map };
}

// ===== Detección de desambiguación =====
function looksLikeDisambigHtml(html){
  const s = stripAccents(String(html||"")).toLowerCase();
  const needles = [
    "puede referirse a:",
    "desambiguacion",
    "may refer to:",
    "disambiguation",
    "peut designer :",
    "page d'homonymie",
    "homonymie",
    'id="disambigbox"',
    "mw-disambig"
  ];
  const catNeedles = [
    "categoria:wikipedia:desambiguacion",
    "categoria:desambiguacion",
    "category:disambiguation pages",
    "categorie:homonymie",
    "catégorie:homonymie"
  ];
  return needles.some(n => s.includes(n)) || catNeedles.some(n => s.includes(n));
}

// ===== Variantes de título y canónico =====
function ucFirstWord(w){
  if (!w) return w;
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}
function titleCase(s){
  return s.split(/\s+/).map(ucFirstWord).join(" ");
}
function titleVariants(raw){
  const t = String(raw||"").trim().replace(/\s+/g," ");
  const na = stripAccents(t);
  const vars = new Set();
  vars.add(t);
  vars.add(ucFirstWord(t));
  vars.add(titleCase(t));
  vars.add(na);
  vars.add(ucFirstWord(na));
  vars.add(titleCase(na));
  return Array.from(vars).filter(v => v.length);
}

// Verificación real de artículos
async function probeTitle(zimId, title){
  const url = `${KIWIX_ORIGIN}/content/${zimId}/${encodeWikiTitle(title)}`;
  try {
    const h = await fetch(url, { method: "HEAD" });
    if (!h.ok) {
      if (h.status === 404) return { ok:false, disambig:false };
    } else {
      const g = await fetch(url, { method: "GET" });
      if (g.ok) {
        const txt = await g.text().catch(()=> "");
        const dis = looksLikeDisambigHtml(txt);
        return { ok: !dis, disambig: dis };
      }
      return { ok:false, disambig:false };
    }
  } catch {}
  try {
    const g = await fetch(url, { method: "GET" });
    if (!g.ok) return { ok:false, disambig:false };
    const txt = await g.text().catch(()=> "");
    const dis = looksLikeDisambigHtml(txt);
    return { ok: !dis, disambig: dis };
  } catch {
    return { ok:false, disambig:false };
  }
}

async function findExistingTitle(rawTitle){
  await ensureWikiReady();
  const zimId = state.wiki.zimId || getZimIdForLang(state.lang);
  const nkey = `${zimId}|${normKey(rawTitle)}`;

  if (Object.prototype.hasOwnProperty.call(state.wikiCanon, nkey)) {
    return state.wikiCanon[nkey];
  }

  const variants = titleVariants(rawTitle);
  for (const v of variants){
    const cacheKey = `${zimId}|${encodeWikiTitle(v)}`;
    if (Object.prototype.hasOwnProperty.call(state.wikiExist, cacheKey)) {
      if (state.wikiExist[cacheKey]) { state.wikiCanon[nkey] = v; return v; }
      continue;
    }
    const pr = await probeTitle(zimId, v);
    state.wikiExist[cacheKey] = pr.ok;
    if (pr.ok) { state.wikiCanon[nkey] = v; return v; }
  }
  state.wikiCanon[nkey] = null;
  return null;
}

async function wikiTitleExists(title){
  const canon = await findExistingTitle(title);
  return !!canon;
}

async function openWikiArticle(title){
  await ensureWikiReady();
  const canon = await findExistingTitle(title);
  if (!canon) {
    toast("⚠️ Artículo no encontrado en Wikipedia offline.");
    return;
  }
  const zimId = state.wiki.zimId || getZimIdForLang(state.lang);
  const url = `${KIWIX_ORIGIN}/viewer#${zimId}/${encodeWikiTitle(canon)}`;
  state.wiki.url = url;
  state.wiki.pendingUrl = url;
  setMode("wiki");
}

// —— KIWIX SEARCH HELPERS ——
function pickFirstSearchResultFromHtml(html, zimId){
  let doc;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return null;
  }
  if (!doc) return null;

  const a = doc.querySelector(
    `a[href^="/content/${zimId}/"], #results a[href^="/content/${zimId}/"], .results a[href^="/content/${zimId}/"]`
  );
  if (!a) return null;

  const href = a.getAttribute("href") || "";
  if (!href.startsWith(`/content/${zimId}/`)) return null;

  const tail = href.split(`/content/${zimId}/`)[1];
  if (!tail) return null;

  return `${KIWIX_ORIGIN}/viewer#${zimId}/${tail}`;
}

async function kiwixSearchAndOpen(query, max = 5){
  await ensureWikiReady();
  const zimId = state.wiki.zimId || getZimIdForLang(state.lang);

  const base = `${KIWIX_ORIGIN}/search?content=${encodeURIComponent(zimId)}&pattern=${encodeURIComponent(query)}&max=${max}`;

  // Intento JSON explícito
  try {
    const rj = await fetch(base + `&format=json`);
    if (rj.ok) {
      const data = await rj.json().catch(()=>null);
      const first = data && (data.results?.[0] || data[0]) || null;
      const title = first && (first.title || first.display || first.name || first.article || first.filename);
      if (title) {
        const articleUrl = `${KIWIX_ORIGIN}/viewer#${zimId}/${encodeWikiTitle(title)}`;
        state.wiki.pendingUrl = articleUrl;
        setMode("wiki");
        return true;
      }
    }
  } catch {}

  // Fallback: parsear HTML
  try {
    const rh = await fetch(base);
    if (rh.ok) {
      const html = await rh.text();
      const articleUrl = pickFirstSearchResultFromHtml(html, zimId);
      if (articleUrl) {
        state.wiki.pendingUrl = articleUrl;
        setMode("wiki");
        return true;
      }
    }
  } catch {}

  return false;
}

async function tryOpenExactArticle(query){
  try {
    const resolved = await resolveWikiTitles([query], 1);
    if (resolved && resolved.length && resolved[0].title) {
      await openWikiArticle(resolved[0].title);
      return true;
    }
  } catch {}
  return false;
}

function getWikiSearchPageTitle(lang){
  if (lang === "es") return "Especial:Buscar";
  if (lang === "fr") return "Spécial:Recherche";
  return "Special:Search";
}
function buildViewerArticleUrl(title){
  const zimId = state.wiki.zimId || getZimIdForLang(state.lang);
  return `${KIWIX_ORIGIN}/viewer#${zimId}/${encodeWikiTitle(title)}`;
}
function buildViewerSearchUrl(query){
  const zimId = state.wiki.zimId || getZimIdForLang(state.lang);
  const page = getWikiSearchPageTitle(state.lang);
  const q = encodeURIComponent(query);
  return `${KIWIX_ORIGIN}/viewer#${zimId}/${encodeWikiTitle(page)}?search=${q}&fulltext=1`;
}

// ===== QUICK WIKI FROM SELECTION =====
let wikiQuickBtn = null;

function hideWikiQuickUI(){
  if (wikiQuickBtn) {
    wikiQuickBtn.style.display = "none";
    wikiQuickBtn.removeAttribute("data-query");
    wikiQuickBtn.dataset.variant = "normal";
    wikiQuickBtn.textContent = `🔎 ${t("searchInWikipedia")}`;
    wikiQuickBtn.dataset.query = "";
    wikiQuickBtn.classList.remove("warning");
    wikiQuickBtn.style.pointerEvents = "auto";
  }
  document.querySelectorAll('.wiki-quick-popup').forEach(n => n.remove());
}

function selectionInsideBotBubble(){
  const sel = window.getSelection && window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const text = String(sel.toString() || "").trim();
  if (!text) return null;
  const container = range.commonAncestorContainer;
  const host = (container.nodeType === 1 ? container : container.parentElement);
  const bubble = host && host.closest && host.closest(".msg.bot .bubble");
  if (!bubble) return null;
  return { text, range, bubble };
}

function showWikiQuickButtonForSelection(){
  const selInfo = selectionInsideBotBubble();
  if (!selInfo) { hideWikiQuickUI(); return; }

  const query = selInfo.text.trim();
  if (!query || query.length > 200) { hideWikiQuickUI(); return; }

  const rect = selInfo.range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) { hideWikiQuickUI(); return; }

  const left = window.scrollX + rect.right + 8;
  const top  = window.scrollY + rect.top  - 8;

  if (wikiQuickBtn && wikiQuickBtn.dataset.variant === "warning") {
    const current = (wikiQuickBtn.dataset.query || "").trim();
    if (current === query) {
      wikiQuickBtn.style.left = left + "px";
      wikiQuickBtn.style.top  = top  + "px";
      wikiQuickBtn.style.display = "block";
      return;
    }
  }

  if (!wikiQuickBtn) {
    wikiQuickBtn = document.createElement("button");
    wikiQuickBtn.type = "button";
    wikiQuickBtn.className = "wiki-quick-btn";
    document.body.appendChild(wikiQuickBtn);

    wikiQuickBtn.addEventListener("click", async (e)=>{
      e.stopPropagation();
      const q = (wikiQuickBtn.dataset.query || "").trim();
      if (!q) return;

      wikiQuickBtn.textContent = "🔎 …";
      styleQuickBtn(wikiQuickBtn, "loading");

      const ok = await searchSelectionInWiki(q);

      if (ok) {
        hideWikiQuickUI();
      } else {
        showWikiWarning();
      }
    });
  }

  wikiQuickBtn.textContent = `🔎 ${t("searchInWikipedia")}`;
  wikiQuickBtn.dataset.query = query;
  styleQuickBtn(wikiQuickBtn, "normal");

  wikiQuickBtn.style.left = left + "px";
  wikiQuickBtn.style.top  = top  + "px";
  wikiQuickBtn.style.display = "block";

}

function showWikiWarning(msg){
  if (!wikiQuickBtn) return;
  const txt = msg || t("noArticleFound");
  wikiQuickBtn.textContent = `⚠️ ${txt}`;
  styleQuickBtn(wikiQuickBtn, "warning");
}

function onDocClickHideQuickUI(e){
  if (wikiQuickBtn && wikiQuickBtn.contains(e.target)) return;
  hideWikiQuickUI();
}

async function searchSelectionInWiki(rawText){
  await ensureWikiReady();
  const query = normalizeForNgrams(rawText) || String(rawText || "").trim();
  if (!query) return false;

  // 1) Intento exacto (NO desambiguación)
  try {
    const resolved = await resolveWikiTitles([query], 1);
    if (resolved && resolved.length && resolved[0].title) {
      await openWikiArticle(resolved[0].title);
      return true;
    }
  } catch {}

  // 2) Fallback: /search del servidor Kiwix → primer resultado
  if (await kiwixSearchAndOpen(query, 8)) return true;

  return false;
}

// === Construye la allow-list por ventanas deslizantes 6..2 ===
async function buildAllowListByNgrams(plainText){
  await ensureWikiReady();

  const norm = normalizeForNgrams(plainText);
  const tokens = tokenizeWordsSimple(norm);
  if (!tokens.length) return [];

  const isCovered = new Array(tokens.length).fill(false);
  const chosen = [];

  function variantsForWindow(s, e){
    const out = [];

    const add = (ss, ee) => {
      if (ss > ee) return;
      const tokenCount = ee - ss + 1;
      if (tokenCount < 2) return;

      if (tokenCount === 2) {
        const w1 = tokens[ss].raw;
        const w2 = tokens[ee].raw;
        if (isStopWord(w1) || isStopWord(w2)) return;
      }

      let allStop = true;
      for (let k = ss; k <= ee; k++){
        if (!isStopWord(tokens[k].raw)) { allStop = false; break; }
      }
      if (allStop) return;

      const term = tokens.slice(ss, ee + 1).map(t => t.raw).join(" ");
      // ❌ No enlazar si el término contiene meses (evita fechas/eventos por mes)
      if (containsMonthWord(term)) return;

      if (term.replace(/\s/g, "").length < 4) return;
      if (/\d{3,}/.test(term)) return;

      out.push({ start: ss, end: ee, term });
    };

    add(s, e);

    let s2 = s;
    while (s2 <= e && isStopWord(tokens[s2].raw)) s2++;
    add(s2, e);

    let s3 = s2, e3 = e;
    while (e3 >= s3 && isStopWord(tokens[e3].raw)) e3--;
    add(s3, e3);

    const uniq = [];
    const seen = new Set();
    for (const v of out){
      const k = `${v.start}-${v.end}-${normKey(v.term)}`;
      if (!seen.has(k)){ seen.add(k); uniq.push(v); }
    }
    return uniq;
  }

  for (let n = 6; n >= 2; n--){
    const windows = [];
    const allTerms = [];
    for (let i = 0; i <= tokens.length - n; i++){
      let overlap = false;
      for (let k=0; k<n; k++){ if (isCovered[i+k]) { overlap = true; break; } }
      if (overlap) continue;

      const s = i, e = i + n - 1;
      const vars = variantsForWindow(s, e);
      if (!vars.length) continue;

      windows.push({ i, vars });
      for (const v of vars) allTerms.push(v.term);
    }

    if (!windows.length) continue;

    const resolved = await resolveWikiTitles(allTerms);
    const resMap = new Map(resolved.map(x => [normKey(x.term), x.title]));

    windows.sort((a,b)=> a.i - b.i);
    for (const w of windows){
      let fullOverlap = true;
      for (let k=0; k<n; k++){ if (!isCovered[w.i + k]) { fullOverlap = false; break; } }
      if (fullOverlap) continue;

      let picked = null;
      for (const v of w.vars){
        let free = true;
        for (let k=v.start; k<=v.end; k++){ if (isCovered[k]) { free = false; break; } }
        if (!free) continue;

        const title = resMap.get(normKey(v.term));
        if (!title) continue;

        picked = { term: v.term, title, start: v.start, end: v.end };
        break;
      }

      if (picked){
        chosen.push({ term: picked.term, title: picked.title });
        for (let k=picked.start; k<=picked.end; k++) isCovered[k] = true;
      }
    }
  }

  return chosen;
}

function extractWikiCandidates(text){
  const found = new Set();
  const pushIfGood = (raw)=>{
    let v = (raw||"").trim().replace(/[.,;:!?()«»"'“”‘’–—\-]+$/,'');
    if (!v) return;
    v = v.replace(/\s+/g, ' ');

    if (!v.includes(' ')) return;
    const parts = v.split(' ');
    while (parts.length && isStopWord(parts[0])) parts.shift();
    while (parts.length && isStopWord(parts[parts.length-1])) parts.pop();
    v = parts.join(' ');
    if (!v) return;
    if (!v.includes(' ')) return;
    if (parts.length === 2 && (isStopWord(parts[0]) || isStopWord(parts[1]))) return;
    if (v.replace(/\s/g,'').length < 5) return;

    if (/[0-9]/.test(v)) return;
    if (containsMonthWord(v)) return;   // ❌ bloquea términos con meses
    found.add(v);
  };

  const sci =
    /([A-ZÁÉÍÓÚÑ][\p{L}\-\.]{2,}\s+(?:×\s*)?[a-záéíóúñ\-\.]{2,}(?:\s+(?:var\.|subsp\.|ssp\.|cf\.)\s*[a-záéíóúñ\-\.]{2,}){0,3})/gu;
  let m;
  while ((m = sci.exec(text)) !== null) pushIfGood(m[1]);

  const connector = '(?:de|del|la|las|los|y|e|da|do|das|dos|du|des|di|of|the|et|à|de la)';
  const word      = '(?:[A-ZÁÉÍÓÚÑ][\\p{L}\\-\\.]{2,}|[a-záéíóúñ][\\p{L}\\-\\.]{3,})';
  const phraseRe  = new RegExp(`\\b(${word}(?:\\s+(?:${connector}|${word})){0,5})\\b`, 'gu');
  while ((m = phraseRe.exec(text)) !== null) pushIfGood(m[1]);

  return Array.from(found);
}

function sanitizeTerm(term){
  return String(term||"")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[*_~`#>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function resolveWikiTitles(candidates, max = Infinity){
  if (!Array.isArray(candidates) || !candidates.length) return [];

  const seen = new Set();
  const unique = [];
  for (const cRaw of candidates) {
    const c = sanitizeTerm(cRaw);
    if (!c) continue;
    if (containsMonthWord(c)) continue;   // otra red de seguridad
    const key = normKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
  }

  if (typeof state.backendWikiResolve === "undefined") {
    state.backendWikiResolve = true;
  }

  let prelim = [];
  const BATCH = 100;
  for (let i=0; i<unique.length; i+=BATCH) {
    const chunk = unique.slice(i, i+BATCH);

    if (state.backendWikiResolve === false) {
      prelim.push(...chunk.map(term => ({ term, title: term })));
      continue;
    }

    try {
      const res = await fetch(`${BASE_URL}/api/wiki/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lang: state.lang, titles: chunk })
      });

      if (res.ok) {
        const data = await res.json().catch(()=> ({}));
        const map = new Map();
        if (data && Array.isArray(data.found)) {
          for (const it of data.found) {
            const disp = it.display || it.title || "";
            const q = it.query || it.title || it.display || "";
            if (disp && q) map.set(q, disp);
          }
        }
        for (const term of chunk) {
          prelim.push({ term, title: map.get(term) || term });
        }
      } else {
        state.backendWikiResolve = false;
        prelim.push(...chunk.map(term => ({ term, title: term })));
      }
    } catch {
      state.backendWikiResolve = false;
      prelim.push(...chunk.map(term => ({ term, title: term })));
    }
  }

  const out = [];
  const CONCURRENCY = 8;
  let idx = 0;

  async function worker(){
    while (idx < prelim.length) {
      if (max !== Infinity && out.length >= max) return;
      const i = idx++;
      const it = prelim[i];
      if (!it.title || it.title.length < 2) continue;
      const canon = await findExistingTitle(it.title);
      if (canon) out.push({ term: it.term, title: canon });
    }
  }
  await Promise.all(Array.from({length: CONCURRENCY}, worker));
  return out;
}

function decorateBubbleForWiki(bubble, allowList){
  if (!bubble || !Array.isArray(allowList) || !allowList.length) return;

  const items = [...allowList]
    .map(x => ({
      term: x.term,
      title: x.title,
      key: normKey(x.term),
      baseLower: normKey(x.term)
    }))
    .sort((a,b)=> b.term.length - a.term.length);

  const usedKeys = new Set();

  const SKIP = new Set(["A","CODE","PRE"]);
  const maxOpsPerNode = 200;

  function linkifyNode(node){
    if (node.nodeType === 1) {
      if (SKIP.has(node.tagName)) return;
      if (node.tagName === "A") return;
      if (node.closest && node.closest("a")) return;
      for (const ch of Array.from(node.childNodes)) linkifyNode(ch);
      return;
    }
    if (node.nodeType !== 3) return;

    let text = node.data;
    let ops = 0;
    const frag = document.createDocumentFragment();

    while (text && ops < maxOpsPerNode) {
      ops++;

      const { base, map } = buildAccentMap(text);
      const baseLower = base.toLowerCase();

      let best = null;
      for (const it of items) {
        if (usedKeys.has(it.key)) continue;
        const p = baseLower.indexOf(it.baseLower);
        if (p !== -1 && (!best || p < best.idxBase)) {
          best = { idxBase: p, item: it };
          if (p === 0) break;
        }
      }

      if (!best) {
        frag.appendChild(document.createTextNode(text));
        text = "";
        break;
      }

      const startBase = best.idxBase;
      const endBase   = startBase + best.item.baseLower.length;
      const startOrig = map[startBase];
      const endOrig   = (endBase < map.length) ? map[endBase] : text.length;

      if (startOrig > 0) {
        frag.appendChild(document.createTextNode(text.slice(0, startOrig)));
      }

      const matchedOriginal = text.slice(startOrig, endOrig);
      const a = document.createElement("a");
      a.href = buildViewerArticleUrl(best.item.title);
      a.className = "wiki-link";
      a.setAttribute("data-wiki-title", best.item.title);
      a.target = "_self";
      a.rel = "noopener noreferrer";
      a.textContent = matchedOriginal;
      frag.appendChild(a);

      usedKeys.add(best.item.key);
      text = text.slice(endOrig);
    }

    if (frag.childNodes.length){
      node.parentNode.replaceChild(frag, node);
    }
  }

  linkifyNode(bubble);
}

// ===== REFERRALS: detección + tarjetas + links =====
function normName(s){ return stripAccents(String(s||"")).toLowerCase().trim(); }

function findAgentByName(name){
  const key = normName(name);
  return state.agents.find(a => normName(a.name) === key) || null;
}

function filterOutSelf(agents){
  const current =
    state.mode === "agents" && state.selectedAgent ? normName(state.selectedAgent.name) : null;
  if (!current) return agents;
  return agents.filter(a => normName(a.name) !== current);
}

function goToAgentChat(agent){
  if (!agent) return;

  saveCurrentScroll();

  state.selectedAgent = agent;
  state.mode = "agents";
  localStorage.setItem("mode","agents");

  agentsSteps.classList.add("hidden");
  chatView.classList.remove("hidden");

  if (selectAgentBtn) selectAgentBtn.classList.remove("hidden");

  currentModeTag.textContent = t("modeAgents");

  activeAgentTag.classList.remove("hidden");
  activeAgentTag.textContent = `${t("agentLabel")}: ${agent.name}`;

  const prof = L(agent.profession) || "";
  if (activeProfessionTag){
    if (prof) {
      activeProfessionTag.classList.remove("hidden");
      activeProfessionTag.textContent = `${t("professionLabel")}: ${prof}`;
      activeProfessionTag.classList.add("tag--profession");
    } else {
      activeProfessionTag.classList.add("hidden");
    }
  }

  chatTitle.textContent = tfmt("talkWithName", { name: agent.name });

  chatAvatar.classList.remove("hidden");
  if (agent.avatar) {
    chatAvatar.innerHTML = `<img src="${agent.avatar}" alt="${agent.name}" style="width:100%;height:100%;border-radius:6px;"/>`;
  } else {
    chatAvatar.textContent = initials(agent.name);
  }

  const k = agentKey(agent);
  if (!state.chats.agents[k] || state.chats.agents[k].length === 0){
    const greet = pickGreeting(agent);
    if (greet) addMessage("bot", greet);
  }
  rememberRecentAgent(agent);
  renderConversation();
  requestAnimationFrame(focusEditor);
}

async function openAgentByName(name){
  let a = findAgentByName(name);
  if (!a){
    try { await fetchAgents(); a = findAgentByName(name); } catch {}
  }
  if (a) goToAgentChat(a);
  else toast(`⚠️ Agent "${name}" not found.`);
}

function detectReferrals(text){
  if (!text) return [];

  // 1) Captura explícita: [Nombre](agent://...)
  const fromScheme = [];
  const re = /\[([^\]]+)\]\(agent:\/\/[^\)]+\)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = (m[1] || "").trim();
    if (!n) continue;
    const ag = findAgentByName(n);
    if (ag) fromScheme.push(ag);
    else fromScheme.push({ name: n, profession: "", avatar: "" }); // stub
  }
  if (fromScheme.length) {
    const seen = new Set();
    return fromScheme.filter(a=>{
      const k = normName(a.name);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // 2) Heurística con frases gatillo + nombres presentes en el texto
  if (!state.agents || !state.agents.length) return [];
  const s = stripAccents(String(text)).toLowerCase();
  const triggers = [
    // ES
    "derivo a","derivarte a","derivaría","derivaria",
    "te recomiendo","recomiendo hablar con","hablar con","consultar con",
    "recomiendo a","puedo recomendar","puedo recomendar a","recomendar a",
    // EN
    "i recommend","i’d recommend","i would recommend","talk to","speak with","consult with","hand off to","handoff to","refer you to",
    // FR
    "je recommande","parler avec","consulter","je te conseille","je vous conseille","rediriger vers","référer à"
  ];
  if (!triggers.some(t => s.includes(t))) return [];

  const hits = [];
  for (const ag of state.agents){
    const name = stripAccents(ag.name);
    const rx = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (rx.test(text)) hits.push(ag);
  }
  const seen = new Set();
  return hits.filter(a=>{
    const k = normName(a.name);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function buildReferralCardsHTML(agents){
  if (state.mode !== "agents") return ""; // ✅ solo Agents
  if (!agents || !agents.length) return "";
  const title = escapeHTML(t("suggestedAgentsTitle"));
  const cards = agents.map(a=>{
    const avatarHTML = a.avatar
      ? `<img src="${a.avatar}" alt="${escapeHTML(a.name)}"/>`
      : initials(a.name);
    const prof = escapeHTML(L(a.profession) || "");
    const name = escapeHTML(a.name);
    return `
      <a href="#" class="agent-card ref-card" data-agent-name="${name}">
        <div class="agent-avatar">${avatarHTML}</div>
        <div class="agent-info">
          <div class="name">${name}</div>
          <div class="separator"></div>
          <div class="profession">${prof}</div>
        </div>
      </a>`;
  }).join("");

  return `
    <div class="referral-list">
      <h4 style="margin:0 0 .5rem 0;">${title}</h4>
      <div class="agents-grid">${cards}</div>
    </div>
  `;
}

function decorateBubbleWithAgentLinks(bubble, agents){
  if (state.mode !== "agents") return; // ✅ solo Agents
  if (!bubble || !agents || !agents.length) return;

  const items = agents
    .map(a => ({ name: a.name, key: normName(a.name), baseLower: normName(a.name) }))
    .sort((a,b)=> b.name.length - a.name.length);

  const SKIP = new Set(["A","CODE","PRE"]);
  const used = new Set();

  function linkifyNode(node){
    if (node.nodeType === 1) {
      if (SKIP.has(node.tagName)) return;
      if (node.tagName === "A") return;
      if (node.closest && node.closest("a")) return;
      for (const ch of Array.from(node.childNodes)) linkifyNode(ch);
      return;
    }
    if (node.nodeType !== 3) return;

    let text = node.data;
    const frag = document.createDocumentFragment();

    while (text) {
      const base = stripAccents(text);
      const lower = base.toLowerCase();

      let best = null;
      for (const it of items){
        if (used.has(it.key)) continue;
        const p = lower.indexOf(it.baseLower);
        if (p !== -1 && (!best || p < best.idx)) {
          best = { idx: p, item: it };
          if (p === 0) break;
        }
      }

      if (!best) {
        frag.appendChild(document.createTextNode(text));
        text = "";
        break;
      }

      const start = best.idx;
      const end   = start + best.item.baseLower.length;

      const before = text.slice(0, start);
      const match  = text.slice(start, end);
      const after  = text.slice(end);

      if (before) frag.appendChild(document.createTextNode(before));

      const a = document.createElement("a");
      a.href = "#";
      a.className = "agent-link";
      a.setAttribute("data-agent-name", best.item.name);
      a.textContent = match;
      frag.appendChild(a);

      used.add(best.item.key);
      text = after;
    }

    if (frag.childNodes.length){
      node.parentNode.replaceChild(frag, node);
    }
  }

  linkifyNode(bubble);
}

// ===== Cache + enriquecido Wikipedia en mensajes SIN referrals =====
function setWikiCache(threadId, msgIndex, list){
  if (!threadId || msgIndex == null) return;
  if (!state.wikiLinks[threadId]) state.wikiLinks[threadId] = {};
  state.wikiLinks[threadId][msgIndex] = list;
}

async function enrichWithWikiLinks(bubble, plainText, { threadId, msgIndex }){
  const allow = await buildAllowListByNgrams(String(plainText || ""));
  if (!allow.length) return;

  setWikiCache(threadId, msgIndex, allow);
  try { decorateBubbleForWiki(bubble, allow); } catch {}

  const count = allow.length;
  const lang = state.lang || "en";
  const btnLabel = escapeHTML(t("searchInWikipedia"));

  const STR = {
    es: {
      found: "He encontrado al menos",
      links: "links a la Wikipedia",
      hint: "⚠️ Aviso: no obstante, hay muchos más artículos entre los millones de la Wikipedia. Para buscar el que desees, solo tienes que seleccionar texto en mi respuesta y darle al botón"
    },
    en: {
      found: "I've found at least",
      links: "links to Wikipedia",
      hint: "⚠️ Note: there are many more articles among Wikipedia’s millions. To search the one you want, just select text in my reply and hit the button"
    },
    fr: {
      found: "J’ai trouvé au moins",
      links: "liens vers Wikipédia",
      hint: "⚠️ Remarque : il existe bien plus d’articles parmi les millions de Wikipédia. Pour chercher celui que vous voulez, sélectionnez du texte dans ma réponse et appuyez sur le bouton"
    }
  };

  const s = STR[lang] || STR.en;

  const html =
  `<div class="wiki-hint">` +
    `${escapeHTML(s.found)}<br/>` +
    `• ${count} ${escapeHTML(s.links)}<br/>` +
    `<span style="opacity:.85;">${escapeHTML(s.hint)} 🔎 ${btnLabel}.</span>` +
  `</div>`;

  addMessage("bot", html, { asHTML: true, __wikiInfo: true });
}

// ========== 📚 LIBRARY (docs/) ==========
function libJoin(...parts){
  const raw = parts.join("/").replace(/\\/g,"/").replace(/\/{2,}/g,"/");
  // normaliza "./" y "../" de forma simple
  const segs = [];
  for (const p of raw.split("/")){
    if (!p || p === ".") continue;
    if (p === "..") segs.pop();
    else segs.push(p);
  }
  return segs.join("/");
}

function libDirname(path){
  const p = (path || "").replace(/\/+$/,"");
  const i = p.lastIndexOf("/");
  if (i <= 0) return "";
  return p.slice(0, i);
}
function libBasename(path){
  const p = (path || "").replace(/\/+$/,"");
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i+1);
}

// Decide carpeta de inicio según idioma (si no existe, backend la resuelve)
function libraryStartPath(){
  const lang = (state.lang || "en").slice(0,2);
  // antes: return `${state.library.root}/${lang}`;
  return libJoin(state.library?.root || "", lang); // con root vacío → "en"
}

async function libraryEnsurePath(){
  if (!state.library.path) {
    state.library.path = libraryStartPath();
  }
}

// Pide al backend el listado de una ruta
function normalizeLibPath(p){
  p = String(p || "").replace(/\\/g,"/").replace(/^\/+/,"");
  if (p.startsWith("docs/")) p = p.slice(5); // por si aún queda ese prefijo
  return p;
}

async function libraryList(path){
  const q = encodeURIComponent(normalizeLibPath(path));
  const res = await fetch(`${BASE_URL}/api/library/list?path=${q}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  // Forma antigua: { status:"ok", items:[...] }
  if (data && data.status === "ok" && Array.isArray(data.items)) {
    return data.items;
  }

  // Forma actual: { path, parent, dirs:[{name,path}], files:[{name,path,size?,mtime?}] }
  if (data && (Array.isArray(data.dirs) || Array.isArray(data.files))) {
    const items = [];

    if (Array.isArray(data.dirs)) {
      for (const d of data.dirs) {
        const name = d.name ?? libBasename(d.path ?? "");
        const rel  = d.path ?? libJoin(path, name);
        items.push({ type: "dir", name, rel, ext: "" });
      }
    }
    if (Array.isArray(data.files)) {
      for (const f of data.files) {
        const name = f.name ?? libBasename(f.path ?? "");
        const rel  = f.path ?? libJoin(path, name);
        const ext  = (name.split(".").pop() || "").toLowerCase();
        items.push({
          type: "file",
          name, rel, ext,
          size: f.size ?? null,
          mtime: f.mtime ?? null
        });
      }
    }

    // directorios primero, luego archivos; ambos ordenados por nombre
    items.sort((a,b)=> (a.type===b.type ? a.name.localeCompare(b.name) : a.type==="dir" ? -1 : 1));
    return items;
  }

  throw new Error("Unexpected library/list payload.");
}

// crea controles si no existen
function ensureLibToolbarExtras(){
  const bar = document.querySelector("#libraryView .library-toolbar, #libraryView .lib-toolbar");
  if (!bar || bar.querySelector(".lib-tools")) return;

  const tools = document.createElement("div");
  tools.className = "lib-tools";
  tools.innerHTML = `
    <input id="libSearch" class="lib-search" type="search" placeholder="Filter…" />
    <select id="libSort" class="lib-sort">
      <option value="name">Name</option>
      <option value="size">Size</option>
      <option value="type">Type</option>
    </select>
  `;
  bar.appendChild(tools);

  const inp = tools.querySelector("#libSearch");
  const sel = tools.querySelector("#libSort");
  inp.value = state.library.filter;
  sel.value = state.library.sort;

  let t = 0;
  inp.addEventListener("input", ()=>{
    clearTimeout(t);
    t = setTimeout(()=>{ state.library.filter = inp.value; libraryListRender(); }, 150);
  });
  sel.addEventListener("change", ()=>{
    state.library.sort = sel.value;
    libraryListRender();
  });
}

// ordenadores
const LIB_SORT = {
  name: (a,b)=> (a.type===b.type ? a.name.localeCompare(b.name) : a.type==="dir" ? -1 : 1),
  size: (a,b)=> (a.type===b.type ? (b.size||0)-(a.size||0) : a.type==="dir" ? -1 : 1),
  type: (a,b)=> (a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
};

// --- Keyboard selection state + helpers ---
let libSelIndex = -1;

function focusLibRow(i){
  const rows = Array.from(document.querySelectorAll("#libList .lib-row"));
  rows.forEach(r => r.classList.remove("is-focused"));
  const row = rows[i];
  if (row) {
    row.classList.add("is-focused");
    row.scrollIntoView({ block: "nearest" });
  }
}

function initLibSelection(){
  const rows = Array.from(document.querySelectorAll("#libList .lib-row"));
  libSelIndex = rows.length ? 0 : -1;
  if (libSelIndex >= 0) focusLibRow(libSelIndex);
}

function onLibKeydown(e){
  // Solo si la vista Library está visible y no estás escribiendo en un input
  const libraryVisible = !document.getElementById("libraryView")?.classList.contains("hidden");
  if (!libraryVisible) return;
  const tag = (e.target && e.target.tagName) || "";
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || e.target.isContentEditable) return;

  const rows = Array.from(document.querySelectorAll("#libList .lib-row"));
  if (!rows.length) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    libSelIndex = Math.min(rows.length-1, libSelIndex+1);
    focusLibRow(libSelIndex);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    libSelIndex = Math.max(0, libSelIndex-1);
    focusLibRow(libSelIndex);
  } else if (e.key === "Enter") {
    e.preventDefault();
    rows[libSelIndex>=0?libSelIndex:0].click();
  }  else if (e.key === "Backspace") {
    e.preventDefault();
    libraryGoUp();
  }
}


// Renderiza lista + ruta
async function libraryListRender(){
  const path = state.library.path || libraryStartPath();
  let items = [];
  try {
    items = await libraryList(path);
  } catch (e) {
    items = [];
    console.error(e);
    if (libList) libList.innerHTML = `<div class="muted" style="padding:1rem;">⚠️ ${escapeHTML(String(e.message||"Error"))}</div>`;
  }

  // 🔎 filtro + orden
  if (state.library.filter) {
    const q = state.library.filter.toLowerCase();
    items = items.filter(e => (e.name || "").toLowerCase().includes(q));
  }
  items.sort(LIB_SORT[state.library.sort] || LIB_SORT.name);

  state.library.items = items;

  if (libPathLabel) {
    libPathLabel.textContent = "/" + path;
  }

  if (!libList) return;

  if (!items.length) {
    libList.innerHTML = "";
    if (libEmpty) libEmpty.classList.remove("hidden");
    return;
  }
  if (libEmpty) libEmpty.classList.add("hidden");

libList.innerHTML = items.map(entry => {
  const icon = entry.type === "dir" ? "📁" : fileIcon(entry.ext);
  const name = escapeHTML(entry.name);
  const rel  = escapeHTML(entry.rel);
  const meta = entry.type === "file"
    ? `<span class="lib-meta">${formatSize(entry.size)}${entry.mtime ? " · " + escapeHTML(entry.mtime) : ""}</span>`
    : `<span class="lib-meta">&nbsp;</span>`;

  const acts = entry.type === "file"
    ? `<div class="lib-acts">
         <a class="lib-act-view" href="${buildFileUrl(entry.rel, true)}" target="_blank" rel="noopener" aria-label="${t('libView')}">${t('libView')}</a>
       </div>`
    : `<div class="lib-acts"></div>`;

  return `
    <div class="lib-row" role="button" tabindex="0" data-type="${entry.type}" data-rel="${rel}" title="${name}">
      <span class="lib-icon">${icon}</span>
      <div class="lib-main">
        <span class="lib-name">${name}</span>
        ${meta}
      </div>
      ${acts}
    </div>
  `;
}
).join("");

}

function renderBreadcrumb(){
  const el = document.getElementById("libPathLabel");
  if (!el) return;
  const path = state.library.path || "";
  const parts = path.split("/").filter(Boolean);

  el.innerHTML = ""; // limpiamos
  const home = document.createElement("a");
  home.className = "lib-bc";
  home.textContent = "/";
  home.href = "#";
  home.onclick = (e)=>{ e.preventDefault(); state.library.path = libraryStartPath(); libraryListRender(); };
  el.appendChild(home);

  let acc = "";
  parts.forEach((p, i)=>{
    acc = i === 0 ? p : `${acc}/${p}`;
    el.appendChild(document.createTextNode(" "));
    const a = document.createElement("a");
    a.className = "lib-bc";
    a.textContent = p;
    a.href = "#";
    a.onclick = (e)=>{ e.preventDefault(); state.library.path = acc; libraryListRender(); };
    el.appendChild(a);
    if (i < parts.length - 1) el.appendChild(document.createTextNode(" /"));
  });
}


// Navegar a carpeta
async function libraryNavigateTo(relPath){
  state.library.path = relPath;
  await libraryListRender();
}
// Subir a padre
async function libraryGoUp(){
  const parent = libDirname(state.library.path || "");
  if (!parent) return;
  state.library.path = parent;
  await libraryListRender();
}

// Abrir archivo (inline en nueva pestaña)
function libraryOpen(relPath){
  const url = buildFileUrl(relPath, true);
  window.open(url, "_blank", "noopener");
}
// Descargar archivo
function libraryDownload(relPath){
  const url = buildFileUrl(relPath, false);
  // crear ancla temporal para forzar download (por si navegador ignora header)
  const a = document.createElement("a");
  a.href = url;
  a.download = libBasename(relPath);
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function buildFileUrl(relPath, inline){
  const disp = inline ? "inline" : "attachment";
  return `${BASE_URL}/api/library/file?path=${encodeURIComponent(relPath)}&disposition=${disp}`;
}

function fileIcon(ext){
  const e = String(ext||"").toLowerCase();
  if (e === "pdf") return "📕";
  if (["txt","md","rtf"].includes(e)) return "📄";
  if (["epub"].includes(e)) return "📘";
  if (["doc","docx","odt"].includes(e)) return "📗";
  if (["csv","xls","xlsx","ods"].includes(e)) return "📊";
  if (["ppt","pptx","odp"].includes(e)) return "📈";
  if (["jpg","jpeg","png","gif","webp","svg"].includes(e)) return "🖼️";
  if (["zip","7z","rar"].includes(e)) return "🗜️";
  return "📦";
}
function formatSize(n){
  if (typeof n !== "number" || !isFinite(n) || n < 0) return "";
  const KB = 1024, MB = KB*1024, GB = MB*1024;
  if (n >= GB) return (n/GB).toFixed(2) + " GB";
  if (n >= MB) return (n/MB).toFixed(1) + " MB";
  if (n >= KB) return (n/KB).toFixed(0) + " KB";
  return n + " B";
}
