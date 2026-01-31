window.DEBUG_MARKDOWN = true;   // true para depurar, false para normal

// ===== CONFIG =====
const BASE_URL = "http://127.0.0.1:8000";
const MODELS = [
  { file: "phi-4-mini-instruct-q4_k_m.gguf", label: "Phi-4 Mini" }
];

const MAP_ATTR = '© <a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a> · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
// Kiwix local (si cambias puerto/dirección en backend, refleja aquí)
const KIWIX_ORIGIN = "/proxy/wiki";

// —— WIKI: modo rápido sin resolver enlaces automáticamente
const WIKI_FAST_FAKE = true; // ← si “true”, no hace probes ni decoraciones automáticas

const REFERRAL_MIN_KEYWORD_HINTS = 3;      // mínimo 3 coincidencias de keyword
const REFERRAL_MAX_CARDS = 2;              // máximo 2 tarjetas
const REFERRAL_DEDUPE_CONSECUTIVE = true;  // evita repetir las mismas tarjetas en turnos seguidos

const SUPPORTED_LANGS = {
  en: { label: "English",   flag: "🇬🇧" },
  es: { label: "Español",   flag: "🇪🇸" },
  fr: { label: "Français",  flag: "🇫🇷" },
  pt: { label: "Português", flag:"🇵🇹" }
};

let state = {
  mode: "llm",
  modelFile: MODELS[0].file,
  agents: [],
  categories: [],
  lastReferralKeys: [],
  selectedAgent: null,
  selectedCategory: null,
  typing: false,
  lang: "en",
  lang_label: "English",
  lang_flag: "🇬🇧",
  _encarthaIntroShown: false,

  // 🗺️ Estado de mapas
  maps: {
    // Nueva estructura: carpetas + items
    // {
    //   folders: [{id, name, emoji}],
    //   items: [{id, name, lat, lon, zoom, folderId|null}]
    // }
    favorites: {
      folders: [],
      items: []
    },
    lastSearchCoords: null,   // { lat, lon, zoom }
  },

  // 🌌 Estado de cielo (d3-celestial)
  sky: {
    // Coordenadas por defecto: Madrid (puedes cambiarlas si quieres)
    lat: 40.4168,
    lon: -3.7038,

    // Fecha y hora locales como strings "YYYY-MM-DD" y "HH:MM"
    date: null,
    time: null,

    // Magnitud límite de estrellas visibles
    magLimit: 6,

    // Capas opcionales
    showConstellations: true,
    showConstNames: false,
    showGrid: true,
    showHorizon: true,
    showPlanets: true,

    // Flag interno
    initialized: false
  },

  // 🧵 Hilos locales por vista
  chats: {
    model: [],        // [{role:"user"|"bot", text:String, __html?:true}]
    agents: {}        // {"Name|Personality": [ ... ]}
  },

  // 📚 Cache de existencia de artículos: { "zimId|Title_Enc": boolean }
  wikiExist: {},

  // 🏷️ Cache de título canónico
  wikiCanon: {},

  // 🗂️ Control de Wikipedia
  wiki: { started: false, url: "", zimId: null, pendingUrl: null },

  // 📚 Librería (docs/)
  library: { path: "", items: [], root: "", base: "docs" },
  
  // 🔄 Sync entre Offlineds (media)
  sync: {
    peer: null,     // id del peer (ruta _internal)
    peers: [],      // lista devuelta por /api/sync/peers
    sub: "images",  // video|music|images|files
    path: ""        // ruta relativa dentro de media/<sub> del peer
  },  
  
  supporters: { order: [], labels: {}, items: [] },

  // 🧷 Scroll por hilo
  scroll: {}  ,        // { "model": number, "agent:Name|Persona": number }
  recentAgents: []
};

/* === SUPPORTERS full-bleed + scroll === */
let _supportersResizeHandler = null;

function ensureSupportersLayout(){
  const el = document.getElementById("supportersView");
  if (!el) return;

  const header = document.querySelector("header");
  const footer = document.querySelector("footer");
  const hH = header ? header.offsetHeight : 0;
  const fH = footer ? footer.offsetHeight : 0;

  el.style.height = `calc(100vh - ${hH + fH}px)`;
  el.style.overflowY = "auto";
  el.style.webkitOverflowScrolling = "touch";
  el.style.boxSizing = "border-box";
}

// ===== SKY (d3-celestial) =====
const CELESTIAL_DATAPATH = "./vendor/celestial/data/";

// Radio máximo para considerar que has hecho clic "encima" del objeto (en píxeles)
const SKY_CLICK_RADIUS_PX = 20;          // ajusta a gusto (15–25 suele ir bien)
const SKY_CLICK_RADIUS2 = SKY_CLICK_RADIUS_PX * SKY_CLICK_RADIUS_PX;


// Asegura que existe el contenedor del mapa del cielo
function ensureSkyCanvas() {
  const container = document.getElementById("celestial-map");
  if (!container) {
    console.warn("[Sky] Falta el contenedor #celestial-map en el DOM");
    return null;
  }
  return container;
}

let _skyInited = false;
let _skyClicksBound = false;
let _skySettingsBound = false;

// Datos precargados de estrellas y DSOs para selección por clic
let _skyObjectDataLoaded = false;
let _skyObjects = [];  // { kind: "star" | "dso" | "messier" | "planet", feature }
// Termino de búsqueda en Wikipedia (antes era el nombre; ahora será desig o name)
let _skyCurrentObjectName  = null;
// Texto bonito para la tarjeta (alt, name, desig)
let _skyCurrentObjectLabel = null;

let _skyCardBound = false;

// Idioma de nombres según idioma de la app
function getCelestialLangFromApp(stateLang) {
  switch (stateLang) {
    case "es": return "es"; // español
    case "fr": return "fr"; // francés
    case "en": return "en"; // inglés
    case "pt": return "en"; // portugués usa nombres en inglés
    default:   return "";
  }
}

// Configuración base del mapa del cielo
function buildCelestialConfig() {
  const appLang = getCelestialLangFromApp(state.lang || "en");

  return {
    container: "celestial-map",
    datapath: CELESTIAL_DATAPATH,

    width: 0,
    projection: "armadillo",
    transform: "equatorial",
    center: null,
    orientationfixed: true,
    geopos: null,
    follow: "zenith",
    zoomlevel: null,
    zoomextend: 10,
    adaptable: true,
    interactive: true,

    form: true,
    location: false,
    formFields: {
      location: true,
      general: true,
      stars: true,
      dsos: true,
      constellations: true,
      lines: true,
      other: true,
      download: false
    },
    advanced: true,
    daterange: [],
    controls: true,

    lang: appLang,
    culture: "",

    background: {
      fill: "#050814",
      stroke: "none",
      opacity: 1
    },

    // Estrellas: con nombres propios hasta mag 2
    stars: {
      show: true,
      limit: 6,       // "Down to mag" = 2
      colors: true,
      names: true,
      proper: true,   // stars-propername
      desig: false,
      namelimit: 3,
      propernamelimit: 3
    },

    // Planetas, Sol y Luna como símbolo + nombre
    planets: {
      show: true,
      which: ["sol","mer","ven","ter","lun","mar","jup","sat","ura","nep"],
      names: true,
      type: "symbol"
    },

    // Horizonte visible por defecto
    horizon: {
      show: true,
      stroke: "#888888",
      width: 1,
      fill: "#000000",
      opacity: 0.5
    }
  };
}

// Carga stars.6.json, dsos.bright.json y opcionalmente messier.json + planets.json
async function loadSkyObjectData() {
  if (_skyObjectDataLoaded) return;

  try {
    const base = CELESTIAL_DATAPATH;

    // 1) Lo obligatorio: estrellas + DSOs “bright”
    const [starsRes, dsosRes] = await Promise.all([
      fetch(base + "stars.6.json"),
      fetch(base + "dsos.bright.json")
    ]);

    if (!starsRes.ok || !dsosRes.ok) {
      console.warn("[Sky] No se han podido cargar stars.6.json o dsos.bright.json");
      return;
    }

    const starsJson = await starsRes.json();
    const dsosJson  = await dsosRes.json();

    // 2) Opcional: catálogo Messier
    let messierJson = null;
    try {
      const mRes = await fetch(base + "messier.json");
      if (mRes.ok) {
        messierJson = await mRes.json();
      } else {
        console.warn("[Sky] messier.json no encontrado o error HTTP:", mRes.status);
      }
    } catch (e) {
      console.warn("[Sky] Error cargando messier.json (opcional)", e);
    }

    // 3) Opcional: planetas (si existe planets.json)
    let planetsJson = null;
    try {
      const pRes = await fetch(base + "planets.json");
      if (pRes.ok) {
        planetsJson = await pRes.json();
      } else {
        console.warn("[Sky] planets.json no encontrado o error HTTP:", pRes.status);
      }
    } catch (e) {
      console.warn("[Sky] Error cargando planets.json (opcional)", e);
    }

    // 4) Unificamos todos en _skyObjects
    _skyObjects = [];

    if (starsJson && Array.isArray(starsJson.features)) {
      _skyObjects.push(...starsJson.features.map(f => ({ kind: "star", feature: f })));
    }

    if (dsosJson && Array.isArray(dsosJson.features)) {
      _skyObjects.push(...dsosJson.features.map(f => ({ kind: "dso", feature: f })));
    }

    if (messierJson && Array.isArray(messierJson.features)) {
      _skyObjects.push(...messierJson.features.map(f => ({ kind: "messier", feature: f })));
    }

    if (planetsJson && Array.isArray(planetsJson.features)) {
      _skyObjects.push(...planetsJson.features.map(f => ({ kind: "planet", feature: f })));
    }

    _skyObjectDataLoaded = true;
    console.log("[Sky] Objetos de cielo cargados:", _skyObjects.length);
  } catch (e) {
    console.warn("[Sky] Error cargando datos de cielo", e);
    _skyObjectDataLoaded = false;
    _skyObjects = [];
  }
}


// Devuelve un nombre “visible” para el objeto del cielo.
// Primero intenta nombres bonitos, luego designaciones de catálogo, luego IDs.
function getSkyObjectDisplayName(obj) {
  if (!obj || !obj.feature || !obj.feature.properties) return "";
  const p = obj.feature.properties || {};

  const candidates = [
    p.proper, // estrellas: Sirius, Vega...
    p.name,   // DSOs / planetas / Messier: Andromeda Galaxy, Mars...
    p.alt,    // nombre alternativo: Triangulum, Polaris, etc.
    p.desig,  // designación: NGC 598, M31...
    p.iau,
    p.bayer,
    p.id,
    p.gl,
    p.hd,
    p.hip
  ];

  const first = candidates.find(v => v && String(v).trim());
  return first ? String(first).trim() : "";
}

// DOM de la ficha de objeto (nombre + botón Kiwix)
function setupSkyInfoCardDom() {
  if (_skyCardBound) return;

  const card     = document.getElementById("skyObjectCard");
  const nameEl   = document.getElementById("skyObjectName");
  const wikiBtn  = document.getElementById("skyObjectWikiBtn");
  const closeBtn = document.getElementById("skyObjectCloseBtn");

  if (!card || !nameEl || !wikiBtn) {
    console.warn("[Sky] Falta el HTML de la ficha de objeto (#skyObjectCard / #skyObjectName / #skyObjectWikiBtn)");
    return;
  }

  // Botón cerrar
  if (closeBtn) {
    closeBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      hideSkyObjectCard();
    });
  }

  // *** IMPORTANTE ***
  // Ya NO añadimos aquí el listener del botón de Wikipedia,
  // porque ahora se gestiona SOLO en bindSkyCardButtons().

  _skyCardBound = true;
}

// Muestra la ficha con un nombre
function showSkyObjectCard(label) {
  const card   = document.getElementById("skyObjectCard");
  const nameEl = document.getElementById("skyObjectName");
  if (!card || !nameEl) {
    console.warn("[Sky] Falta HTML de la ficha de objeto (#skyObjectCard / #skyObjectName)");
    return;
  }

  const text = (label && String(label).trim()) || "—";
  // Si quieres el puntito final, lo añadimos aquí
  nameEl.textContent = text ? `${text}.` : "—";

  card.classList.remove("sky-object-card--hidden");
}


function hideSkyObjectCard() {
  const card = document.getElementById("skyObjectCard");
  if (card) card.classList.add("sky-object-card--hidden");
}

// Enlazar botones de la ficha una sola vez
(function bindSkyCardButtons() {
  const closeBtn = document.getElementById("skyObjectCloseBtn");
  const wikiBtn  = document.getElementById("skyObjectWikiBtn");

  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      hideSkyObjectCard();
    });
  }

  if (wikiBtn) {
    wikiBtn.addEventListener("click", () => {
      const name = window._skyCurrentObjectName;
      if (!name) return;

      // Aquí usas tu lógica para abrir Wikipedia offline / iframe
      // Ejemplo simple: cambiar a modo wiki y preparar búsqueda
      setMode("wiki");
      openWikiForSkyObject(name);
    });
  }
})();

// Lanza búsqueda en tu Wikipedia/Kiwix offline
// --- Abrir Wikipedia/Kiwix desde la ficha del cielo ------------------------
async function openWikiForSkyObject(rawName){
  const q = (rawName || "").trim();
  if (!q) {
    console.warn("[Sky] openWikiForSkyObject llamado sin término");
    return;
  }

  console.log("[Sky] Buscar en Wikipedia/Kiwix:", q);

  try {
    let ok = false;

    // 1) Igual que el árbol: probar artículo exacto
    if (typeof tryOpenExactArticle === "function") {
      ok = await tryOpenExactArticle(q);
    }

    // 2) Si no hay match exacto, usar búsqueda de Kiwix
    if (!ok && typeof kiwixSearchAndOpen === "function") {
      ok = await kiwixSearchAndOpen(q, 10);  // 10 resultados como en el árbol
    }

    // 3) Último recurso: forzar la URL de búsqueda en el visor
    if (!ok && typeof buildViewerSearchUrl === "function") {
      const url = buildViewerSearchUrl(q);
      // Muy importante: actualizar AMBAS propiedades
      state.wiki.url = url;
      state.wiki.pendingUrl = url;
      await setMode("wiki");
    }
  } catch (e) {
    console.warn("[Sky] Error buscando en Wikipedia/Kiwix:", e);
  }
}


// Engancha listeners de clic al canvas de Celestial
function setupSkyClickCallbacks() {
  if (_skyClicksBound) return;

  const container = ensureSkyCanvas();
  if (!container) return;

  const tryBind = () => {
    const canvas = container.querySelector("canvas");
    const proj   = Celestial && Celestial.mapProjection;

    if (!canvas || !proj) {
      // Celestial todavía inicializándose
      setTimeout(tryBind, 300);
      return;
    }

	canvas.addEventListener("click", async (ev) => {
	  console.log("[Sky] click en canvas");

	  // 1) Asegurarnos de que tenemos datos
	  try {
		await loadSkyObjectData();
	  } catch (e) {
		console.warn("[Sky] Error en loadSkyObjectData()", e);
		return;
	  }

	  if (!_skyObjectDataLoaded || !_skyObjects.length) {
		console.warn("[Sky] No hay datos de objetos para seleccionar en el click");
		return;
	  }

	  console.log("[Sky] Objetos disponibles en click:", _skyObjects.length);

	  // 2) Posición del clic en píxeles relativos al canvas
	  const rect = canvas.getBoundingClientRect();
	  const x = ev.clientX - rect.left;
	  const y = ev.clientY - rect.top;

	  // 3) Buscar el objeto nombrado más cercano,
	  //    pero solo si está dentro del radio en píxeles.
	  let best        = null;
	  let bestD2      = Infinity;
	  let countEval   = 0; // objetos con nombre evaluados
	  let countTotal  = 0; // objetos totales visibles

	  for (const obj of _skyObjects) {
		const feat = obj.feature;
		if (!feat || !feat.geometry || !feat.geometry.coordinates) continue;

		const coords = feat.geometry.coordinates;

		// Solo objetos visibles en el mapa actual
		if (!Celestial.clip(coords)) continue;

		countTotal++;

		// Solo nos interesan objetos con “display name” (proper/name)
		const displayName = getSkyObjectDisplayName(obj);
		if (!displayName) continue;   // sin nombre → no se puede buscar en Wikipedia

		const pt = Celestial.mapProjection(coords);
		if (!pt) continue;

		const dx = pt[0] - x;
		const dy = pt[1] - y;
		const d2 = dx * dx + dy * dy;

		if (d2 < bestD2) {
		  bestD2 = d2;
		  best   = obj;
		}
		countEval++;
	  }

	  console.log("[Sky] Objetos visibles:", countTotal, "con nombre evaluados:", countEval, "mejor dist2:", bestD2, "best:", best);

	  // 4) Si no hay candidato con nombre o está demasiado lejos → nada
	  if (!best || bestD2 > SKY_CLICK_RADIUS2) {
		console.log("[Sky] Ningún objeto con nombre dentro del radio, oculto ficha");
		hideSkyObjectCard();
		return;
	  }

	  const name = getSkyObjectDisplayName(best);
	  console.log("[Sky] Nombre detectado:", name);

	  if (!name) {
		console.log("[Sky] Objeto sin nombre visible (post-check), oculto ficha");
		hideSkyObjectCard();
		return;
	  }

	  // --- Construir label "alt, name, desig" y término de búsqueda ---

	  const props = (best.feature && best.feature.properties) ? best.feature.properties : {};
	  const alt   = String(props.alt   || "").trim();   // Triangulum
	  const desig = String(props.desig || "").trim();   // NGC 598

	  // Partes del texto de la tarjeta
	  const labelParts = [];
	  if (alt)   labelParts.push(alt);
	  if (name)  labelParts.push(name);
	  if (desig) labelParts.push(desig);

	  const label = labelParts.join(", ") || name;

	  // Para Wikipedia: preferimos la designación (NGC 598), y si no hay, usamos el nombre
	  const searchTerm = desig || name;

	  // Guardamos en globals lo que usará la tarjeta y el botón de Wikipedia
	  window._skyCurrentObjectName  = searchTerm; // se mantiene la API actual de openWikiForSkyObject
	  window._skyCurrentObjectLabel = label;

	  console.log("[Sky] Clic sobre objeto:", {
		name,
		alt,
		desig,
		label,
		searchTerm,
		dist2: bestD2,
		radio2: SKY_CLICK_RADIUS2
	  });

	  showSkyObjectCard(label);
	});


    _skyClicksBound = true;
  };

  tryBind();
}

// Abre/cierra la barra lateral de ajustes del cielo (botón engranaje)
function setupSkySettingsSidebar() {
  if (_skySettingsBound) return;

  const btn     = document.getElementById("skySettingsBtn");
  const skyView = document.getElementById("skyView");
  if (!btn || !skyView) return;

  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    const isOpen = skyView.classList.toggle("sky-settings-open");
    btn.setAttribute("aria-expanded", isOpen ? "true" : "false");
  });

  _skySettingsBound = true;
}

// Inicializa el mapa del cielo una sola vez
function initSkyOnce() {
  if (_skyInited) return;

  const container = ensureSkyCanvas();
  if (!container) return;
  if (typeof Celestial === "undefined") {
    console.warn("[Sky] Celestial no está cargado");
    return;
  }

  try {
    const config = buildCelestialConfig();
    Celestial.display(config);

    setupSkyInfoCardDom();
    setupSkyClickCallbacks();
    setupSkySettingsSidebar();
    // precargamos datos de objetos en segundo plano
    loadSkyObjectData().catch(() => {});

    _skyInited = true;
  } catch (e) {
    console.error("[Sky] Error iniciando d3-celestial", e);
  }
}

// Redibuja el cielo (por ejemplo al cambiar tema o tamaño)
function refreshSky() {
  if (!_skyInited) return;
  if (typeof Celestial === "undefined") return;
  try {
    Celestial.redraw();
  } catch (e) {
    console.warn("[Sky] Error en Celestial.redraw()", e);
  }
}

// ===== MAPS (offline) =====
let _map = null;
let _pmproto = null;
let _mapReady = false;
// Duración del vuelo del mapa (ms). 4000–5000 = x2–x3 más lento que el valor por defecto.
const MAP_FLY_DURATION_MS = 6000;
// Emojis disponibles para carpetas de favoritos (30)
const MAPS_FOLDER_EMOJIS = [
  "⭐", "🏠", "🏕️", "⛺", "🏖️", "🏙️",
  "🏥", "🏫", "🏛️", "🏟️", "🏬", "🏭",
  "🏗️", "🏞️", "🌋", "🏜️", "🏝️", "🏔️",
  "🤿", "🎣", "🚵", "🚴", "🧗", "🥾",
  "🍽️", "☕", "🍺", "🍷", "🛒", "🛟"
];

// 👇 nuevas: recuerda el pmtiles y la primera capa detectada
let _pmtilesUrl = null;
let _vecLayerId = null;

// 🧷 Marcadores del mapa (coordenadas + favoritos)
let _mapsSearchMarker = null;   // marcador de la última búsqueda / “Ir”
let _mapsFavMarkers   = [];     // marcadores de favoritos ⭐

// ==== Marcadores de mapas (HTML markers de MapLibre) ====

function clearMapsFavMarkers() {
  if (!_mapsFavMarkers) return;
  for (const m of _mapsFavMarkers) {
    try { m.remove(); } catch (_) {}
  }
  _mapsFavMarkers = [];
}

// Dibuja todos los favoritos como estrellas ⭐ en el mapa
function renderMapsFavoriteMarkers() {
  if (!_map) return;

  clearMapsFavMarkers();

  const { folders, items } = getMapsFavoritesData();

  items.forEach((fav) => {
    if (fav.lat == null || fav.lon == null) return;

    let emoji = "⭐";
    if (fav.folderId) {
      const folder = folders.find(f => f.id === fav.folderId);
      if (folder && folder.emoji) emoji = folder.emoji;
    }

    const el = document.createElement("div");
    el.className = "map-pin map-pin-fav";
    el.textContent = emoji;
    el.title = fav.name || `${Number(fav.lat).toFixed(4)}, ${Number(fav.lon).toFixed(4)}`;

    const marker = new maplibregl.Marker({
      element: el,
      anchor: "bottom"
    })
      .setLngLat([Number(fav.lon), Number(fav.lat)])
      .addTo(_map);

    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      gotoMapFavoriteById(fav.id);
    });

    _mapsFavMarkers.push(marker);
  });
}


// Crea / mueve la chincheta 📍 de la última búsqueda de coordenadas
function showMapsSearchMarker(lat, lon) {
  if (!_map) return;

  // Eliminar chincheta anterior si existe
  if (_mapsSearchMarker) {
    try { _mapsSearchMarker.remove(); } catch (_) {}
    _mapsSearchMarker = null;
  }

  const el = document.createElement("div");
  el.className = "map-pin map-pin-current";
  el.textContent = "📍";
  el.title = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;

  // 💾 Actualizar también lastSearchCoords desde aquí (por si viene de búsqueda)
  const zoom = _map.getZoom() || 10;
  state.maps = state.maps || {};
  state.maps.lastSearchCoords = { lat, lon, zoom };

  // 🖱️ Click en la chincheta → abrir diálogo "Guardar favorito"
  el.addEventListener("click", (ev) => {
    ev.stopPropagation();

    // Fallback por si por algún motivo no hubiera coords en el estado
    if (!state.maps || !state.maps.lastSearchCoords) {
      const pos = _mapsSearchMarker && _mapsSearchMarker.getLngLat
        ? _mapsSearchMarker.getLngLat()
        : null;
      if (pos) {
        const z = _map ? _map.getZoom() || 10 : 10;
        state.maps = state.maps || {};
        state.maps.lastSearchCoords = { lat: pos.lat, lon: pos.lng, zoom: z };
      }
    }

    // Reutilizamos la misma lógica que el botón "Guardar favorito"
    if (typeof handleMapsSaveFavorite === "function") {
      handleMapsSaveFavorite();
    }
  });

  _mapsSearchMarker = new maplibregl.Marker({
    element: el,
    anchor: "bottom"
  })
    .setLngLat([lon, lat])
    .addTo(_map);
}

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

function ensureMapsSearchPanel() {
  const mapsView = document.getElementById("mapsView");
  if (!mapsView) return;

  let panel = document.getElementById("mapsSearchPanel");
  if (panel) {
    // Solo refrescamos los textos por si ha cambiado el idioma
    refreshMapsSearchTexts();
    return;
  }

  panel = document.createElement("div");
  panel.id = "mapsSearchPanel";
  panel.className = "maps-search-panel";

  panel.innerHTML = `
    <div class="maps-search-row">
      <input
        id="mapsSearchInput"
        type="text"
        autocomplete="off"
        placeholder="${t("mapsSearchPlaceholder")}"
      />
      <button id="mapsSearchBtn" type="button">${t("mapsSearchBtn")}</button>
      <button id="mapsFavSaveBtn" type="button" disabled>
        ${t("mapsFavSaveBtn")}
      </button>
    </div>

    <div class="maps-fav-select-row">
      <button id="mapsFavToggleBtn" type="button" class="maps-fav-toggle">
        ⭐ ${t("mapsFavTitle")}
      </button>

      <button id="mapsNewFolderBtn" type="button" class="maps-fav-new-folder-btn-inline">
        📁 ${t("mapsFavNewFolderBtn")}
      </button>

      <div id="mapsFavDropdown" class="maps-fav-dropdown">
        <ul id="mapsFavList"></ul>
      </div>
    </div>
  `;

  mapsView.appendChild(panel);

  const mapsInput     = panel.querySelector("#mapsSearchInput");
  const mapsBtnGo     = panel.querySelector("#mapsSearchBtn");
  const mapsBtnSave   = panel.querySelector("#mapsFavSaveBtn");
  const mapsFavToggle = panel.querySelector("#mapsFavToggleBtn");
  const mapsFavDropdown = panel.querySelector("#mapsFavDropdown");
  const mapsNewFolderBtn = panel.querySelector("#mapsNewFolderBtn");

  if (mapsInput && mapsBtnGo) {
    const doSearch = () => handleMapsSearch(mapsInput.value);
    mapsBtnGo.addEventListener("click", doSearch);
    mapsInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doSearch();
      }
    });
  }

  if (mapsBtnSave) {
    mapsBtnSave.addEventListener("click", handleMapsSaveFavorite);
  }

  if (mapsFavToggle && mapsFavDropdown) {
    mapsFavToggle.addEventListener("click", () => {
      mapsFavDropdown.classList.toggle("open");
    });
  }
  
  if (mapsNewFolderBtn) {
    mapsNewFolderBtn.addEventListener("click", () => {
      openMapsFolderDialog(async (folder) => {
        const favsData = getMapsFavoritesData();
        favsData.folders.push(folder);
        state.maps.favorites = favsData;
        renderMapsFavorites();
        await persistMapsFavorites();
      });
    });
  }

  // Cargar lista de favoritos al crear el panel
  loadMapsFavorites();
}

function refreshMapsSearchTexts() {
  const panel   = document.getElementById("mapsSearchPanel");
  if (!panel) return;

  const mapsInput     = panel.querySelector("#mapsSearchInput");
  const mapsBtnGo     = panel.querySelector("#mapsSearchBtn");
  const mapsBtnSave   = panel.querySelector("#mapsFavSaveBtn");
  const mapsFavToggle = panel.querySelector("#mapsFavToggleBtn");
  const mapsNewFolderBtn= panel.querySelector("#mapsNewFolderBtn");

  if (mapsInput)     mapsInput.placeholder = t("mapsSearchPlaceholder");
  if (mapsBtnGo)     mapsBtnGo.textContent = t("mapsSearchBtn");
  if (mapsBtnSave)   mapsBtnSave.textContent = t("mapsFavSaveBtn");
  if (mapsFavToggle) {
    // El texto final (con el número de favoritos) se ajusta en renderMapsFavorites()
    mapsFavToggle.textContent = `⭐ ${t("mapsFavTitle")}`;
  }
  if (mapsNewFolderBtn) {
    mapsNewFolderBtn.textContent = `📁 ${t("mapsFavNewFolderBtn")}`;
  }

  // Volver a pintar la lista de favoritos con los textos correctos
  renderMapsFavorites();
}

function parseLatLon(text) {
  if (!text) return null;
  let s = String(text).trim();

  // Reemplaza punto y coma por coma, colapsa espacios
  s = s.replace(/;/g, ",").replace(/\s+/g, " ");

  const parts = s.split(/[,\s]+/).filter(Boolean);
  if (parts.length !== 2) return null;

  const lat = parseFloat(parts[0].replace(",", "."));
  const lon = parseFloat(parts[1].replace(",", "."));

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  return { lat, lon };
}

function handleMapsSearch(raw) {
  const v = (raw || "").trim();
  if (!v) return;

  const coords = parseLatLon(v);
  if (!coords) {
    toast(t("mapsInvalidCoords"));
    return;
  }

  if (!_map) {
    toast(t("mapsNotReady"));
    return;
  }

  const currentZoom = _map.getZoom() || 2;

  // Si estoy muy alejado (zoom-out fuerte), acerco a un nivel “ciudad”
  // Si ya estoy bastante cerca, mantengo el zoom actual para el efecto suave
  const zoom = currentZoom < 8 ? 10 : currentZoom;

  _map.flyTo({
    center: [coords.lon, coords.lat],  // maplibre usa [lon, lat]
    zoom,
    essential: true,
	duration: MAP_FLY_DURATION_MS 
  });

  // 📍 pintar chincheta en el punto de destino
  showMapsSearchMarker(coords.lat, coords.lon);

  // Guardamos última búsqueda para poder crear un favorito
  state.maps = state.maps || {};
  state.maps.lastSearchCoords = { lat: coords.lat, lon: coords.lon, zoom };

  const btnSave = document.getElementById("mapsFavSaveBtn");
  if (btnSave) btnSave.disabled = false;
}

function currentMapViewCoords() {
  if (!_map) return null;
  const c = _map.getCenter();
  return {
    lat: c.lat,
    lon: c.lng,
    zoom: _map.getZoom() || 10
  };
}

function ensureMapsFavoritesShape(raw) {
  // Compatibilidad: si viene como lista "vieja" → convertir a nuevo formato
  if (Array.isArray(raw)) {
    const items = raw.map((f, idx) => ({
      id: f.id || `fav_${idx}`,
      name: f.name || "",
      lat: f.lat,
      lon: f.lon,
      zoom: Number.isFinite(f.zoom) ? f.zoom : 10,
      folderId: f.folderId || null
    }));
    return { folders: [], items };
  }

  const folders = Array.isArray(raw && raw.folders) ? raw.folders : [];
  const items   = Array.isArray(raw && raw.items)   ? raw.items   : [];

  items.forEach((it, idx) => {
    if (!it.id) it.id = `fav_${idx}`;
    if (typeof it.folderId === "undefined") it.folderId = null;
  });

  folders.forEach((f, idx) => {
    if (!f.id) f.id = `fld_${idx}`;
  });

  return { folders, items };
}

function getMapsFavoritesData() {
  state.maps = state.maps || {};
  const base = state.maps.favorites;

  if (!base) {
    const empty = { folders: [], items: [] };
    state.maps.favorites = empty;
    return empty;
  }

  if (Array.isArray(base)) {
    const shaped = ensureMapsFavoritesShape(base);
    state.maps.favorites = shaped;
    return shaped;
  }

  const shaped = ensureMapsFavoritesShape(base);
  state.maps.favorites = shaped;
  return shaped;
}

function getMapFavoriteById(id) {
  const data = getMapsFavoritesData();
  return data.items.find(it => it.id === id) || null;
}

function getMapFolderById(id) {
  const data = getMapsFavoritesData();
  return data.folders.find(f => f.id === id) || null;
}

async function loadMapsFavorites() {
  try {
    const res = await fetch(`${BASE_URL}/api/maps/favorites`);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    state.maps = state.maps || {};
    state.maps.favorites = ensureMapsFavoritesShape(data);
    renderMapsFavorites();
  } catch (err) {
    console.error("[MAPS] Error cargando favoritos:", err);
    state.maps = state.maps || {};
    state.maps.favorites = { folders: [], items: [] };
    renderMapsFavorites();
  }
}

async function persistMapsFavorites() {
  try {
    const favs = getMapsFavoritesData();
    const res = await fetch(`${BASE_URL}/api/maps/favorites`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(favs)
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
  } catch (err) {
    console.error("[MAPS] Error guardando favoritos:", err);
    toast("⚠️ " + ((err && err.message) || t("mapsSaveFavoritesError")));
  }
}

function renderMapsFavorites() {
  const list          = document.getElementById("mapsFavList");
  const mapsFavToggle = document.getElementById("mapsFavToggleBtn");
  if (!list) return;

  list.innerHTML = "";

  const { folders, items } = getMapsFavoritesData();
  const totalCount = items.length;

  // Botón de toggle (texto + contador)
  if (mapsFavToggle) {
    mapsFavToggle.disabled = totalCount === 0;
    mapsFavToggle.textContent = totalCount === 0
      ? `⭐ ${t("mapsFavTitle")}`
      : `⭐ ${t("mapsFavTitle")} (${totalCount})`;
  }

  if (!totalCount) {
    const li = document.createElement("li");
    li.className = "maps-fav-empty";
    li.textContent = t("mapsFavEmpty");
    list.appendChild(li);

    if (_map) {
      renderMapsFavoriteMarkers();
    }
    return;
  }

  // 1) Favoritos por carpeta
  folders.forEach(folder => {
    const section = document.createElement("li");
    section.className = "maps-fav-section";

    const header = document.createElement("div");
    header.className = "maps-fav-folder-header";

    // Título (emoji + nombre)
    const titleSpan = document.createElement("span");
    titleSpan.className = "maps-fav-folder-title";
    titleSpan.textContent = `${folder.emoji || "📁"} ${folder.name}`;
    header.appendChild(titleSpan);

    // Acciones de carpeta (editar / eliminar)
    const actions = document.createElement("div");
    actions.className = "maps-fav-folder-actions";

    // ✏️ Editar carpeta
    const btnEditFolder = document.createElement("button");
    btnEditFolder.type = "button";
    btnEditFolder.className = "maps-fav-folder-edit";
    btnEditFolder.textContent = "✏️";
    btnEditFolder.title = t("mapsFolderEditTitle") || "Edit folder";
    btnEditFolder.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openMapsFolderEditDialog(folder, async (updated) => {
        const favsData = getMapsFavoritesData();
        const idx = favsData.folders.findIndex(f => f.id === folder.id);
        if (idx === -1) return;

        favsData.folders[idx].name  = updated.name;
        favsData.folders[idx].emoji = updated.emoji;

        state.maps.favorites = favsData;
        renderMapsFavorites();
        await persistMapsFavorites();
      });
    });

    // ✕ Eliminar carpeta
    const btnDelFolder = document.createElement("button");
    btnDelFolder.type = "button";
    btnDelFolder.className = "maps-fav-folder-del";
    btnDelFolder.textContent = "✕";
    btnDelFolder.title = t("mapsFolderDeleteTitle") || "Delete folder";
    btnDelFolder.addEventListener("click", (ev) => {
      ev.stopPropagation();
      handleDeleteMapsFolder(folder.id);
    });

    actions.appendChild(btnEditFolder);
    actions.appendChild(btnDelFolder);
    header.appendChild(actions);

    section.appendChild(header);

    const ulInner = document.createElement("ul");
    ulInner.className = "maps-fav-sublist";


    const folderItems = items.filter(it => it.folderId === folder.id);

    folderItems.forEach(it => {
      const li = document.createElement("li");
      li.className = "maps-fav-item";

      // Botón para ir al favorito
      const btnGoto = document.createElement("button");
      btnGoto.type = "button";
      btnGoto.className = "maps-fav-goto";
      // Puedes usar el nombre o el emoji de carpeta; aquí usamos el nombre
      btnGoto.textContent = it.name || `${Number(it.lat).toFixed(4)}, ${Number(it.lon).toFixed(4)}`;
      btnGoto.addEventListener("click", () => {
        gotoMapFavoriteById(it.id);
      });

      // Coordenadas
      const coordsSpan = document.createElement("span");
      coordsSpan.className = "maps-fav-coords";
      const lat = Number(it.lat);
      const lon = Number(it.lon);
      coordsSpan.textContent = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
      coordsSpan.title = it.name || coordsSpan.textContent;

      // ✏️ Botón editar
      const btnEdit = document.createElement("button");
      btnEdit.type = "button";
      btnEdit.className = "maps-fav-edit";
      btnEdit.textContent = "✏️";
      btnEdit.title = t("mapsFavEditTitle") || "Edit favorite";

      btnEdit.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const currentFav = getMapFavoriteById(it.id);
        if (!currentFav) return;

        openMapsFavEditDialog(currentFav, async ({ name, folderId }) => {
          const favsData = getMapsFavoritesData();
          const target = favsData.items.find(x => x.id === it.id);
          if (!target) return;

          target.name     = name;
          target.folderId = folderId;

          state.maps.favorites = favsData;
          renderMapsFavorites();
          await persistMapsFavorites();
          // Los marcadores se refrescan al final de esta función
        });
      });

      // ❌ Botón borrar
      const btnDel = document.createElement("button");
      btnDel.type = "button";
      btnDel.className = "maps-fav-del";
      btnDel.textContent = "✕";
      btnDel.title = t("mapsFavDeleteTitle");
      btnDel.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        await deleteMapFavoriteById(it.id);
      });

      li.appendChild(btnGoto);
      li.appendChild(coordsSpan);
      li.appendChild(btnEdit); // ← lápiz entre coords y cruz
      li.appendChild(btnDel);
      ulInner.appendChild(li);
    });

    if (ulInner.children.length > 0) {
      section.appendChild(ulInner);
      list.appendChild(section);
    }
  });

  // 2) Favoritos en la raíz (sin carpeta)
  const rootItems = items.filter(it => !it.folderId);
  if (rootItems.length > 0) {
    const section = document.createElement("li");
    section.className = "maps-fav-section";

    const header = document.createElement("div");
    header.className = "maps-fav-folder-header root";
    header.textContent = `⭐ ${t("mapsFavRootSection")}`;
    section.appendChild(header);

    const ulInner = document.createElement("ul");
    ulInner.className = "maps-fav-sublist";

    rootItems.forEach(it => {
      const li = document.createElement("li");
      li.className = "maps-fav-item";

      const btnGoto = document.createElement("button");
      btnGoto.type = "button";
      btnGoto.className = "maps-fav-goto";
      btnGoto.textContent = it.name || `${Number(it.lat).toFixed(4)}, ${Number(it.lon).toFixed(4)}`;
      btnGoto.addEventListener("click", () => {
        gotoMapFavoriteById(it.id);
      });

      const coordsSpan = document.createElement("span");
      coordsSpan.className = "maps-fav-coords";
      const lat = Number(it.lat);
      const lon = Number(it.lon);
      coordsSpan.textContent = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
      coordsSpan.title = it.name || coordsSpan.textContent;

      // ✏️ Botón editar
      const btnEdit = document.createElement("button");
      btnEdit.type = "button";
      btnEdit.className = "maps-fav-edit";
      btnEdit.textContent = "✏️";
      btnEdit.title = t("mapsFavEditTitle") || "Edit favorite";

      btnEdit.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const currentFav = getMapFavoriteById(it.id);
        if (!currentFav) return;

        openMapsFavEditDialog(currentFav, async ({ name, folderId }) => {
          const favsData = getMapsFavoritesData();
          const target = favsData.items.find(x => x.id === it.id);
          if (!target) return;

          target.name     = name;
          target.folderId = folderId;

          state.maps.favorites = favsData;
          renderMapsFavorites();
          await persistMapsFavorites();
        });
      });

      const btnDel = document.createElement("button");
      btnDel.type = "button";
      btnDel.className = "maps-fav-del";
      btnDel.textContent = "✕";
      btnDel.title = t("mapsFavDeleteTitle");
      btnDel.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        await deleteMapFavoriteById(it.id);
      });

      li.appendChild(btnGoto);
      li.appendChild(coordsSpan);
      li.appendChild(btnEdit); // ← lápiz aquí también
      li.appendChild(btnDel);
      ulInner.appendChild(li);
    });

    section.appendChild(ulInner);
    list.appendChild(section);
  }

  // 🧷 Marcadores en el mapa
  if (_map) {
    renderMapsFavoriteMarkers();
  }
}


function gotoMapFavoriteById(favId) {
  if (!_map) return;
  const fav = getMapFavoriteById(favId);
  if (!fav) return;

  const lat  = Number(fav.lat);
  const lon  = Number(fav.lon);
  const zoom = Number.isFinite(fav.zoom) ? fav.zoom : 10;

  _map.flyTo({ center: [lon, lat], zoom, essential: true, duration: MAP_FLY_DURATION_MS });
}

async function deleteMapFavoriteById(favId) {
  const favsData = getMapsFavoritesData();
  const fav = favsData.items.find(it => it.id === favId);
  if (!fav) return;

  const name = fav.name || `${Number(fav.lat).toFixed(4)}, ${Number(fav.lon).toFixed(4)}`;

  const title = t("mapsFavDeleteConfirmTitle");
  let msg = t("mapsFavDeleteConfirmMsg");
  msg = msg.replace("{name}", name);

  showConfirmDialog({
    title,
    message: msg,
    confirmLabel: t("mapsFavDeleteConfirmYes") || "OK",
    cancelLabel: t("mapsFavDeleteConfirmNo")  || "Cancel",
    onConfirm: async () => {
      favsData.items = favsData.items.filter(it => it.id !== favId);
      state.maps.favorites = favsData;
      renderMapsFavorites();
      await persistMapsFavorites();
    }
  });
}

function handleDeleteMapsFolder(folderId) {
  const favsData = getMapsFavoritesData();
  const folder = favsData.folders.find(f => f.id === folderId);
  if (!folder) return;

  const name = folder.name || (t("mapsFolderUnnamed") || "Folder");

  const titleDefault = "Delete folder";
  const msgDefault = "Delete folder “{name}”? Favorites inside will be moved to the root (no folder).";

  const title = t("mapsFolderDeleteTitle") || titleDefault;
  let msg     = t("mapsFolderDeleteMsg") || msgDefault;
  msg = msg.replace("{name}", name);

  showConfirmDialog({
    title,
    message: msg,
    confirmLabel: t("mapsFolderDeleteConfirmYes") || t("mapsFavDeleteConfirmYes") || "Delete",
    cancelLabel: t("mapsFolderDeleteConfirmNo")  || t("mapsFavDeleteConfirmNo")  || "Cancel",
    onConfirm: async () => {
      // 1) Mover favoritos de esta carpeta a la raíz
      favsData.items.forEach(it => {
        if (it.folderId === folderId) {
          it.folderId = null;
        }
      });

      // 2) Eliminar la carpeta
      favsData.folders = favsData.folders.filter(f => f.id !== folderId);

      state.maps.favorites = favsData;
      renderMapsFavorites();
      await persistMapsFavorites();
    }
  });
}

function openMapsFavNameDialog(defaultLabel, onConfirm) {
  const title = t("mapsFavTitle");
  const msg   = t("mapsFavPromptMsg");

  const favsData = getMapsFavoritesData();
  const folders = favsData.folders || [];

  const options = [
    `<option value="">${t("mapsFavRootSection")}</option>`,
    ...folders.map(f => `<option value="${f.id}">${f.emoji || "📁"} ${f.name}</option>`)
  ].join("");

  const overlay = document.createElement("div");
  overlay.className = "dialog-backdrop maps-fav-name-backdrop";

  overlay.innerHTML = `
    <div class="dialog maps-fav-name-dialog">
      <h2 class="dialog-title">${title}</h2>
      <p class="dialog-message">${msg}</p>

      <label class="dialog-label">
        <span>${t("mapsFavPromptMsg")}</span>
        <input
          id="mapsFavNameInput"
          class="dialog-input"
          type="text"
          autocomplete="off"
          value="${defaultLabel}"
        />
      </label>

      <label class="dialog-label">
        <span>${t("mapsFavFolderLabel")}</span>
        <select id="mapsFavFolderSelect" class="dialog-select">
          ${options}
        </select>
      </label>

      <div class="dialog-buttons">
        <button type="button" class="btn-secondary" data-role="cancel">
          ${t("mapsFavDeleteConfirmNo") || "Cancel"}
        </button>
        <button type="button" class="btn-primary" data-role="ok">
          ${t("mapsFavSaveBtn")}
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const input       = overlay.querySelector("#mapsFavNameInput");
  const folderSelect= overlay.querySelector("#mapsFavFolderSelect");
  const btnOk       = overlay.querySelector('[data-role="ok"]');
  const btnCancel   = overlay.querySelector('[data-role="cancel"]');

  function close() {
    try { document.body.removeChild(overlay); } catch (_) {}
  }

  btnOk.addEventListener("click", () => {
    const name = (input.value || "").trim();
    if (!name) {
      input.focus();
      return;
    }
    const folderId = folderSelect.value || null;
    close();
    if (typeof onConfirm === "function") {
      onConfirm({ name, folderId });
    }
  });

  btnCancel.addEventListener("click", close);

  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) close();
  });

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      btnOk.click();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      close();
    }
  });

  input.focus();
  input.select();
}

function openMapsFavEditDialog(fav, onConfirm) {
  const data = getMapsFavoritesData();
  const folders = data.folders || [];

  const backdrop = document.createElement("div");
  backdrop.className = "dialog-backdrop maps-fav-name-backdrop";

  const dialog = document.createElement("div");
  dialog.className = "dialog maps-fav-name-dialog";

  // 🔹 Título
  const titleEl = document.createElement("h2");
  titleEl.className = "dialog-title";
  titleEl.textContent = t("mapsFavEditTitle") || "Edit favorite";
  dialog.appendChild(titleEl);

  // 🔹 Campo de nombre
  const nameLabel = document.createElement("label");
  nameLabel.className = "dialog-label";

  const nameSpan = document.createElement("span");
  nameSpan.textContent = t("mapsFavNameLabel") || "Name";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "dialog-input";

  const defaultLabel =
    fav.name && fav.name.trim()
      ? fav.name.trim()
      : `${Number(fav.lat).toFixed(4)}, ${Number(fav.lon).toFixed(4)}`;

  input.value = defaultLabel;
  input.placeholder =
    t("mapsFavNamePlaceholder") || "Favorite name...";

  nameLabel.appendChild(nameSpan);
  nameLabel.appendChild(input);
  dialog.appendChild(nameLabel);

  // 🔹 Selector de carpeta
  const folderLabel = document.createElement("label");
  folderLabel.className = "dialog-label";

  const folderSpan = document.createElement("span");
  folderSpan.textContent =
    t("mapsFavFolderLabel") || "Folder";

  const select = document.createElement("select");
  select.className = "dialog-select";

  // Opción raíz
  const optRoot = document.createElement("option");
  optRoot.value = "";
  optRoot.textContent =
    t("mapsFavRootOption") || "No folder (root)";
  select.appendChild(optRoot);

  // Carpeta actual del favorito (si tiene)
  const currentFolderId = fav.folderId || null;

  folders.forEach((f) => {
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = `${f.emoji || "📁"} ${f.name}`;
    if (currentFolderId && f.id === currentFolderId) {
      opt.selected = true;
    }
    select.appendChild(opt);
  });

  folderLabel.appendChild(folderSpan);
  folderLabel.appendChild(select);
  dialog.appendChild(folderLabel);

  // 🔹 Botones
  const actions = document.createElement("div");
  actions.className = "dialog-actions";

  const btnCancel = document.createElement("button");
  btnCancel.type = "button";
  btnCancel.className = "btn secondary";
  btnCancel.textContent = t("cancel") || "Cancel";

  const btnOk = document.createElement("button");
  btnOk.type = "button";
  btnOk.className = "btn primary";
  btnOk.textContent = t("ok") || "OK";

  actions.appendChild(btnCancel);
  actions.appendChild(btnOk);
  dialog.appendChild(actions);

  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);

  function close() {
    backdrop.remove();
  }

  btnCancel.addEventListener("click", () => {
    close();
  });

  btnOk.addEventListener("click", () => {
    const name = (input.value || "").trim();
    if (!name) {
      input.focus();
      return;
    }
    const folderId = select.value || null;
    if (typeof onConfirm === "function") {
      onConfirm({ name, folderId });
    }
    close();
  });

  // Esc → cerrar, Enter → guardar
  backdrop.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      close();
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      btnOk.click();
    }
  });

  // Foco inicial
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
}


function openMapsFolderDialog(onConfirm) {
  const overlay = document.createElement("div");
  overlay.className = "dialog-backdrop maps-folder-dialog-backdrop";

  const emojiButtons = MAPS_FOLDER_EMOJIS.map((e, idx) =>
    `<button type="button" class="emoji-option" data-emoji="${e}" ${idx === 0 ? 'data-selected="true"' : ""}>${e}</button>`
  ).join("");

  overlay.innerHTML = `
    <div class="dialog maps-folder-dialog">
      <h2 class="dialog-title">${t("mapsFolderDialogTitle")}</h2>

      <label class="dialog-label">
        <span>${t("mapsFolderNameLabel")}</span>
        <input
          id="mapsFolderNameInput"
          class="dialog-input"
          type="text"
          autocomplete="off"
        />
      </label>

      <div class="dialog-emoji-row">
        <span class="dialog-emoji-label">${t("mapsFolderEmojiLabel")}</span>
        <div class="dialog-emoji-grid">
          ${emojiButtons}
        </div>
      </div>

      <div class="dialog-buttons">
        <button type="button" class="btn-secondary" data-role="cancel">
          ${t("mapsFavDeleteConfirmNo") || "Cancel"}
        </button>
        <button type="button" class="btn-primary" data-role="ok">
          ${t("mapsFolderCreate")}
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const input      = overlay.querySelector("#mapsFolderNameInput");
  const btnOk      = overlay.querySelector('[data-role="ok"]');
  const btnCancel  = overlay.querySelector('[data-role="cancel"]');
  const emojiGrid  = overlay.querySelector(".dialog-emoji-grid");
  let selectedEmoji= MAPS_FOLDER_EMOJIS[0];

  function close() {
    try { document.body.removeChild(overlay); } catch (_) {}
  }

  emojiGrid.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".emoji-option");
    if (!btn) return;
    selectedEmoji = btn.dataset.emoji;
    emojiGrid.querySelectorAll(".emoji-option").forEach(b => {
      b.removeAttribute("data-selected");
    });
    btn.setAttribute("data-selected", "true");
  });

  btnOk.addEventListener("click", () => {
    const name = (input.value || "").trim();
    if (!name) {
      input.focus();
      return;
    }
    const id = `fld_${Date.now()}`;
    close();
    if (typeof onConfirm === "function") {
      onConfirm({ id, name, emoji: selectedEmoji });
    }
  });

  btnCancel.addEventListener("click", close);
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) close();
  });

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      btnOk.click();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      close();
    }
  });

  input.focus();
}

function openMapsFolderEditDialog(folder, onConfirm) {
  const overlay = document.createElement("div");
  overlay.className = "dialog-backdrop maps-folder-dialog-backdrop";

  const currentEmoji = folder.emoji || MAPS_FOLDER_EMOJIS[0];

  const emojiButtons = MAPS_FOLDER_EMOJIS.map((e) =>
    `<button type="button" class="emoji-option" data-emoji="${e}" ${
      e === currentEmoji ? 'data-selected="true"' : ""
    }>${e}</button>`
  ).join("");

  overlay.innerHTML = `
    <div class="dialog maps-folder-dialog">
      <h2 class="dialog-title">${t("mapsFolderEditTitle") || "Edit folder"}</h2>

      <label class="dialog-label">
        <span>${t("mapsFolderNameLabel")}</span>
        <input
          id="mapsFolderEditNameInput"
          class="dialog-input"
          type="text"
          autocomplete="off"
          value="${folder.name || ""}"
        />
      </label>

      <div class="dialog-emoji-row">
        <span class="dialog-emoji-label">${t("mapsFolderEmojiLabel")}</span>
        <div class="dialog-emoji-grid">
          ${emojiButtons}
        </div>
      </div>

      <div class="dialog-buttons">
        <button type="button" class="btn-secondary" data-role="cancel">
          ${t("mapsFavDeleteConfirmNo") || "Cancel"}
        </button>
        <button type="button" class="btn-primary" data-role="ok">
          ${t("ok") || "OK"}
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const input      = overlay.querySelector("#mapsFolderEditNameInput");
  const btnOk      = overlay.querySelector('[data-role="ok"]');
  const btnCancel  = overlay.querySelector('[data-role="cancel"]');
  const emojiGrid  = overlay.querySelector(".dialog-emoji-grid");
  let selectedEmoji= currentEmoji;

  function close() {
    try { document.body.removeChild(overlay); } catch (_) {}
  }

  emojiGrid.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".emoji-option");
    if (!btn) return;
    selectedEmoji = btn.dataset.emoji;
    emojiGrid.querySelectorAll(".emoji-option").forEach(b => {
      b.removeAttribute("data-selected");
    });
    btn.setAttribute("data-selected", "true");
  });

  btnOk.addEventListener("click", () => {
    const name = (input.value || "").trim();
    if (!name) {
      input.focus();
      return;
    }
    close();
    if (typeof onConfirm === "function") {
      onConfirm({ id: folder.id, name, emoji: selectedEmoji });
    }
  });

  btnCancel.addEventListener("click", close);
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) close();
  });

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      btnOk.click();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      close();
    }
  });

  input.focus();
  input.select();
}


function openLibNewFolderDialog(onConfirm) {
  // Backdrop oscuro
  const overlay = document.createElement("div");
  overlay.className = "dialog-backdrop lib-mkdir-dialog-backdrop";

  overlay.innerHTML = `
    <div class="dialog lib-mkdir-dialog">
      <h2 class="dialog-title">
        ${t("libNewFolder") || "New folder"}
      </h2>

      <label class="dialog-label">
        <span>${t("libNewFolderNameLabel") || "Folder name"}</span>
        <input
          id="libMkdirNameInput"
          class="dialog-input"
          type="text"
          autocomplete="off"
        />
      </label>

      <div class="dialog-buttons">
        <button type="button" class="btn-secondary" data-role="cancel">
          ${t("calNew_cancel") || "Cancel"}
        </button>
        <button type="button" class="btn-primary" data-role="ok">
          ${t("libNewFolderCreate") || "Create folder"}
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const input    = overlay.querySelector("#libMkdirNameInput");
  const btnOk    = overlay.querySelector('[data-role="ok"]');
  const btnCancel= overlay.querySelector('[data-role="cancel"]');

  function close() {
    try { document.body.removeChild(overlay); } catch (_) {}
  }

  // Cerrar haciendo clic fuera del cuadro
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) close();
  });

  // Botón Cancel
  btnCancel.addEventListener("click", () => {
    close();
  });

  // Botón OK
  btnOk.addEventListener("click", () => {
    const name = (input.value || "").trim();
    if (!name) {
      input.focus();
      return;
    }
    close();
    if (typeof onConfirm === "function") {
      onConfirm(name);
    }
  });

  // Enter → OK, Esc → Cancelar
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      btnOk.click();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      close();
    }
  });

  // Foco inicial
  input.focus();
}


async function handleMapsSaveFavorite() {
  if (!_map) return;

  // Preferimos la última búsqueda; si no, el centro actual
  let view = state.maps && state.maps.lastSearchCoords;
  if (!view) {
    view = currentMapViewCoords();
  }
  if (!view) return;

  const defLabel = `${view.lat.toFixed(4)}, ${view.lon.toFixed(4)}`;

  openMapsFavNameDialog(defLabel, async ({ name, folderId }) => {
    const favsData = getMapsFavoritesData();

    const newItem = {
      id: `fav_${Date.now()}`,
      name,
      lat: view.lat,
      lon: view.lon,
      zoom: view.zoom,
      folderId: folderId
    };

    favsData.items.push(newItem);
    state.maps.favorites = favsData;

    renderMapsFavorites();
    await persistMapsFavorites();
  });
}



// --- Helpers de estilo offline + parcheo de pmtiles:// ---
function getAppTheme(){
  const root = document.documentElement;
  const theme = root.dataset.theme || root.getAttribute("data-theme") || "light";
  return theme === "dark" ? "dark" : "light";
}

// Helper para inyectar el CSS dentro del iframe de la pizarra
function ensureWhiteboardCss(frame) {
  try {
    const doc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
    if (!doc) return;

    const head = doc.head || doc.getElementsByTagName("head")[0];
    if (!head) return;

    // Evitar duplicar el <style>
    if (doc.getElementById("offlined-whiteboard-css")) return;

    const style = doc.createElement("style");
    style.id = "offlined-whiteboard-css";
    style.textContent = `
      .excalidraw .sidebar-trigger {
        display: none !important;
      }
    `;

    head.appendChild(style);
  } catch (err) {
    console.warn("[WHITEBOARD] No se pudo inyectar CSS en el iframe", err);
  }
}

function broadcastThemeToWhiteboard(theme){
  try {
    const frame = document.getElementById("whiteboardFrame");
    if (!frame || !frame.contentWindow) return;

    // ⬇️ Inyectar CSS cuando el iframe termina de cargar
    frame.addEventListener("load", () => {
      try {
        const doc = frame.contentDocument || frame.contentWindow.document;
        if (!doc) return;

        // Crear un <style> dentro del iframe
        const style = doc.createElement("style");
        style.textContent = `
          .excalidraw .default-sidebar-trigger,
          .excalidraw .sidebar-trigger {
            display: none !important;
          }
        `;

        // Insertar el <style> en el head del iframe
        doc.head.appendChild(style);

      } catch (err) {
        console.warn("[WHITEBOARD] No se pudo ocultar sidebar-trigger", err);
      }
    });

    // ⬇️ Código original tuyo para pasar el tema
    frame.contentWindow.postMessage(
      {
        type: "OFFLINED_THEME_CHANGED",
        theme: theme === "dark" ? "dark" : "light"
      },
      "*"
    );
  } catch (err) {
    console.warn("[WHITEBOARD] Error enviando OFFLINED_THEME_CHANGED", err);
  }
}



function absolutizeAsset(u){
  if (!u) return u;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("/")) return `${BASE_URL}${u}`;
  return `${BASE_URL}/${u.replace(/^\.\//,'')}`;
}

async function loadLocalStyleAndPatch(pmtilesFileName = "planet.pmtiles", themeOverride) {
  const theme = themeOverride || getAppTheme();
  const styleUrl = `/assets/maps/styles/protomaps-${theme}.json`;
  const style = await (await fetch(styleUrl)).json();

  // Fuerza el .pmtiles a ir por tu backend
  const pmtilesAbs = `pmtiles://${BASE_URL}/assets/maps/${pmtilesFileName}`;
  
  for (const k of Object.keys(style.sources || {})) {
    const s = style.sources[k];
    if (s && s.type === "vector") {
      s.url = pmtilesAbs;
      s.attribution = MAP_ATTR;
    }
  }

  // sprite/glyphs ABSOLUTOS Y LOCALES
  const defaultSpriteBase = `${BASE_URL}/assets/maps/basemaps-assets/sprites/v4/${theme}`;
  const defaultGlyphs     = `${BASE_URL}/assets/maps/basemaps-assets/fonts/{fontstack}/{range}.pbf`;

  style.sprite = style.sprite ? absolutizeAsset(style.sprite) : defaultSpriteBase;
  style.glyphs = style.glyphs ? absolutizeAsset(style.glyphs) : defaultGlyphs;

  return style;
}

// Fallback mínimo para PMTiles que NO sean el basemap de Protomaps
async function buildMinimalStyle(httpUrl, themeOverride) {
  let vecLayer = null;
  try {
    const meta = await new pmtiles.PMTiles(httpUrl).getMetadata();
    vecLayer = meta?.vector_layers?.[0]?.id || null;
  } catch {}

  const theme  = themeOverride || getAppTheme();
  const isDark = theme === "dark";

  return {
    version: 8,
    sources: {
      basemap: {
        type: "vector",
        url: `pmtiles://${httpUrl}`,
        attribution: MAP_ATTR
      }
    },
    layers: [
      {
        id: "bg",
        type: "background",
        paint: { "background-color": isDark ? "#0b0f14" : "#f7f5f0" }
      },
      ...(vecLayer ? [
        {
          id: "layer-fill",
          type: "fill",
          source: "basemap",
          "source-layer": vecLayer,
          paint: {
            "fill-color": isDark ? "#3b4756" : "#c7d9ff",
            "fill-opacity": 0.6
          }
        },
        {
          id: "layer-line",
          type: "line",
          source: "basemap",
          "source-layer": vecLayer,
          paint: {
            "line-color": isDark ? "#93a3b5" : "#4966a3",
            "line-width": 0.5
          }
        }
      ] : [])
    ]
  };
}

// Recarga el estilo del mapa al cambiar el tema, conservando cámara
async function reloadMapStyleForTheme(pmtilesFileName = "planet.pmtiles", themeOverride){
  if (!_map) return;

  const appTheme = (typeof getAppTheme === "function") ? getAppTheme() : (
    document.documentElement.dataset.theme || 
    document.documentElement.getAttribute("data-theme") || 
    "dark"
  );
  const httpUrl = `${BASE_URL}/assets/maps/${pmtilesFileName}`;

  console.log("[MAPS] reloadMapStyleForTheme", {
    pmtilesFileName,
    themeOverride,
    appTheme
  });

  // 1) Guardar cámara actual
  const center  = _map.getCenter();
  const zoom    = _map.getZoom();
  const pitch   = _map.getPitch();
  const bearing = _map.getBearing();

  try {
    // 2) Detectar si es estilo Protomaps "tocho"
    let meta = null;
    try {
      meta = await new pmtiles.PMTiles(httpUrl).getMetadata();
    } catch(e) {}

    const names = new Set((meta?.vector_layers || []).map(l => l.id));
    const isProtomaps = ["water","roads","landuse","boundaries"].some(n => names.has(n));

    const style = isProtomaps
      ? await loadLocalStyleAndPatch(pmtilesFileName, themeOverride)
      : await buildMinimalStyle(httpUrl, themeOverride);

    _map.setStyle(style, { diff: false });
  } catch (err) {
    console.warn("[MAPS] error building style, fallback minimal:", err);
    const fallback = await buildMinimalStyle(httpUrl, themeOverride);
    _map.setStyle(fallback, { diff: false });
  }

  // 3) Cuando el style está listo, restaurar cámara y ajustar tamaño
  _map.once("styledata", () => {
    try { _map.jumpTo({ center, zoom, pitch, bearing }); } catch(e){}
    try { _map.resize(); } catch(e){}
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

function paintTextDocPlaceholder(){
  const titleEl = document.getElementById("textDocTitle");
  const p1El    = document.getElementById("textDocP1");
  const p2El    = document.getElementById("textDocP2");

  if (titleEl) titleEl.textContent = t("textDocTitle");
  if (p1El)    p1El.textContent    = t("textDocP1");
  if (p2El)    p2El.textContent    = t("textDocP2");
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

  // Si ya existe el mapa, no lo toques aquí.
  // El estilo se actualizará cuando cambie el tema.
  if (_map) {
    return;
  }

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

  // 🖱️ Click en el mapa → colocar chincheta y preparar favorito
  _map.on("click", (ev) => {
    if (!ev || !ev.lngLat) return;

    const lat  = ev.lngLat.lat;
    const lon  = ev.lngLat.lng;
    const zoom = _map.getZoom() || 10;

    // Guardamos estas coords como "última búsqueda" para reutilizar al guardar
    state.maps = state.maps || {};
    state.maps.lastSearchCoords = { lat, lon, zoom };

    // Pintar / mover la chincheta 📍
    showMapsSearchMarker(lat, lon);

    // Habilitar botón "Guardar favorito"
    const btnSave = document.getElementById("mapsFavSaveBtn");
    if (btnSave) btnSave.disabled = false;
  });

  _map.on("load", () => { _mapReady = true; _map.resize(); });
}

// ===== I18N =====
const I18N = {
  en: {
    talkToModel: "💻 Model",
    talkToAgents: "👤 Agents",
    modeWiki: "🏛️ Wikipedia",
    modeMedia:  "📁 Media",
    modeVideo:  "🎬 Video",
    modeMusic:  "🎵 Music",
    modeImages: "🖼️ Images",
	modeFiles:  "📂 Files",
	modePortableApps: "🧰 Portable Apps",
	modeSync:   "🔄 Sync",
	modeTrash:  "🗑️ Trash",
    modeLibrary:"📖 Library",
    modeWorld: "🌍 World",
    selectAgent: "Select agent",
    typing: "typing",
    survivorInit: "Hi! I’m your offline knowledge assistant. Ask me about any topic, and I’ll explain it as best as I can.",
    step1: "Step 1/2 · Browse",
    step2: "Step 2/2 · Review profile",
    allCategories: "All",
    startChat: "Start chat with this agent",
    back: "← Back",
    reset: "🔄️ Restart chat",
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
    skyTitle: "✨ Sky — coming in Version 4",
    skyP1: "Sky will be powered by d3-Clestial and work fully offline.",
    skyP2: "Estimated additional package size: ~80 MB.",
    skySettingsTitle: "Sky settings",
    skySettingsBtnLabel: "Open sky settings",
    skyLatLabel: "Latitude (°)",
    skyLonLabel: "Longitude (°)",
    skyDateLabel: "Date",
    skyTimeLabel: "Time",
    skyMagLimitLabel: "Star magnitude limit",
    skyOptionsLegend: "Options",
    skyShowConstellations: "Show constellation lines",
    skyShowConstNames: "Show constellation names",
    skyShowGrid: "Show grid",
    skyShowHorizon: "Show horizon",
    skyShowPlanets: "Show Sun, Moon and planets",
    skySettingsApply: "Apply",
    skySettingsCancel: "Cancel",
    modeMaps: "🗺️ Maps",
    mapsTitle:"🌍️ Maps — coming in Version 2",
	mapsSearchPlaceholder: "Lat, lon (e.g. 40.4168, -3.7038)",
	mapsSearchBtn: "Go",
	mapsFavSaveBtn: "Save favorite",
	mapsFavTitle: "Favorites",
	mapsFavEmpty: "No map favorites yet.",
	mapsFavGotoTitle: "Go to this favorite",
	mapsFavDeleteTitle: "Remove favorite",
	mapsFavPromptMsg: "Name for this favorite location:",
	mapsInvalidCoords: "Could not read coordinates. Use format: lat, lon (e.g. 40.4168, -3.7038).",
	mapsFavDeleteConfirmTitle: "Delete favorite",
	mapsFavDeleteConfirmMsg: "Are you sure you want to remove “{name}” from your favorite locations?",
	mapsFavDeleteConfirmYes: "Delete",
	mapsFavDeleteConfirmNo: "Cancel",
    mapsFavNewFolderBtn: "New folder",
    mapsFavRootSection: "Unsorted",
    mapsFavFolderLabel: "Folder:",
    mapsFolderDialogTitle: "New favorites folder",
    mapsFolderNameLabel: "Folder name:",
    mapsFolderEmojiLabel: "Choose an icon:",
    mapsFolderCreate: "Create folder",
	mapsFavEditTitle: "Edit favorite",
    mapsFolderEditTitle: "Edit favorites folder",
    mapsFolderDeleteTitle: "Delete folder",
    mapsFolderDeleteMsg: "Delete folder “{name}”? Favorites inside will be moved to the root (no folder).",
    mapsFolderDeleteConfirmYes: "Delete",
    mapsFolderDeleteConfirmNo: "Cancel",
    mapsFolderUnnamed: "Folder",
    modeTextDoc: "📄 Text document",
    textDocTitle: "📄 Text documents — coming in Version 4",
    textDocP1: "This section will be powered by Univer and will work fully offline.",
    textDocP2: "You’ll be able to create and edit local text documents with a familiar Office-like experience.",
    modeSupporters: "❤️",
    supportersTitle: "Thanks to our supporters",
    supportersSubtitle: "They help keep Survival AI Stick alive and 100% offline.",
    supportersCta: "Want to support? Add your logo to /assets/supporters and your entry to supporters.json.",
    modeSupportersTag: "Mode: Supporters",
    noSupporters: "No supporters yet.",
    cat_creators: "Creators",
    cat_promoters: "Promoters",
    cat_collaborators: "Collaborators",
    cat_donors: "Donors",
    cat_funders: "Funders",
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
    libDownload: "Download",
    libFilterPlaceholder: "Filter…",
    libSortName: "Name",
    libSortSize: "Size",
    libSortType: "Type",
    libUpload: "⬆️ Upload",
    libNewFolder: "📁 New folder",
    libNewFolderNameLabel: "Folder name",
    libNewFolderCreate: "Create folder",
    libMkdirError: "Error creating folder",
    libDropzoneHint: "Drop files here or click to upload",
    // 🆕 Bio labels
    lbl_born: "Born",
    lbl_birthplace: "Birthplace",
    lbl_nationality: "Nationality",
    lbl_bio: "Biography",
    introModalTitle: "🌐 OFFLINED: The Internet Alternative",
    introModalBody: `
      <p>🌐 <strong>OFFLINED: The Internet Alternative</strong><br>
      A 100% Offline AI and Knowledge System. An alternative to the Internet. Knowledge survives even when the web doesn’t.</p>

      <p>🚨 <strong>The Problem</strong><br>
      Today, 4 billion people still lack reliable internet access.<br>
      Even where internet exists, it is fragile — vulnerable to power loss, censorship, disasters, or cost barriers.<br>
      Modern AI and knowledge tools depend entirely on the cloud.<br>
      When the network goes down, so does access to education, medicine, maps, and communication.<br>
      Human knowledge shouldn’t disappear when the signal drops.</p>

      <p>💡 <strong>The Solution — OFFLINED</strong><br>
      OFFLINED is a desktop-style web app that runs completely offline.<br>
      It integrates an AI language model, expert agents, Wikipedia, maps, and a document library — all working locally, without internet.<br>
      A self-contained, intelligent knowledge environment for education, survival, and autonomy.</p>

      <p class="intro-modal-slogan">“When the web goes dark, knowledge stays online — with OFFLINED.”</p>
    `,
    introModalNeverShowLabel: "Do not show this message next time",
    introModalClose: "Close",
    // 🆕 Wiki-trees
    wikiTrees: "🌿 Wiki-trees",
	talkToEncartha: "🎓 Talk to Michael Encartha", 
    wikiTreesCatalogTitle: "Select a tree",
    wikiTreesOpen: "Open",
    wikiTreesClose: "Close",
    wikiTreesBack: "← Back to catalog",
    wikiTreesFilter: "Filter…",
    wikiTreesCollapseTitle: "Collapse/Expand",
    // 🆕 Wiki-trees extras (EN)
    treeSearchPlaceholder: "Search this wiki-tree…",
    treeSearchBtn: "Search",
    expandAllTitle: "Expand all",
    collapseAllTitle: "Collapse all",
    expandLevel2Title: "Expand to level 4",
    toggleViewTitle: "Toggle view",
    favoritesTitle: "Favorites",
    recentsTitle: "Recents",
    favEmpty: "No favorites yet.",
    favRemoveTitle: "Remove from favorites",
    recentsEmpty: "No recents yet.",
    study_notStarted: "Not started",
    study_inProgress: "In progress",
    study_done: "Completed",
    study_overall: "Overall",
    ach_first_open: "First wiki article opened",
    ach_5_done: "First 5 wiki articles completed",
    ach_10_percent: "10% of the tree studied",
    ach_25_percent: "25% of the tree studied",
    ach_50_percent: "50% of the tree studied",
    ach_100_percent: "100% of the tree studied — great job!",
    ach_unlock_toast: "Achievement unlocked",
    achievementsTitle: "Achievements",
    achievementsEmpty: "No achievements yet.",
    achievementsReset: "Reset achievements",
    achievementsProgress: "Overall progress",
    resetProgress: "Reset progress",
    resetConfirmTitle: "Reset progress",
    resetConfirmMsg: "Are you sure you want to delete all progress for “{name}”? This cannot be undone.",
    resetYes: "Delete",
    resetNo: "Cancel",
    resetDone: "Progress and recents cleared.",
    openStudy: "Open & Study",
    drilldown: "Drill down",
    elements: "elements",
    openStudy: "Open & Study",         // ya existe en EN, confirmar
    drilldown: "Drill down",           // ya existe en EN, confirmar
    encartha_instr_open: "Click on <b>🔎</b> to open and study the wiki-tree.",
    encartha_instr_drill: "Click on <b>➕</b> to go down one level (on leaves you’ll see <b>🌐</b> to open the article).",
    encartha_hint_nav: "Keep navigating this wiki-tree at upper levels or go back to categories to choose another one.",
    encartha_backCats: "↩️ Back to categories",
    encartha_backRoot: "⤴️ Back to root",
    resumeLabel: "Resume",
    err_tree_not_loaded: "⚠️ Tree not loaded.",
    err_tree_not_loaded_cat: "⚠️ Tree not loaded in this category.",
    err_node_not_found: "⚠️ Node not found.",
    resume_toast: "▶ Resuming at: {name}",
    encartha_intro: "Hello! I'm <b>Michael Encartha</b>, your study companion for the wiki-trees. I’ll help you explore them in depth and we’ll track your progress together.",
    encartha_cats_title: "Categories available for study:",
    encartha_hint_open: "Click 🔎 to open and study the wiki-tree.",
    encartha_hint_expand: "Click ➕ to go down to the next level of the tree.",
    encartha_hint_article: "Click 🌐 to open the final-level article on Wikipedia.",
    encartha_hint_resume: "Click ▶ to resume studying where you left off.",
    encartha_intro_resume: "Alright, let’s keep studying another branch of Wikipedia—pick a new category.",
    consultWiki: "View on Wikipedia",
    openStudy: "Open & Study",
    drilldown: "Drill down",
    modeApps: "➕",
    modeNotes: "🗒️ Notepad",
    notesNew: "New",
    notesDelete: "Delete",
    notesSave: "Save",
    notesUntitled: "Untitled note",
    notesSearchPlaceholder: "Search notes...",
    notesDeleteConfirmTitle: "Delete note",
    notesDeleteConfirmMsg: "Are you sure you want to delete the note “{name}”?",
	modeAudioNotes: "🎙️ Audio notes",
	audioNew: "New",
	audioDelete: "Delete",
	audioRecord: "Record",
	audioStop: "Stop",
	audioUntitled: "Untitled recording",
	audioSearchPlaceholder: "Search audio notes...",
	audioFilterNormalize: "Normalize volume",
	audioFilterNoise: "Noise reduction",
	audioFilterHighpass: "High-pass filter",
	audioNoSupport: "Your browser doesn’t support audio recording.",
	audioDeleteConfirmTitle: "Delete audio",
	audioDeleteConfirmMsg: "Are you sure you want to delete the audio “{name}”?",
	audioNameRequiredTitle: "Name required",
	audioNameRequiredMsg: "Before recording, please give a name to the audio note.",
	audioOverwriteConfirmTitle: "Overwrite audio",
	audioOverwriteConfirmMsg: "An audio note named “{name}” already exists. Do you want to overwrite it?",
    mediav_prev: "Previous",
    mediav_next: "Next",
    mediav_close: "Close",
    mediav_cc: "Subtitles (CC)",
    mediav_viewer: "Media viewer",
    mediav_playlist: "Playlist",
	mediaDelete: "Delete",
	mediaDeleteConfirmTitle: "Delete item",
	mediaDeleteConfirmMsg: "Are you sure you want to delete \"{name}\"?",
	portableAppsConfirmTitle: "Launch app",
	portableAppsConfirmMsg: "Do you want to start \"{name}\"?",
	portableAppsStart: "Start",
    trashRestore: "Restore",
    trashRestoreTitle: "Restore item",
    trashRestoreConfirmMsg: "Do you want to restore \"{name}\" to its original location?",
    trashDeleteConfirmTitle: "Delete permanently",
    trashDeleteConfirmMsg: "This will permanently delete \"{name}\". Continue?",
    trashRestoreAll: "Restore all",
    trashRestoreAllTitle: "Restore all items",
    trashRestoreAllConfirmMsg: "Do you want to restore {count} item(s) from the recycle bin?",
    trashDeleteAll: "Delete all permanently",
    trashDeleteAllTitle: "Delete all permanently",
    trashDeleteAllConfirmMsg: "This will permanently delete {count} item(s) from the recycle bin. This action cannot be undone. Continue?",
    syncNoPeers: "No other Offlined instances detected on external drives for file transfer.",
    syncImportOne: "Import",
    imgv_viewer: "Image viewer",
    imgv_prev: "Previous",
    imgv_next: "Next",
    imgv_close: "Close",
    imgv_imagesInFolder: "Images in folder",
    docv_viewer: "Document viewer",
    docv_close: "Close",
    modeCalendar: "📅 Calendar",
    calToday: "Today",
    calPrev: "Prev",
    calNext: "Next",
	calMonth: "Month",
	calWeek:  "Week",
	calDay:   "Day",
	calList:  "Agenda",
	calMulti: "Multi-month",
	calNew: "New event",
	calNew_title: "New event",
	calNew_edit: "Edit event",
	calNew_label_title: "Title",
	calNew_label_date: "Date",
	calNew_label_time: "Time",
	calNew_create: "Create",
	calNew_save: "Save",
	calNew_cancel: "Cancel",
    modeSpreadsheet: "📊 Spreadsheet",
    sheetTitle: "📊 Spreadsheet — available in Version 4",
    sheetP1: "The Spreadsheet module will be based on Univer and work fully offline.",
    sheetP2: "Estimated additional package size: ~50 MB.",
    modeWhiteboard: "✏️ Whiteboard / Drawings",
    whiteboardTitle: "✏️ Whiteboard / Drawings",
    whiteboardNew: "New drawing",
    whiteboardSave: "Save",
    whiteboardSaveToast: "Whiteboard saved",
    whiteboardNamePlaceholder: "Drawing name…",
    whiteboardNewConfirmTitle: "New whiteboard",
    whiteboardNewConfirmMsg: "The current whiteboard will be cleared. Make sure you saved it first. Do you really want to start a new whiteboard?",
    whiteboardSaveConfirmTitle: "Save whiteboard",
    whiteboardSaveConfirmMsg: "Are you sure you want to save this whiteboard?",
    whiteboardOverwriteConfirmMsg: "You already have a file with this name in your gallery. Do you really want to overwrite it?",
    whiteboardConfirmYes: "Yes",
    whiteboardConfirmNo: "Cancel",
    openInEditor: "Open in editor",
    modeGames: "🎮 Games ▾",
    gameMinesweeper: "💣 Minesweeper",
    mapsNotReady: "Map not ready.",
    mapsSaveFavoritesError: "Error saving map favorites.",
    wikiNotAvailable: "Wiki not available.",
    agentsLoadError: "⚠️ Could not load agents.",
    mapsOpenError: "⚠️ Could not open location in maps.",
    wikiArticleNotFound: "⚠️ Article not found in offline Wikipedia.",
    agentNotFound: "⚠️ Agent not found.",
    libFilesImported: "file(s) imported."
  },
  es: {
    talkToModel: "💻 Modelo",
    talkToAgents: "👤 Agentes",
    modeWiki: "🏛️ Wikipedia",
    modeMedia:  "📁 Media",
    modeVideo:  "🎬 Video",
    modeMusic:  "🎵 Música",
    modeImages: "🖼️ Imágenes",
	modeFiles:  "📂 Archivos",
	modePortableApps: "🧰 Portable Apps",
	modeSync:   "🔄 Sync",
	modeTrash:  "🗑️ Papelera",	
    modeLibrary:"📖 Librería",
    modeWorld: "🌍 Mundo",
    selectAgent: "Seleccionar agente",
    typing: "escribiendo",
    survivorInit: "¡Hola! Soy tu asistente de conocimiento offline. Pregúntame sobre cualquier tema y te lo explicaré lo mejor que pueda.",
    step1: "Paso 1/2 · Explorar",
    step2: "Paso 2/2 · Revisar perfil",
    allCategories: "Todas",
    startChat: "Iniciar chat con este agente",
    back: "← Volver",
    reset: "🔄️ Reiniciar chat",
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
    skyTitle: "✨ Cielo — disponible en la Versión 4",
    skyP1:    "El módulo Cielo estará basado en d3-Clestial y funcionará completamente offline.",
    skyP2:    "Tamaño estimado del paquete adicional: ~80 MB.",
    skySettingsTitle: "Ajustes del cielo",
    skySettingsBtnLabel: "Abrir ajustes del cielo",
    skyLatLabel: "Latitud (°)",
    skyLonLabel: "Longitud (°)",
    skyDateLabel: "Fecha",
    skyTimeLabel: "Hora",
    skyMagLimitLabel: "Límite de magnitud estelar",
    skyOptionsLegend: "Opciones",
    skyShowConstellations: "Mostrar líneas de constelaciones",
    skyShowConstNames: "Mostrar nombres de constelaciones",
    skyShowGrid: "Mostrar rejilla",
    skyShowHorizon: "Mostrar horizonte",
    skyShowPlanets: "Mostrar Sol, Luna y planetas",
    skySettingsApply: "Aplicar",
    skySettingsCancel: "Cancelar",
    modeMaps: "🗺️ Mapas",
    mapsTitle:"🌍️ Mapas — disponibles en la Versión 2",
	mapsSearchPlaceholder: "Latitud, longitud (ej. 40.4168, -3.7038)",
	mapsSearchBtn: "Ir",
	mapsFavSaveBtn: "Guardar favorito",
	mapsFavTitle: "Favoritos",
	mapsFavEmpty: "Aún no tienes favoritos de mapa.",
	mapsFavGotoTitle: "Ir a este favorito",
	mapsFavDeleteTitle: "Eliminar favorito",
	mapsFavPromptMsg: "Nombre para esta ubicación favorita:",
	mapsInvalidCoords: "No se han podido leer las coordenadas. Usa el formato: lat, lon (por ejemplo 40.4168, -3.7038).",
	mapsFavDeleteConfirmTitle: "Eliminar favorito",
	mapsFavDeleteConfirmMsg: "¿Estás seguro de eliminar “{name}” de tus localizaciones favoritas?",
	mapsFavDeleteConfirmYes: "Eliminar",
	mapsFavDeleteConfirmNo: "Cancelar",
    mapsFavNewFolderBtn: "Nueva carpeta",
    mapsFavRootSection: "Sin carpeta",
    mapsFavFolderLabel: "Carpeta:",
    mapsFolderDialogTitle: "Nueva carpeta de favoritos",
    mapsFolderNameLabel: "Nombre de la carpeta:",
    mapsFolderEmojiLabel: "Elige un icono:",
    mapsFolderCreate: "Crear carpeta",
	mapsFavEditTitle: "Editar favorito",
    mapsFolderEditTitle: "Editar carpeta de favoritos",
    mapsFolderDeleteTitle: "Eliminar carpeta",
    mapsFolderDeleteMsg: "¿Eliminar la carpeta “{name}”? Los favoritos que contenga pasarán a la raíz (sin carpeta).",
    mapsFolderDeleteConfirmYes: "Eliminar",
    mapsFolderDeleteConfirmNo: "Cancelar",
    mapsFolderUnnamed: "Carpeta",
    modeTextDoc: "📄 Documento de texto",
    textDocTitle: "📄 Documentos de texto — disponible en la Versión 4",
    textDocP1: "Esta sección estará basada en Univer y funcionará totalmente sin conexión.",
    textDocP2: "Podrás crear y editar documentos de texto locales con una experiencia similar a Office.",
    modeSupporters: "❤️",
    supportersTitle: "Gracias a nuestros supporters",
    supportersSubtitle: "Ellos ayudan a mantener Survival AI Stick vivo y 100% offline.",
    supportersCta: "¿Quieres apoyar? Añade tu logo en /assets/supporters y tu entrada en supporters.json.",
    modeSupportersTag: "Modo: Supporters",
    noSupporters: "Aún no hay supporters.",
    cat_creators: "Creadores",
    cat_promoters: "Promotores",
    cat_collaborators: "Colaboradores",
    cat_donors: "Donantes",
    cat_funders: "Financiadores",
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
    libDownload: "Descargar",
    libFilterPlaceholder: "Filtrar…",
    libSortName: "Nombre",
    libSortSize: "Tamaño",
    libSortType: "Tipo",
    libUpload: "⬆️ Subir",
    libNewFolder: "📁 Nueva carpeta",
    libNewFolderNameLabel: "Nombre de la carpeta",
    libNewFolderCreate: "Crear carpeta",
    libMkdirError: "Error al crear la carpeta",
    libDropzoneHint: "Arrastra archivos aquí o haz clic para subirlos",
    // 🆕 Bio labels
    lbl_born: "Nacido",
    lbl_birthplace: "Lugar de nacimiento",
    lbl_nationality: "Nacionalidad",
    lbl_bio: "Biografía",
    introModalTitle: "🌐 OFFLINED: La alternativa a Internet",
    introModalBody: `
      <p>🌐 <strong>OFFLINED: La alternativa a Internet</strong><br>
      Un sistema de IA y conocimiento 100% offline. Una alternativa a la web. El conocimiento sobrevive incluso cuando Internet no lo hace.</p>

      <p>🚨 <strong>El problema</strong><br>
      Hoy, 4.000 millones de personas aún no tienen acceso estable a internet.<br>
      Incluso donde existe, es frágil: vulnerable a cortes de luz, censura, desastres o barreras de coste.<br>
      Las herramientas modernas de IA y conocimiento dependen por completo de la nube.<br>
      Cuando la red cae, también lo hace el acceso a educación, medicina, mapas y comunicación.<br>
      El conocimiento humano no debería desaparecer cada vez que se pierde la señal.</p>

      <p>💡 <strong>La solución — OFFLINED</strong><br>
      OFFLINED es una aplicación tipo escritorio que funciona completamente sin conexión.<br>
      Integra un modelo de lenguaje, agentes expertos, Wikipedia, mapas y una biblioteca de documentos — todo en local, sin internet.<br>
      Un entorno de conocimiento inteligente, autosuficiente, para educación, supervivencia y autonomía.</p>

      <p class="intro-modal-slogan">«Cuando la web se apaga, el conocimiento sigue encendido — con OFFLINED.»</p>
    `,
    introModalNeverShowLabel: "No mostrar este mensaje la próxima vez",
    introModalClose: "Cerrar",
    // 🆕 Wiki-trees
    wikiTrees: "🌿 Árboles Wiki",
	talkToEncartha: "🎓 Hablar con Michael Encartha",
    wikiTreesCatalogTitle: "Selecciona un árbol",
    wikiTreesOpen: "Abrir",
    wikiTreesClose: "Cerrar",
    wikiTreesBack: "← Volver al catálogo",
    wikiTreesFilter: "Filtrar…",
    wikiTreesCollapseTitle: "Colapsar/Expandir",
    // 🆕 Wiki-trees extras (ES)
    treeSearchPlaceholder: "Buscar en este árbol…",
    treeSearchBtn: "Buscar",
    expandAllTitle: "Expandir todo",
    collapseAllTitle: "Colapsar todo",
    expandLevel2Title: "Expandir hasta nivel 4",
    toggleViewTitle: "Cambiar vista",
    favoritesTitle: "Favoritos",
    recentsTitle: "Recientes",
    favEmpty: "No hay favoritos todavía.",
    favRemoveTitle: "Quitar de favoritos",
    recentsEmpty: "Sin recientes por ahora.",
    study_notStarted: "Sin empezar",
    study_inProgress: "En progreso",
    study_done: "Completado",
    study_overall: "Progreso",
    ach_first_open: "Primer artículo wiki abierto",
    ach_5_done: "Primeros 5 artículos wiki completados",
    ach_10_percent: "10% del árbol estudiado",
    ach_25_percent: "25% del árbol estudiado",
    ach_50_percent: "50% del árbol estudiado",
    ach_100_percent: "100% del árbol estudiado — ¡genial!",
    ach_unlock_toast: "Logro desbloqueado",
    achievementsTitle: "Logros",
    achievementsEmpty: "Aún no hay logros.",
    achievementsReset: "Reiniciar logros",
    achievementsProgress: "Progreso total",
    resetProgress: "Borrar progreso",
    resetConfirmTitle: "Borrar progreso",
    resetConfirmMsg: "¿Seguro que quieres borrar todo el progreso de “{name}”? Esta acción no se puede deshacer.",
    resetYes: "Borrar",
    resetNo: "Cancelar",
    resetDone: "Progreso y recientes borrados.",
    openStudy: "Abrir y estudiar",
    drilldown: "Entrar al detalle",
    elements: "elementos",
    openStudy: "Abrir y estudiar",
    drilldown: "Entrar al detalle",
    encartha_instr_open: "Clic en <b>🔎</b> para abrir y estudiar el árbol-wiki.",
    encartha_instr_drill: "Clic en <b>➕</b> para bajar al siguiente nivel del árbol (en hojas verás <b>🌐</b> para abrir el artículo).",
    encartha_hint_nav: "Continúa navegando por este wiki-tree a niveles superiores o vuelve a las categorías para seleccionar otro.",
    encartha_backCats: "↩️ Volver a las categorías",
    encartha_backRoot: "⤴️ Volver al primer nivel",
    resumeLabel: "Reanudar",
    err_tree_not_loaded: "⚠️ Árbol no cargado.",
    err_tree_not_loaded_cat: "⚠️ Árbol no cargado en esta categoría.",
    err_node_not_found: "⚠️ Nodo no encontrado.",
    resume_toast: "▶ Reanudando en: {name}" ,
    encartha_intro: "¡Hola! Soy <b>Michael Encartha</b>, tu compañero de estudio de los árboles-wiki. Te ayudaré a profundizar en ellos e iremos juntos marcando el progreso.",
    encartha_cats_title: "Categorías disponibles para el estudio:",
    encartha_hint_open: "Clic en 🔎 para abrir y estudiar el árbol-wiki.",
    encartha_hint_expand: "Clic en ➕ para bajar al siguiente nivel del árbol.",
    encartha_hint_article: "Clic en 🌐 para abrir el articulo del ultimo nivel en la Wikipedia.",
    encartha_hint_resume: "Clic en ▶ para reanudar el estudio donde lo habías dejado.",
    encartha_intro_resume: "Venga, sigamos con el estudio de otra rama de la Wikipedia, elige una nueva categoría.",
    consultWiki: "Consultar en Wikipedia",
    openStudy: "Abrir y estudiar",
    drilldown: "Entrar al detalle",
    modeApps: "➕",
    modeNotes: "🗒️ Bloc de notas",
    notesNew: "Nueva",
    notesDelete: "Borrar",
    notesSave: "Guardar",
    notesUntitled: "Nota sin título",
    notesSearchPlaceholder: "Buscar notas...",
    notesDeleteConfirmTitle: "Borrar nota",
    notesDeleteConfirmMsg: "¿Seguro que quieres borrar la nota «{name}»?",
	modeAudioNotes: "🎙️ Notas de audio",
	audioNew: "Nueva",
	audioDelete: "Borrar",
	audioRecord: "Grabar",
	audioStop: "Detener",
	audioUntitled: "Grabación sin título",
	audioSearchPlaceholder: "Buscar notas de audio...",
	audioFilterNormalize: "Normalizar volumen",
	audioFilterNoise: "Reducir ruido",
	audioFilterHighpass: "Filtro pasa-altas",
	audioNoSupport: "Tu navegador no permite grabar audio.",
	audioDeleteConfirmTitle: "Borrar audio",
	audioDeleteConfirmMsg: "¿Seguro que quieres borrar la nota de audio «{name}»?",
	audioNameRequiredTitle: "Nombre requerido",
	audioNameRequiredMsg: "Antes de grabar, asigna un nombre a la nota de audio.",
	audioOverwriteConfirmTitle: "Sobrescribir audio",
	audioOverwriteConfirmMsg: "Ya existe una nota de audio llamada «{name}». ¿Seguro que quieres sobrescribirla?",
    mediav_prev: "Anterior",
    mediav_next: "Siguiente",
    mediav_close: "Cerrar",
    mediav_cc: "Subtítulos (CC)",
    mediav_viewer: "Visor multimedia",
    mediav_playlist: "Lista de reproducción",
	mediaDelete: "Eliminar",
	mediaDeleteConfirmTitle: "Eliminar elemento",
	mediaDeleteConfirmMsg: "¿Estás seguro de que deseas eliminar \"{name}\"?",
	portableAppsConfirmTitle: "Iniciar app",
	portableAppsConfirmMsg: "¿Quieres iniciar \"{name}\"?",
	portableAppsStart: "Iniciar",
    trashRestore: "Restaurar",
    trashRestoreTitle: "Restaurar elemento",
    trashRestoreConfirmMsg: "¿Quieres restaurar \"{name}\" a su ubicación original?",
    trashDeleteConfirmTitle: "Eliminar definitivamente",
    trashDeleteConfirmMsg: "Esto eliminará \"{name}\" de forma permanente. ¿Continuar?",
    trashRestoreAll: "Restaurar todo",
    trashRestoreAllTitle: "Restaurar todos los elementos",
    trashRestoreAllConfirmMsg: "¿Quieres restaurar {count} elemento(s) de la papelera?",
    trashDeleteAll: "Eliminar todo definitivamente",
    trashDeleteAllTitle: "Eliminar todo definitivamente",
    trashDeleteAllConfirmMsg: "Esto eliminará {count} elemento(s) de la papelera de forma permanente. Esta acción no se puede deshacer. ¿Continuar?",
    syncNoPeers: "No se detectan discos con otras instancias de Offlined conectadas para la transferencia de archivos.",
    syncImportOne: "Importar",
    imgv_viewer: "Visor de imágenes",
    imgv_prev: "Anterior",
    imgv_next: "Siguiente",
    imgv_close: "Cerrar",
    imgv_imagesInFolder: "Imágenes de la carpeta",
    docv_viewer: "Visor de documentos",
    docv_close: "Cerrar",
    modeCalendar: "📅 Calendario",
    calToday: "Hoy",
    calPrev: "Anterior",
    calNext: "Siguiente",
	calMonth: "Mes",
	calWeek:  "Semana",
	calDay:   "Día",
	calList:  "Agenda",
	calMulti: "Varios meses",
	calNew: "Nuevo evento",
	calNew_title: "Nuevo evento",
	calNew_edit: "Editar evento",
	calNew_label_title: "Título",
	calNew_label_date: "Fecha",
	calNew_label_time: "Hora",
	calNew_create: "Crear",
	calNew_save: "Guardar",
	calNew_cancel: "Cancelar",
    modeSpreadsheet: "📊 Hoja de Cálculo",
    sheetTitle: "📊 Hoja de Cálculo — disponible en la Versión 4",
    sheetP1: "El módulo Hoja de Cálculo estará basado en Univer y funcionará completamente offline.",
    sheetP2: "Tamaño estimado del paquete adicional: ~50 MB.",
    modeWhiteboard: "✏️ Pizarra / Dibujos",
    whiteboardTitle: "✏️ Pizarra / Dibujos",
    whiteboardNew: "Nuevo dibujo",
    whiteboardSave: "Guardar",
    whiteboardSaveToast: "Pizarra guardada",
    whiteboardNamePlaceholder: "Nombre del dibujo…",
    whiteboardNewConfirmTitle: "Nueva pizarra",
    whiteboardNewConfirmMsg: "Se va a borrar la pizarra actual. Asegúrate de haber guardado antes. ¿Seguro que quieres empezar una pizarra nueva?",
    whiteboardSaveConfirmTitle: "Guardar pizarra",
    whiteboardSaveConfirmMsg: "¿Seguro que quieres guardar?",
    whiteboardOverwriteConfirmMsg: "Ya tienes un archivo con este nombre guardado en tu galería. ¿Seguro que quieres sobrescribirlo?",
    whiteboardConfirmYes: "Aceptar",
    whiteboardConfirmNo: "Cancelar",
    openInEditor: "Abrir en el editor",
    modeGames: "🎮 Juegos ▾",
    gameMinesweeper: "💣 Buscaminas",
    mapsNotReady: "El mapa no está listo.",
    mapsSaveFavoritesError: "Error al guardar los favoritos del mapa.",
    wikiNotAvailable: "La wiki no está disponible.",
    agentsLoadError: "⚠️ No se pudieron cargar los agentes.",
    mapsOpenError: "⚠️ No se pudo abrir la localización en mapas.",
    wikiArticleNotFound: "⚠️ Artículo no encontrado en Wikipedia offline.",
    agentNotFound: "⚠️ Agente no encontrado.",
    libFilesImported: "archivo(s) importado(s)."
  },
  fr: {
    talkToModel: "💻 Modèle",
    talkToAgents: "👤 Agents",
    modeWiki: "🏛️ Wikipédia",
    modeMedia:  "📁 Médias",
    modeVideo:  "🎬 Vidéo",
    modeMusic:  "🎵 Musique",
    modeImages: "🖼️ Images",
	modeFiles:  "📂 Fichiers",
	modePortableApps: "🧰 Portable Apps",
	modeSync:   "🔄 Sync",
	modeTrash:  "🗑️ Corbeille",
    modeLibrary: "📖 Bibliothèque",
    modeWorld: "🌍 Monde",
    selectAgent: "Choisir un agent",
    typing: "saisie en cours",
    survivorInit: "Bonjour ! Je suis ton assistant de connaissance hors ligne. Pose-moi une question sur n’importe quel sujet et je te l’expliquerai du mieux que je peux.",
    step1: "Étape 1/2 · Parcourir",
    step2: "Étape 2/2 · Fiche",
    allCategories: "Toutes",
    startChat: "Démarrer le chat avec cet agent",
    back: "← Retour",
    reset: "🔄️ Réinitialiser le chat",
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
    skyTitle: "✨ Ciel — disponible dans la Version 4",
    skyP1:    "Le module Ciel s’appuiera sur d3-Clestial et fonctionnera entièrement hors ligne.",
    skyP2:    "Taille estimée du pack additionnel : ~80 Mo.",
    skySettingsTitle: "Paramètres du ciel",
    skySettingsBtnLabel: "Ouvrir les paramètres du ciel",
    skyLatLabel: "Latitude (°)",
    skyLonLabel: "Longitude (°)",
    skyDateLabel: "Date",
    skyTimeLabel: "Heure",
    skyMagLimitLabel: "Limite de magnitude des étoiles",
    skyOptionsLegend: "Options",
    skyShowConstellations: "Afficher les lignes des constellations",
    skyShowConstNames: "Afficher les noms des constellations",
    skyShowGrid: "Afficher la grille",
    skyShowHorizon: "Afficher l’horizon",
    skyShowPlanets: "Afficher Soleil, Lune et planètes",
    skySettingsApply: "Appliquer",
    skySettingsCancel: "Annuler",
    modeMaps: "🗺️ Cartes",
    mapsTitle:"🌍️ Cartes — disponibles dans la Version 2",
	mapsSearchPlaceholder: "Lat., lon. (ex. 48.8566, 2.3522)",
	mapsSearchBtn: "Aller",
	mapsFavSaveBtn: "Enregistrer favori",
	mapsFavTitle: "Favoris",
	mapsFavEmpty: "Aucun favori de carte pour l’instant.",
	mapsFavGotoTitle: "Aller à ce favori",
	mapsFavDeleteTitle: "Supprimer le favori",
	mapsFavPromptMsg: "Nom pour cet emplacement favori :",
	mapsInvalidCoords: "Impossible de lire les coordonnées. Utilisez le format : lat, lon (par ex. 48.8566, 2.3522).",
	mapsFavDeleteConfirmTitle: "Supprimer le favori",
	mapsFavDeleteConfirmMsg: "Êtes-vous sûr de vouloir supprimer « {name} » de vos emplacements favoris ?",
	mapsFavDeleteConfirmYes: "Supprimer",
	mapsFavDeleteConfirmNo: "Annuler",
    mapsFavNewFolderBtn: "Nouveau dossier",
    mapsFavRootSection: "Sans dossier",
    mapsFavFolderLabel: "Dossier :",
    mapsFolderDialogTitle: "Nouveau dossier de favoris",
    mapsFolderNameLabel: "Nom du dossier :",
    mapsFolderEmojiLabel: "Choisissez une icône :",
    mapsFolderCreate: "Créer le dossier",
	mapsFavEditTitle: "Modifier le favori",
    mapsFolderEditTitle: "Modifier le dossier de favoris",
    mapsFolderDeleteTitle: "Supprimer le dossier",
    mapsFolderDeleteMsg: "Supprimer le dossier « {name} » ? Les favoris qu’il contient seront déplacés vers la racine (sans dossier).",
    mapsFolderDeleteConfirmYes: "Supprimer",
    mapsFolderDeleteConfirmNo: "Annuler",
    mapsFolderUnnamed: "Dossier",
    modeTextDoc: "📄 Document texte",
    textDocTitle: "📄 Documents texte — disponible dans la Version 4",
    textDocP1: "Cette section sera basée sur Univer et fonctionnera entièrement hors-ligne.",
    textDocP2: "Vous pourrez créer et modifier des documents texte locaux avec une expérience proche d’Office.",
    modeSupporters: "❤️",
    supportersTitle: "Merci à nos soutiens",
    supportersSubtitle: "Ils permettent à Survival AI Stick de rester vivant et 100 % hors ligne.",
    supportersCta: "Vous voulez soutenir ? Ajoutez votre logo dans /assets/supporters et une entrée dans supporters.json.",
    modeSupportersTag: "Mode : Soutiens",
    noSupporters: "Pas encore de soutiens.",
    cat_creators: "Créateurs",
    cat_promoters: "Promoteurs",
    cat_collaborators: "Collaborateurs",
    cat_donors: "Donateurs",
    cat_funders: "Financeurs",
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
    libDownload: "Télécharger",
    libFilterPlaceholder: "Filtrer…",
    libSortName: "Nom",
    libSortSize: "Taille",
    libSortType: "Type",
    libUpload: "⬆️ Importer",
    libNewFolder: "📁 Nouveau dossier",
	libNewFolderNameLabel: "Nom du dossier",
	libNewFolderCreate: "Créer le dossier",
	libMkdirError: "Erreur lors de la création du dossier",
    libDropzoneHint: "Déposez des fichiers ici ou cliquez pour les importer",
    // 🆕 Bio labels
    lbl_born: "Né",
    lbl_birthplace: "Lieu de naissance",
    lbl_nationality: "Nationalité",
    lbl_bio: "Biographie",
    introModalTitle: "🌐 OFFLINED : L’alternative à Internet",
    introModalBody: `
      <p>🌐 <strong>OFFLINED : L’alternative à Internet</strong><br>
      Un système d’IA et de connaissance 100 % hors ligne. Une alternative au web. Le savoir survit même quand Internet s’éteint.</p>

      <p>🚨 <strong>Le problème</strong><br>
      Aujourd’hui, 4 milliards de personnes n’ont toujours pas un accès fiable à internet.<br>
      Même là où il existe, il reste fragile — vulnérable aux coupures de courant, à la censure, aux catastrophes ou au coût.<br>
      Les outils modernes d’IA et de connaissance dépendent entièrement du cloud.<br>
      Quand le réseau tombe, l’accès à l’éducation, à la médecine, aux cartes et à la communication disparaît aussi.<br>
      Le savoir humain ne devrait pas disparaître dès que le signal est perdu.</p>

      <p>💡 <strong>La solution — OFFLINED</strong><br>
      OFFLINED est une application de type bureau qui fonctionne entièrement hors ligne.<br>
      Elle intègre un modèle de langage, des agents experts, Wikipédia, des cartes et une bibliothèque de documents — tout en local, sans internet.<br>
      Un environnement de connaissance intelligent et autonome pour l’éducation, la survie et l’autonomie.</p>

      <p class="intro-modal-slogan">« Quand le web s’éteint, le savoir reste en ligne — avec OFFLINED. »</p>
    `,
    introModalNeverShowLabel: "Ne plus afficher ce message",
    introModalClose: "Fermer",
    // 🆕 Wiki-trees
    wikiTrees: "🌿 Arbres Wiki",
	talkToEncartha: "🎓 Parler avec Michael Encartha",
    wikiTreesCatalogTitle: "Sélectionnez un arbre",
    wikiTreesOpen: "Ouvrir",
    wikiTreesClose: "Fermer",
    wikiTreesBack: "← Retour au catalogue",
    wikiTreesFilter: "Filtrer…",
    wikiTreesCollapseTitle: "Réduire/Agrandir",
    // 🆕 Wiki-trees extras (FR)
    treeSearchPlaceholder: "Rechercher dans cet arbre…",
    treeSearchBtn: "Rechercher",
    expandAllTitle: "Tout développer",
    collapseAllTitle: "Tout réduire",
    expandLevel2Title: "Développer jusqu’au niveau 4",
    toggleViewTitle: "Basculer la vue",
    favoritesTitle: "Favoris",
    recentsTitle: "Récents",
    favEmpty: "Pas encore de favoris.",
    favRemoveTitle: "Retirer des favoris",
    recentsEmpty: "Pas encore d’éléments récents.",
    study_notStarted: "Non commencé",
    study_inProgress: "En cours",
    study_done: "Terminé",
    study_overall: "Avancement",
    ach_first_open: "Premier article wiki ouvert",
    ach_5_done: "5 premiers articles wiki terminés",
    ach_10_percent: "10 % de l’arbre étudié",
    ach_25_percent: "25 % de l’arbre étudié",
    ach_50_percent: "50 % de l’arbre étudié",
    ach_100_percent: "100 % de l’arbre étudié — bravo !",
    ach_unlock_toast: "Succès débloqué",
    achievementsTitle: "Succès",
    achievementsEmpty: "Aucun succès pour l’instant.",
    achievementsReset: "Réinitialiser les succès",
    achievementsProgress: "Progression globale",
    resetProgress: "Réinitialiser la progression",
    resetConfirmTitle: "Réinitialiser la progression",
    resetConfirmMsg: "Voulez-vous vraiment supprimer toute la progression pour « {name} » ? Cette action est irréversible.",
    resetYes: "Supprimer",
    resetNo: "Annuler",
    resetDone: "Progression et récents supprimés.",
    openStudy: "Ouvrir et étudier",
    drilldown: "Entrer dans le détail",
    elements: "éléments",
    openStudy: "Ouvrir et étudier",
    drilldown: "Approfondir",
    encartha_instr_open: "Cliquez sur <b>🔎</b> pour ouvrir et étudier l’arbre-wiki.",
    encartha_instr_drill: "Cliquez sur <b>➕</b> pour descendre d’un niveau (sur une feuille vous verrez <b>🌐</b> pour ouvrir l’article).",
    encartha_hint_nav: "Continuez à naviguer dans cet arbre-wiki aux niveaux supérieurs ou revenez aux catégories pour en choisir un autre.",
    encartha_backCats: "↩️ Revenir aux catégories",
    encartha_backRoot: "⤴️ Revenir à la racine",
    resumeLabel: "Reprendre",
    err_tree_not_loaded: "⚠️ Arbre non chargé.",
    err_tree_not_loaded_cat: "⚠️ Arbre non chargé dans cette catégorie.",
    err_node_not_found: "⚠️ Nœud introuvable.",
    resume_toast: "▶ Reprise sur : {name}",
    encartha_intro: "Bonjour ! Je suis <b>Michael Encartha</b>, ton compagnon d’étude des arbres-wiki. Je t’aiderai à les explorer en profondeur et nous suivrons tes progrès ensemble.",
    encartha_cats_title: "Catégories disponibles pour l’étude :",
    encartha_hint_open: "Cliquez sur 🔎 pour ouvrir et étudier l’arbre-wiki.",
    encartha_hint_expand: "Cliquez sur ➕ pour descendre au niveau suivant de l’arbre.",
    encartha_hint_article: "Cliquez sur 🌐 pour ouvrir l’article du dernier niveau sur Wikipédia.",
    encartha_hint_resume: "Cliquez sur ▶ pour reprendre l’étude là où vous l’aviez laissée.",
    encartha_intro_resume: "Allez, continuons l’étude d’une autre branche de Wikipédia : choisissez une nouvelle catégorie.",
    consultWiki: "Consulter dans Wikipédia",
    openStudy: "Ouvrir et étudier",
    drilldown: "Approfondir",
    modeApps: "➕",
    modeNotes: "🗒️ Bloc-notes",
    notesNew: "Nouveau",
    notesDelete: "Supprimer",
    notesSave: "Enregistrer",
    notesUntitled: "Sans titre",
	notesSearchPlaceholder: "Rechercher des notes...",
    notesDeleteConfirmTitle: "Supprimer la note",
    notesDeleteConfirmMsg: "Voulez-vous vraiment supprimer la note « {name} » ?",
	modeAudioNotes: "🎙️ Notes audio",
	audioNew: "Nouvelle",
	audioDelete: "Supprimer",
	audioRecord: "Enregistrer",
	audioStop: "Arrêter",
	audioUntitled: "Enregistrement sans titre",
	audioSearchPlaceholder: "Rechercher des notes audio...",
	audioFilterNormalize: "Normaliser le volume",
	audioFilterNoise: "Réduction du bruit",
	audioFilterHighpass: "Filtre passe-haut",
	audioNoSupport: "Votre navigateur ne permet pas d’enregistrer de l’audio.",
	audioDeleteConfirmTitle: "Supprimer l’audio",
	audioDeleteConfirmMsg: "Êtes-vous sûr de vouloir supprimer la note audio « {name} » ?",
	audioNameRequiredTitle: "Nom requis",
	audioNameRequiredMsg: "Avant d’enregistrer, donnez un nom à la note audio.",
	audioOverwriteConfirmTitle: "Écraser l’audio",
	audioOverwriteConfirmMsg: "Une note audio nommée « {name} » existe déjà. Voulez-vous vraiment l’écraser ?",
    mediav_prev: "Précédent",
    mediav_next: "Suivant",
    mediav_close: "Fermer",
    mediav_cc: "Sous-titres (CC)",
    mediav_viewer: "Lecteur média",
    mediav_playlist: "Liste de lecture",
	mediaDelete: "Supprimer",
	mediaDeleteConfirmTitle: "Supprimer l’élément",
	mediaDeleteConfirmMsg: "Êtes-vous sûr de vouloir supprimer « {name} » ?",
	portableAppsConfirmTitle: "Lancer l’app",
	portableAppsConfirmMsg: "Voulez-vous lancer \"{name}\" ?",
	portableAppsStart: "Lancer",
    trashRestore: "Restaurer",
    trashRestoreTitle: "Restaurer l’élément",
    trashRestoreConfirmMsg: "Voulez-vous restaurer « {name} » à son emplacement d’origine ?",
    trashDeleteConfirmTitle: "Supprimer définitivement",
    trashDeleteConfirmMsg: "Cela supprimera définitivement « {name} ». Continuer ?",
    trashRestoreAll: "Tout restaurer",
    trashRestoreAllTitle: "Restaurer tous les éléments",
    trashRestoreAllConfirmMsg: "Voulez-vous restaurer {count} élément(s) de la corbeille ?",
    trashDeleteAll: "Tout supprimer définitivement",
    trashDeleteAllTitle: "Tout supprimer définitivement",
    trashDeleteAllConfirmMsg: "Cela va supprimer définitivement {count} élément(s) de la corbeille. Cette action est irréversible. Continuer ?",
    syncNoPeers: "Aucune autre instance d’Offlined détectée sur les disques externes pour le transfert de fichiers.",
    syncImportOne: "Importer",
    imgv_viewer: "Visionneuse d’images",
    imgv_prev: "Précédent",
    imgv_next: "Suivant",
    imgv_close: "Fermer",
    imgv_imagesInFolder: "Images du dossier",
    docv_viewer: "Visionneuse de documents",
    docv_close: "Fermer",
    modeCalendar: "📅 Calendrier",
    calToday: "Aujourd’hui",
    calPrev: "Précédent",
    calNext: "Suivant",
	calMonth: "Mois",
	calWeek:  "Semaine",
	calDay:   "Jour",
	calList:  "Agenda",
	calMulti: "Pluri-mois",
	calNew: "Nouvel événement",
	calNew_title: "Nouvel événement",
	calNew_edit: "Modifier l’événement",
	calNew_label_title: "Titre",
	calNew_label_date: "Date",
	calNew_label_time: "Heure",
	calNew_create: "Créer",
	calNew_save: "Enregistrer",
	calNew_cancel: "Annuler",
    modeSpreadsheet: "📊 Feuille de calcul",
    sheetTitle: "📊 Feuille de calcul — disponible dans la Version 4",
    sheetP1: "Le module Feuille de calcul sera basé sur Univer et fonctionnera entièrement hors ligne.",
    sheetP2: "Taille estimée du module additionnel : ~50 Mo.",
    modeWhiteboard: "✏️ Tableau / Dessins",
    whiteboardTitle: "✏️ Tableau / Dessins",
    whiteboardNew: "Nouveau dessin",
    whiteboardSave: "Enregistrer",
    whiteboardSaveToast: "Tableau enregistré",
    whiteboardNamePlaceholder: "Nom du dessin…",
    whiteboardNewConfirmTitle: "Nouveau tableau",
    whiteboardNewConfirmMsg: "Le tableau actuel va être effacé. Assurez-vous de l’avoir enregistré avant. Voulez-vous vraiment commencer un nouveau tableau ?",
    whiteboardSaveConfirmTitle: "Enregistrer le tableau",
    whiteboardSaveConfirmMsg: "Êtes-vous sûr de vouloir enregistrer ce tableau ?",
    whiteboardOverwriteConfirmMsg: "Vous avez déjà un fichier portant ce nom dans votre galerie. Voulez-vous vraiment l’écraser ?",
    whiteboardConfirmYes: "Oui",
    whiteboardConfirmNo: "Annuler",
    openInEditor: "Ouvrir dans l’éditeur",
    modeGames: "🎮 Jeux ▾",
    gameMinesweeper: "💣 Démineur",
    mapsNotReady: "La carte n’est pas prête.",
    mapsSaveFavoritesError: "Erreur lors de l’enregistrement des favoris de la carte.",
    wikiNotAvailable: "Le wiki n’est pas disponible.",
    agentsLoadError: "⚠️ Impossible de charger les agents.",
    mapsOpenError: "⚠️ Impossible d’ouvrir l’emplacement dans les cartes.",
    wikiArticleNotFound: "⚠️ Article introuvable dans la Wikipédia hors ligne.",
    agentNotFound: "⚠️ Agent introuvable.",
    libFilesImported: "fichier(s) importé(s)."
  },
  pt: {
    talkToModel: "💻 Modelo",
    talkToAgents: "👤 Agentes",
    modeWiki: "🏛️ Wikipédia",
    modeMedia:  "📁 Media",
    modeVideo:  "🎬 Vídeo",
    modeMusic:  "🎵 Música",
    modeImages: "🖼️ Imagens",
	modeFiles:  "📂 Arquivos",
	modePortableApps: "🧰 Portable Apps",
	modeSync:   "🔄 Sync",
	modeTrash:  "🗑️ Lixeira",
    modeLibrary:"📖 Biblioteca",
    modeWorld: "🌍 Mundo",
    selectAgent: "Selecionar agente",
    typing: "digitando",
    survivorInit: "Olá! Sou o seu assistente de conhecimento offline. Pergunte sobre qualquer assunto e vou explicar o melhor que puder.",
    step1: "Passo 1/2 · Explorar",
    step2: "Passo 2/2 · Rever perfil",
    allCategories: "Todas",
    startChat: "Iniciar chat com este agente",
    back: "← Voltar",
    reset: "🔄️ Reiniciar chat",
    modeToggle: "🌓 Modo",
    chatWithModel: "Conversar com o Modelo",
    survivorDetected: "**Sobrevivente detectado.** 🧰<br>Este sistema está a funcionar offline. A internet e os serviços governamentais já não estão disponíveis.<br>Pode perguntar-me o que quiser para ajudar a sobreviver. Ou selecione um agente especializado para o orientar.",
    modeModel: "Modo: Modelo",
    modeAgents: "Modo: Agentes",
    send: "Enviar",
    talkWithName: "Falar com {name}",
    agentLabel: "Agente",
    modelLabel: "Modelo",
    professionLabel: "Profissão",
    modelOnly: "Apenas modelo",
    relatedArticlesTitle: "Artigos relacionados",
    searchInWikipedia: "Pesquisar na Wikipédia",
    modeSky:  "🌙 Céu",
    skyTitle: "✨ Céu — disponível na Versão 4",
    skyP1:    "O módulo Céu usará o d3-Clestial e funcionará totalmente offline.",
    skyP2:    "Tamanho estimado do pacote adicional: ~80 MB.",
    skySettingsTitle: "Definições do céu",
    skySettingsBtnLabel: "Abrir definições do céu",
    skyLatLabel: "Latitude (°)",
    skyLonLabel: "Longitude (°)",
    skyDateLabel: "Data",
    skyTimeLabel: "Hora",
    skyMagLimitLabel: "Limite de magnitude das estrelas",
    skyOptionsLegend: "Opções",
    skyShowConstellations: "Mostrar linhas das constelações",
    skyShowConstNames: "Mostrar nomes das constelações",
    skyShowGrid: "Mostrar grelha",
    skyShowHorizon: "Mostrar horizonte",
    skyShowPlanets: "Mostrar Sol, Lua e planetas",
    skySettingsApply: "Aplicar",
    skySettingsCancel: "Cancelar",
    modeMaps: "🗺️ Mapas",
    mapsTitle:"🌍️ Mapas — disponíveis na Versão 2",
	mapsSearchPlaceholder: "Lat., lon. (ex. -23.5505, -46.6333)",
	mapsSearchBtn: "Ir",
	mapsFavSaveBtn: "Guardar favorito",
	mapsFavTitle: "Favoritos",
	mapsFavEmpty: "Ainda não há favoritos de mapa.",
	mapsFavGotoTitle: "Ir para este favorito",
	mapsFavDeleteTitle: "Remover favorito",
	mapsFavPromptMsg: "Nome para este local favorito:",
	mapsInvalidCoords: "Não foi possível ler as coordenadas. Use o formato: lat, lon (ex.: -23.5505, -46.6333).",
	mapsFavDeleteConfirmTitle: "Eliminar favorito",
	mapsFavDeleteConfirmMsg: "Tem certeza de que deseja eliminar “{name}” das suas localizações favoritas?",
	mapsFavDeleteConfirmYes: "Eliminar",
	mapsFavDeleteConfirmNo: "Cancelar",
    mapsFavNewFolderBtn: "Nova pasta",
    mapsFavRootSection: "Sem pasta",
    mapsFavFolderLabel: "Pasta:",
    mapsFolderDialogTitle: "Nova pasta de favoritos",
    mapsFolderNameLabel: "Nome da pasta:",
    mapsFolderEmojiLabel: "Escolha um ícone:",
    mapsFolderCreate: "Criar pasta",
	mapsFavEditTitle: "Editar favorito",
    mapsFolderEditTitle: "Editar pasta de favoritos",
    mapsFolderDeleteTitle: "Eliminar pasta",
    mapsFolderDeleteMsg: "Eliminar a pasta \"{name}\"? Os favoritos dentro dela serão movidos para a raiz (sem pasta).",
    mapsFolderDeleteConfirmYes: "Eliminar",
    mapsFolderDeleteConfirmNo: "Cancelar",
    mapsFolderUnnamed: "Pasta",
    modeTextDoc: "📄 Documento de texto",
    textDocTitle: "📄 Documentos de texto — disponível na Versão 4",
    textDocP1: "Esta secção será baseada no Univer e funcionará totalmente offline.",
    textDocP2: "Poderá criar e editar documentos de texto locais com uma experiência semelhante ao Office.",
    modeSupporters: "❤️",
    supportersTitle: "Obrigado aos nossos apoiadores",
    supportersSubtitle: "Eles ajudam a manter o Survival AI Stick vivo e 100% offline.",
    supportersCta: "Quer apoiar? Adicione o seu logótipo em /assets/supporters e a sua entrada em supporters.json.",
    modeSupportersTag: "Modo: Apoiadores",
    noSupporters: "Ainda não há apoiadores.",
    cat_creators: "Criadores",
    cat_promoters: "Promotores",
    cat_collaborators: "Colaboradores",
    cat_donors: "Doadores",
    cat_funders: "Financiadores",
    categoryLabel: "Categoria",
    noArticleFound: "Nenhum artigo encontrado",
    agentsNeutralTitle: "Agentes",
    // 🆕 referrals
    suggestedAgentsTitle: "Agentes sugeridos",
    // 📚 Library
    libModeTag: "Modo: Biblioteca",
    libUp: "Acima",
    libEmpty: "Pasta vazia",
    libView: "Ver",
    libDownload: "Baixar",
    libFilterPlaceholder: "Filtrar…",
    libSortName: "Nome",
    libSortSize: "Tamanho",
    libSortType: "Tipo",
    libUpload: "⬆️ Enviar",
    libNewFolder: "📁 Nova pasta",
	libNewFolderNameLabel: "Nome da pasta",
	libNewFolderCreate: "Criar pasta",
	libMkdirError: "Erro ao criar a pasta",
    libDropzoneHint: "Solte arquivos aqui ou clique para enviar",
    // 🆕 Bio labels
    lbl_born: "Nascimento",
    lbl_birthplace: "Local de nascimento",
    lbl_nationality: "Nacionalidade",
    lbl_bio: "Biografia",
    introModalTitle: "🌐 OFFLINED: A alternativa à Internet",
    introModalBody: `
      <p>🌐 <strong>OFFLINED: A alternativa à Internet</strong><br>
      Um sistema de IA e conhecimento 100 % offline. Uma alternativa à web. O conhecimento sobrevive mesmo quando a internet não funciona.</p>

      <p>🚨 <strong>O problema</strong><br>
      Hoje, 4 mil milhões de pessoas ainda não têm acesso fiável à internet.<br>
      Mesmo onde existe, é frágil — vulnerável a falhas de energia, censura, desastres ou barreiras de custo.<br>
      As ferramentas modernas de IA e de conhecimento dependem totalmente da nuvem.<br>
      Quando a rede cai, também cai o acesso à educação, à medicina, aos mapas e à comunicação.<br>
      O conhecimento humano não deveria desaparecer sempre que o sinal falha.</p>

      <p>💡 <strong>A solução — OFFLINED</strong><br>
      OFFLINED é uma aplicação estilo desktop que funciona completamente offline.<br>
      Integra um modelo de linguagem, agentes especializados, Wikipédia, mapas e uma biblioteca de documentos — tudo localmente, sem internet.<br>
      Um ambiente de conhecimento inteligente e autónomo para educação, sobrevivência e autonomia.</p>

      <p class="intro-modal-slogan">« Quando a web se apaga, o conhecimento continua ligado — com OFFLINED. »</p>
    `,
    introModalNeverShowLabel: "Não mostrar esta mensagem da próxima vez",
    introModalClose: "Fechar",
    // 🆕 Wiki-trees
    wikiTrees: "🌿 Árvores Wiki",
	talkToEncartha: "🎓 Falar com Michael Encartha",
    wikiTreesCatalogTitle: "Selecione uma árvore",
    wikiTreesOpen: "Abrir",
    wikiTreesClose: "Fechar",
    wikiTreesBack: "← Voltar ao catálogo",
    wikiTreesFilter: "Filtrar…",
    wikiTreesCollapseTitle: "Recolher/Expandir",
    // 🆕 Wiki-trees extras (PT)
    treeSearchPlaceholder: "Pesquisar nesta árvore…",
    treeSearchBtn: "Pesquisar",
    expandAllTitle: "Expandir tudo",
    collapseAllTitle: "Recolher tudo",
    expandLevel2Title: "Expandir até ao nível 4",
    toggleViewTitle: "Alternar vista",
    favoritesTitle: "Favoritos",
    recentsTitle: "Recentes",
    favEmpty: "Ainda sem favoritos.",
    favRemoveTitle: "Remover dos favoritos",
    recentsEmpty: "Ainda sem recentes.",
    study_notStarted: "Não iniciado",
    study_inProgress: "Em curso",
    study_done: "Concluído",
    study_overall: "Geral",
    ach_first_open: "Primeiro artigo wiki aberto",
    ach_5_done: "Primeiros 5 artigos wiki concluídos",
    ach_10_percent: "10% da árvore estudada",
    ach_25_percent: "25% da árvore estudada",
    ach_50_percent: "50% da árvore estudada",
    ach_100_percent: "100% da árvore estudada — excelente!",
    ach_unlock_toast: "Conquista desbloqueada",
    achievementsTitle: "Conquistas",
    achievementsEmpty: "Ainda sem conquistas.",
    achievementsReset: "Repor conquistas",
    achievementsProgress: "Progresso geral",
    resetProgress: "Repor progresso",
    resetConfirmTitle: "Repor progresso",
    resetConfirmMsg: "Tem a certeza de que pretende eliminar todo o progresso de “{name}”? Isto não pode ser desfeito.",
    resetYes: "Eliminar",
    resetNo: "Cancelar",
    resetDone: "Progresso e recentes apagados.",
    openStudy: "Abrir e estudar",
    drilldown: "Aprofundar",
    elements: "elementos",
    openStudy: "Abrir e estudar",
    drilldown: "Aprofundar",
    encartha_instr_open: "Clique em <b>🔎</b> para abrir e estudar a árvore-wiki.",
    encartha_instr_drill: "Clique em <b>➕</b> para descer um nível (nas folhas verá <b>🌐</b> para abrir o artigo).",
    encartha_hint_nav: "Continue a navegar nesta árvore-wiki em níveis superiores ou volte às categorias para escolher outra.",
    encartha_backCats: "↩️ Voltar às categorias",
    encartha_backRoot: "⤴️ Voltar à raiz",
    resumeLabel: "Retomar",
    err_tree_not_loaded: "⚠️ Árvore não carregada.",
    err_tree_not_loaded_cat: "⚠️ Árvore não carregada nesta categoria.",
    err_node_not_found: "⚠️ Nó não encontrado.",
    resume_toast: "▶ A retomar em: {name}",
    encartha_intro: "Olá! Sou o <b>Michael Encartha</b>, o seu companheiro de estudo das árvores-wiki. Vou ajudá-lo a explorá-las em profundidade e a acompanhar o seu progresso.",
    encartha_cats_title: "Categorias disponíveis para estudo:",
    encartha_hint_open: "Clique em 🔎 para abrir e estudar a árvore-wiki.",
    encartha_hint_expand: "Clique em ➕ para descer para o nível seguinte da árvore.",
    encartha_hint_article: "Clique em 🌐 para abrir o artigo do nível final na Wikipédia.",
    encartha_hint_resume: "Clique em ▶ para retomar o estudo onde ficou.",
    encartha_intro_resume: "Vamos continuar a estudar outro ramo da Wikipédia — escolha uma nova categoria.",
    consultWiki: "Ver na Wikipédia",
    openStudy: "Abrir e estudar",
    drilldown: "Aprofundar",
    modeApps: "➕",
    modeNotes: "🗒️ Bloco de notas",
    notesNew: "Nova",
    notesDelete: "Eliminar",
    notesSave: "Guardar",
    notesUntitled: "Nota sem título",
	notesSearchPlaceholder: "Pesquisar notas...",
    notesDeleteConfirmTitle: "Eliminar nota",
    notesDeleteConfirmMsg: "Tem a certeza de que quer eliminar a nota «{name}»?",
	modeAudioNotes: "🎙️ Notas de áudio",
	audioNew: "Nova",
	audioDelete: "Apagar",
	audioRecord: "Gravar",
	audioStop: "Parar",
	audioUntitled: "Gravação sem título",
	audioSearchPlaceholder: "Procurar notas de áudio...",
	audioFilterNormalize: "Normalizar volume",
	audioFilterNoise: "Reduzir ruído",
	audioFilterHighpass: "Filtro passa-alto",
	audioNoSupport: "O seu navegador não permite gravar áudio.",
	audioDeleteConfirmTitle: "Apagar áudio",
	audioDeleteConfirmMsg: "Tem a certeza de que pretende apagar a nota de áudio «{name}»?",
	audioNameRequiredTitle: "Nome obrigatório",
	audioNameRequiredMsg: "Antes de gravar, atribua um nome à nota de áudio.",
	audioOverwriteConfirmTitle: "Substituir áudio",
    audioOverwriteConfirmMsg: "Já existe uma nota de áudio chamada «{name}». Deseja substituí-la?",
    mediav_prev: "Anterior",
    mediav_next: "Seguinte",
    mediav_close: "Fechar",
    mediav_cc: "Legendas (CC)",
    mediav_viewer: "Visualizador de mídia",
    mediav_playlist: "Lista de reprodução",
	mediaDelete: "Eliminar",
	mediaDeleteConfirmTitle: "Eliminar item",
	mediaDeleteConfirmMsg: "Tem certeza de que deseja eliminar \"{name}\"?",
	portableAppsConfirmTitle: "Iniciar app",
	portableAppsConfirmMsg: "Deseja iniciar \"{name}\"?",
	portableAppsStart: "Iniciar",
    trashRestore: "Restaurar",
    trashRestoreTitle: "Restaurar item",
    trashRestoreConfirmMsg: "Deseja restaurar \"{name}\" para o seu local original?",
    trashDeleteConfirmTitle: "Eliminar permanentemente",
    trashDeleteConfirmMsg: "Isto irá eliminar \"{name}\" de forma permanente. Continuar?",
    trashRestoreAll: "Restaurar tudo",
    trashRestoreAllTitle: "Restaurar todos os itens",
    trashRestoreAllConfirmMsg: "Deseja restaurar {count} item(ns) da lixeira?",
    trashDeleteAll: "Eliminar tudo definitivamente",
    trashDeleteAllTitle: "Eliminar tudo definitivamente",
    trashDeleteAllConfirmMsg: "Isto irá eliminar permanentemente {count} item(ns) da lixeira. Esta ação não pode ser anulada. Continuar?",
    syncNoPeers: "Nenhuma outra instância do Offlined detectada em discos externos para transferência de arquivos.",
    syncImportOne: "Importar",
    imgv_viewer: "Visualizador de imagens",
    imgv_prev: "Anterior",
    imgv_next: "Seguinte",
    imgv_close: "Fechar",
    imgv_imagesInFolder: "Imagens na pasta",
    docv_viewer: "Visualizador de documentos",
    docv_close: "Fechar",
    modeCalendar: "📅 Calendário",
    calToday: "Hoje",
    calPrev: "Anterior",
    calNext: "Seguinte",
	calMonth: "Mês",
	calWeek:  "Semana",
	calDay:   "Dia",
	calList:  "Agenda",
	calMulti: "Vários meses",
	calNew: "Novo evento",
	calNew_title: "Novo evento",
	calNew_edit: "Editar evento",
	calNew_label_title: "Título",
	calNew_label_date: "Data",
	calNew_label_time: "Hora",
	calNew_create: "Criar",
	calNew_save: "Guardar",
	calNew_cancel: "Cancelar",
    modeSpreadsheet: "📊 Folha de cálculo",
    sheetTitle: "📊 Folha de cálculo — disponível na Versão 4",
    sheetP1: "O módulo Folha de cálculo será baseado em Univer e funcionará totalmente offline.",
    sheetP2: "Tamanho estimado do pacote adicional: ~50 MB.",
    modeWhiteboard: "✏️ Quadro / Desenhos",
    whiteboardTitle: "✏️ Quadro / Desenhos",
    whiteboardNew: "Novo desenho",
    whiteboardSave: "Guardar",
    whiteboardSaveToast: "Quadro guardado",
    whiteboardNamePlaceholder: "Nome do desenho…",
    whiteboardNewConfirmTitle: "Novo quadro",
    whiteboardNewConfirmMsg: "O quadro atual será apagado. Certifique-se de que o guardou antes. Tem a certeza de que quer começar um novo quadro?",
    whiteboardSaveConfirmTitle: "Guardar quadro",
    whiteboardSaveConfirmMsg: "Tem a certeza de que quer guardar este quadro?",
    whiteboardOverwriteConfirmMsg: "Já tem um ficheiro com este nome na sua galeria. Tem a certeza de que o quer substituir?",
    whiteboardConfirmYes: "Sim",
    whiteboardConfirmNo: "Cancelar",
    openInEditor: "Abrir no editor",
    modeGames: "🎮 Jogos ▾",
    gameMinesweeper: "💣 Campo minado",
    mapsNotReady: "O mapa ainda não está pronto.",
    mapsSaveFavoritesError: "Erro ao guardar os favoritos do mapa.",
    wikiNotAvailable: "A wiki não está disponível.",
    agentsLoadError: "⚠️ Não foi possível carregar os agentes.",
    mapsOpenError: "⚠️ Não foi possível abrir a localização nos mapas.",
    wikiArticleNotFound: "⚠️ Artigo não encontrado na Wikipédia offline.",
    agentNotFound: "⚠️ Agente não encontrado.",
    libFilesImported: "ficheiro(s) importado(s)."
  }
}


// ===== Aplicar etiquetas traducidas a los visores =====
function i18nApplyViewersLabels(){
  // MEDIA
  const mv = document.getElementById("mediaViewer");
  if (mv){
    mv.querySelector(".mediav-dialog")?.setAttribute("aria-label", t("mediav_viewer"));
    const btnPrev  = mv.querySelector("[data-mediav-prev]");
    const btnNext  = mv.querySelector("[data-mediav-next]");
    const btnClose = mv.querySelector("[data-mediav-close]");
    const btnCC    = mv.querySelector("[data-mediav-cc]");
    const list     = mv.querySelector("#mediavList");
    if (btnPrev)  { btnPrev.title = t("mediav_prev");  btnPrev.setAttribute("aria-label", t("mediav_prev")); }
    if (btnNext)  { btnNext.title = t("mediav_next");  btnNext.setAttribute("aria-label", t("mediav_next")); }
    if (btnClose) { btnClose.title = t("mediav_close");btnClose.setAttribute("aria-label", t("mediav_close")); }
    if (btnCC)    { btnCC.title = t("mediav_cc");      btnCC.setAttribute("aria-label", t("mediav_cc")); }
    if (list)      list.setAttribute("aria-label", t("mediav_playlist"));
  }

	// IMAGES
	const iv = document.getElementById("imgViewer");
	if (iv){
	  iv.querySelector(".imgv-dialog")?.setAttribute("aria-label", t("imgv_viewer"));
	  const ip  = iv.querySelector("[data-prev]");
	  const inx = iv.querySelector("[data-next]");
	  const ic  = iv.querySelector("[data-close]");
	  if (ip)  { ip.title = t("imgv_prev");  ip.setAttribute("aria-label", t("imgv_prev")); }
	  if (inx) { inx.title = t("imgv_next"); inx.setAttribute("aria-label", t("imgv_next")); }
	  if (ic)  { ic.title = t("imgv_close"); ic.setAttribute("aria-label", t("imgv_close")); }
	  iv.querySelector("#imgvStrip")?.setAttribute("aria-label", t("imgv_imagesInFolder"));
	}

  // DOCS
  const dv = document.getElementById("docViewer");
  if (dv){
    dv.querySelector(".docv-dialog")?.setAttribute("aria-label", t("docv_viewer"));
    const dc = dv.querySelector("[data-docv-close]");
    if (dc) { dc.title = t("docv_close"); dc.setAttribute("aria-label", t("docv_close")); }
  }
}

;

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

const cpuFill  = document.getElementById("cpuFill");
const cpuPct   = document.getElementById("cpuPct");
const ramFill  = document.getElementById("ramFill");
const ramPct   = document.getElementById("ramPct");
const tempFill = document.getElementById("tempFill");
const tempVal  = document.getElementById("tempVal");

const fsToggle = document.getElementById("fsToggle");

// Notes DOM
const notesView      = document.getElementById("notesView");
const notesList      = document.getElementById("notesList");
const noteNewBtn     = document.getElementById("noteNewBtn");
const noteDelBtn     = document.getElementById("noteDelBtn");
const noteSaveBtn    = document.getElementById("noteSaveBtn");
const noteTitleInput = document.getElementById("noteTitle");

let quill = null;
state.notes = state.notes || { items: [], activeId: null, searchQuery: "" };

// 🎙️ Audio Notes DOM
const audioNotesView       = document.getElementById("audioNotesView");
const audioNotesList       = document.getElementById("audioNotesList");
const audioNewBtn          = document.getElementById("audioNewBtn");
const audioDelBtn          = document.getElementById("audioDelBtn");
const audioTitleInput      = document.getElementById("audioNoteTitle");
const audioSearchInput     = document.getElementById("audioNotesSearch");
const audioRecBtn          = document.getElementById("audioRecBtn");
const audioStopBtn         = document.getElementById("audioStopBtn");
const audioPlayer          = document.getElementById("audioPlayer");
const audioFilterNormalize = document.getElementById("audioFilterNormalize");
const audioFilterNoise     = document.getElementById("audioFilterNoise");
const audioFilterHighpass  = document.getElementById("audioFilterHighpass");
const audioRecTimer        = document.getElementById("audioRecTimer");

// Estado interno de Audio Notes
if (!state.audioNotes) {
  state.audioNotes = {
    items: [],
    activeId: null,
    searchQuery: "",
    isRecording: false,
    recordedChunks: [],
    mediaRecorder: null,
    stream: null,
    audioCtx: null,
    graphNodes: null,
    timerId: null,
    elapsedSec: 0,
	uiMode: "new",
    filters: {
      normalize: true,
      noiseReduction: true,
      highpass: false
    }
  };
} else {
  // 🔧 Por si venías de una versión anterior, nos aseguramos
  // de que existan todos los campos nuevos
  state.audioNotes.items         = state.audioNotes.items         || [];
  state.audioNotes.activeId      = state.audioNotes.activeId      ?? null;
  state.audioNotes.searchQuery   = state.audioNotes.searchQuery   ?? "";
  state.audioNotes.isRecording   = state.audioNotes.isRecording   ?? false;
  state.audioNotes.recordedChunks = state.audioNotes.recordedChunks || [];
  state.audioNotes.mediaRecorder = state.audioNotes.mediaRecorder || null;
  state.audioNotes.stream        = state.audioNotes.stream        || null;
  state.audioNotes.audioCtx      = state.audioNotes.audioCtx      || null;
  state.audioNotes.graphNodes    = state.audioNotes.graphNodes    || null;
  state.audioNotes.timerId       = state.audioNotes.timerId       || null;
  state.audioNotes.elapsedSec    = state.audioNotes.elapsedSec    ?? 0;
  state.audioNotes.uiMode = state.audioNotes.uiMode || "new";

  state.audioNotes.filters = state.audioNotes.filters || {};
  state.audioNotes.filters.normalize      = state.audioNotes.filters.normalize      ?? true;
  state.audioNotes.filters.noiseReduction = state.audioNotes.filters.noiseReduction ?? true;
  state.audioNotes.filters.highpass       = state.audioNotes.filters.highpass       ?? false;
}



// 📚 Librería DOM
const libraryView = document.getElementById("libraryView");
const libUpBtn = document.getElementById("libUpBtn");
const libPathLabel = document.getElementById("libPathLabel");
const libList = document.getElementById("libList");
const libEmpty = document.getElementById("libEmpty");
let libDropzone = null; // ← instancia Dropzone reutilizable

// Calendar DOM
const calendarView   = document.getElementById("calendarView");
const calendarHost   = document.getElementById("calendar");
const calTodayBtn    = document.getElementById("calTodayBtn");
const calPrevBtn     = document.getElementById("calPrevBtn");
const calNextBtn     = document.getElementById("calNextBtn");
const calTitle       = document.getElementById("calTitle");
const modeCalendar   = document.getElementById("modeCalendar");

// Whiteboard DOM
const modeWhiteboard   = document.getElementById("modeWhiteboard");
const whiteboardView   = document.getElementById("whiteboardView");
const whiteboardFrame  = document.getElementById("whiteboardFrame");
const whiteboardTitle  = document.getElementById("whiteboardTitle");
const whiteboardNewBtn = document.getElementById("whiteboardNewBtn");
const whiteboardSaveBtn= document.getElementById("whiteboardSaveBtn");
const whiteboardNameInput = document.getElementById("whiteboardNameInput");

// ⬇️ NUEVO: para saber si ya hemos inicializado el iframe de Excalidraw
let whiteboardIframeInitialized = false;

// Spreadsheet DOM
const modeSpreadsheet = document.getElementById("modeSpreadsheet");
const spreadsheetView = document.getElementById("spreadsheetView");
const sheetTitle      = document.getElementById("sheetTitle");
const sheetP1         = document.getElementById("sheetP1");
const sheetP2         = document.getElementById("sheetP2");

const modeTextDoc    = document.getElementById("modeTextDoc");
const textDocView    = document.getElementById("textDocView");

// Games / Minesweeper DOM
const modeGames        = document.getElementById("modeGames");
const gamesMenu        = document.getElementById("gamesMenu");
const modeMinesweeper  = document.getElementById("modeMinesweeper");
const gamesView        = document.getElementById("gamesView");
const minesweeperFrame = document.getElementById("minesweeperFrame");

function syncGamesTheme() {
  const frame = document.getElementById("minesweeperFrame"); // o el id real
  if (!frame || !frame.contentWindow) return;
  const theme = getAppTheme(); // ya existente en tu código
  frame.contentWindow.postMessage({
    type: "OFFLINED_THEME",
    theme
  }, "*");
}

// Botones de cambio de vista
const calViewMonth = document.getElementById("calViewMonth");
const calViewWeek  = document.getElementById("calViewWeek");
const calViewDay   = document.getElementById("calViewDay");
const calViewList  = document.getElementById("calViewList");
const calViewMulti = document.getElementById("calViewMulti");

let _fc = null; // instancia de FullCalendar
state.calendar = state.calendar || { events: [], lastView: "dayGridMonth", lastDate: null };

// Calendar modal DOM
const calOverlay   = document.getElementById("calOverlay");
const calClose     = document.getElementById("calClose");
const calCancel    = document.getElementById("calCancel");
const calSave      = document.getElementById("calSave");
console.log("[CAL] calSave element:", calSave);
const calModalTitle= document.getElementById("calModalTitle");
const calInputTitle= document.getElementById("calInputTitle");
const calInputDate = document.getElementById("calInputDate");
const calInputTime = document.getElementById("calInputTime");
const calTimeRow   = document.getElementById("calTimeRow");

if (calClose)  calClose.addEventListener("click", closeCalModal);
if (calCancel) calCancel.addEventListener("click", closeCalModal);
if (calOverlay){
  calOverlay.addEventListener("click", (e)=>{
    if (e.target === calOverlay) closeCalModal(); // click fuera cierra
  });
}
// Click directo en el botón Guardar del modal
if (calSave) {
  calSave.addEventListener("click", handleCalSaveClick);
}

let _calEditingEvent = null;   // null = creando; objeto = editando
let _calDraft = null;          // { startDateStr, allDay }

// Sky DOM
const modeSky = document.getElementById("modeSky");
const skyView = document.getElementById("skyView");

// 👇 NUEVO (Supporters DOM)
const supportersView = document.getElementById("supportersView");

// Idioma en footer
let langFlagEl, langNameEl;

// ===== helpers de foco =====
function focusEditor() {
  if (chatView.classList.contains("hidden")) return;
  input.focus({ preventScroll: true });
  const end = input.value.length;
  try { input.setSelectionRange(end, end); } catch {}
}

// ===== FULLSCREEN HELPERS =====
function isFullscreen(){
  return !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement);
}
async function enterFullscreen(){
  const el = document.documentElement;
  if (el.requestFullscreen) return el.requestFullscreen();
  if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
  if (el.msRequestFullscreen) return el.msRequestFullscreen();
}
function exitFullscreen(){
  if (document.exitFullscreen) return document.exitFullscreen();
  if (document.webkitExitFullscreen) return document.webkitExitFullscreen();
  if (document.msExitFullscreen) return document.msExitFullscreen();
}
function syncFsUi(){
  const on = isFullscreen();
  if (fsToggle){
    fsToggle.setAttribute("aria-pressed", on ? "true" : "false");
    fsToggle.classList.toggle("active", on);
    // Alterna icono + tooltip
    fsToggle.textContent = on ? "⤢" : "⛶";
    fsToggle.title = on ? "Salir de pantalla completa" : "Pantalla completa";
    fsToggle.setAttribute("aria-label", fsToggle.title);
  }
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

  // 1) greetings: { es: "..."/["..."], en: "..."/["..."], ... }
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

  // 3) fallbacks por idioma
  if (lang === "es") {
    return `¡Hola! me llamo ${agent.name}. ¿En qué puedo ayudarte?`;
  } else if (lang === "fr") {
    return `Bonjour ! Je m'appelle ${agent.name}. Comment puis-je vous aider ?`;
  } else if (lang === "pt") {
    return `Olá! Chamo-me ${agent.name}. Em que posso ajudar?`;
  }
  return `Hi! My name is ${agent.name}. How can I help?`;
}


// ===== KIWIX CLIENT HELPERS =====
async function existsByGet(url) {
  try {
    const r = await fetch(url, {
      method: "GET",
      headers: { "Range": "bytes=0-0" } // intenta 206; algunos devuelven 200
    });
    return r.ok || r.status === 206;
  } catch {
    return false;
  }
}


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
    fr: ["Wikipédia:Hors-ligne", "Wikipédia:Accueil_principal"],
	pt: ["Wikipédia:Página principal","Página_principal"]
  };
  const arr = map[lang] || map.en;
  return arr[0];
}
// Deshabilitar autodetección de Dropzone (importante antes de usar Dropzone manualmente)
if (window.Dropzone) {
  Dropzone.autoDiscover = false;
}

function formatBytes(bytes){
  if (typeof bytes !== "number" || isNaN(bytes)) return "";
  if (bytes === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let i = 0;

  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }

  const fixed = (value >= 10 || i === 0) ? 0 : 1;
  return value.toFixed(fixed) + " " + units[i];
}

// ===== INIT =====
function init(){
  restorePrefs();
  state.library.sort = state.library.sort || "name";
  state.library.filter = state.library.filter || "";
  attachEvents();
  setActiveModelTag();
  setupBattery();
  
  pollMetrics();
  setInterval(pollMetrics, 2000);
  syncFsUi();

  // 🔁 Historial de agentes recientes
  loadRecentAgents();        // ← lee localStorage → state.recentAgents
  ensureRecentsBar();        // ← crea el contenedor debajo del botón si no existe
  renderRecentAgentsBar();   // ← lo pinta / oculta según toque

  showBackendModel().then(async ()=>{
    applyTranslations();

    // ⬇️ reemplaza el antiguo applyMediaLabels() por nuestra función i18n:
    i18nApplyViewersLabels();

    if (activeProfessionTag) activeProfessionTag.classList.add("tag--profession");

    // Pinta la vista guardada (llm/agents/wiki/library)
    await setMode(state.mode);
    // ⬇️ Aquí, en este punto EXACTO:
    maybeShowIntroModalOnBoot();   // ← ✔️ INTRO MODAL APARECE AQUÍ
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
  
  // Preferencias de cielo (si existen)
  try {
    const savedSky = localStorage.getItem("skyPrefs");
    if (savedSky) {
      const parsed = JSON.parse(savedSky);
      if (parsed && typeof parsed === "object") {
        state.sky = { ...state.sky, ...parsed };
      }
    }
  } catch {}

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
  // Support (botón)  
  const suppBtn = document.getElementById("modeSupporters");
  if (suppBtn) suppBtn.textContent = t("modeSupporters");
  // 🌐 World (dropdown)
  const modeWorld = document.getElementById("modeWorld");
  if (modeWorld) modeWorld.textContent = t("modeWorld");

  // Subopciones del menú Mundo (reutilizamos las claves ya existentes)
  const modeMapsBtn = document.getElementById("modeMaps");
  const modeSkyBtn  = document.getElementById("modeSky");
  if (modeMapsBtn) modeMapsBtn.textContent = t("modeMaps");
  if (modeSkyBtn)  modeSkyBtn.textContent  = t("modeSky");
  
  const modeAppsBtn = document.getElementById("modeApps");
  const modeNotesBtn= document.getElementById("modeNotes");
  if (modeAppsBtn) modeAppsBtn.textContent = t("modeApps");
  if (modeNotesBtn) modeNotesBtn.textContent = t("modeNotes");

  if (noteNewBtn) {
    const label = t("notesNew");
    noteNewBtn.title       = label;
    // ✅ Ahora usamos el emoji ➕
    noteNewBtn.textContent = `➕ ${label}`;
  }

  if (noteDelBtn) {
    const label = t("notesDelete");
    noteDelBtn.title       = label;
    noteDelBtn.textContent = `🗑️ ${label}`;
  }

  if (noteSaveBtn) {
    noteSaveBtn.textContent = `💾 ${t("notesSave")}`;
  }

  if (noteTitleInput) {
    noteTitleInput.placeholder = t("notesUntitled");
  }

  const notesSearchInput = document.getElementById("notesSearch");
  if (notesSearchInput) {
    notesSearchInput.placeholder = t("notesSearchPlaceholder");
  }
  
  // 🎙️ Audio Notes: textos
  const modeAudioNotesBtn = document.getElementById("modeAudioNotes");
  if (modeAudioNotesBtn) {
    modeAudioNotesBtn.textContent = t("modeAudioNotes");
  }

  if (audioNewBtn) {
    const label = t("audioNew");
    audioNewBtn.title       = label;
    audioNewBtn.textContent = `➕ ${label}`;
  }

  if (audioDelBtn) {
    const label = t("audioDelete");
    audioDelBtn.title       = label;
    audioDelBtn.textContent = `🗑️ ${label}`;
  }

  if (audioRecBtn) {
    audioRecBtn.textContent = `⏺️ ${t("audioRecord")}`;
  }
  if (audioStopBtn) {
    audioStopBtn.textContent = `⏹️ ${t("audioStop")}`;
  }

  if (audioTitleInput) {
    audioTitleInput.placeholder = t("audioUntitled");
  }

  if (audioSearchInput) {
    audioSearchInput.placeholder = t("audioSearchPlaceholder");
  }

  if (audioFilterNormalize) {
    document.getElementById("audioFilterNormalizeLabel").textContent = t("audioFilterNormalize");
  }
  if (audioFilterNoise) {
    document.getElementById("audioFilterNoiseLabel").textContent = t("audioFilterNoise");
  }
  if (audioFilterHighpass) {
    document.getElementById("audioFilterHighpassLabel").textContent = t("audioFilterHighpass");
  }

  
  const modeCalendarBtn = document.getElementById("modeCalendar");
  if (modeCalendarBtn) modeCalendarBtn.textContent = t("modeCalendar");
  if (calNewBtn)   { calNewBtn.title = t("calNew");   calNewBtn.textContent = "＋"; }
  if (calTodayBtn) { calTodayBtn.title = t("calToday"); }
  if (calPrevBtn)  { calPrevBtn.title = t("calPrev"); }
  if (calNextBtn)  { calNextBtn.title = t("calNext"); }
  
  if (modeSpreadsheet) modeSpreadsheet.textContent = t("modeSpreadsheet");
  if (sheetTitle)      sheetTitle.textContent      = t("sheetTitle");
  if (sheetP1)         sheetP1.textContent         = t("sheetP1");
  if (sheetP2)         sheetP2.textContent         = t("sheetP2");

  const modeGamesBtn       = document.getElementById("modeGames");
  const modeMinesweeperBtn = document.getElementById("modeMinesweeper");
  if (modeGamesBtn)       modeGamesBtn.textContent       = t("modeGames");
  if (modeMinesweeperBtn) modeMinesweeperBtn.textContent = t("gameMinesweeper");
  
  const gamesHeader = document.getElementById("gamesHeader");
  gamesHeader.textContent = `${t("modeGames").replace("▾","").trim()} — ${t("gameMinesweeper")}`;
  
  // ✨ Sky (placeholder: títulos y párrafos)
  const skyTitle = document.getElementById("skyTitle");
  const skyP1    = document.getElementById("skyP1");
  const skyP2    = document.getElementById("skyP2");
  if (skyTitle) skyTitle.textContent = t("skyTitle");
  if (skyP1)    skyP1.textContent    = t("skyP1");
  if (skyP2)    skyP2.textContent    = t("skyP2");
  
  if (sheetTitle) sheetTitle.textContent = t("sheetTitle");
  if (sheetP1)    sheetP1.textContent    = t("sheetP1");
  if (sheetP2)    sheetP2.textContent    = t("sheetP2");
  
  // 🗺️ Maps (placeholder)
  const mapsTitle = document.getElementById("mapsTitle");
  const mapsP1 = document.getElementById("mapsP1");
  const mapsP2 = document.getElementById("mapsP2");
  if (mapsTitle) mapsTitle.textContent = t("mapsTitle");
  if (mapsP1)    mapsP1.textContent    = t("mapsP1");
  if (mapsP2)    mapsP2.textContent    = t("mapsP2");
  
  // 🌿 Wiki-trees (textos)
  const btnWikiTrees = document.getElementById("btnWikiTrees");
  if (btnWikiTrees) btnWikiTrees.textContent = t("wikiTrees");
  
	const btnEncartha = document.getElementById("btnEncartha");
	if (btnEncartha){
	  const LBL = {
		es: "Hablar con Michael Encartha",
		en: "Talk to Michael Encartha",
		fr: "Parler avec Michael Encartha"
	  }[state.lang] || "Talk to Michael Encartha";
	  btnEncartha.title = LBL;
	  btnEncartha.textContent = t("talkToEncartha");
	  btnEncartha.type = "button"; // opcional (lo tienes ya en un index)
	  btnEncartha.addEventListener("click", async ()=>{
		try { await setMode("agents"); } catch {}
		openAgentByName("Michael Encartha");
	  });
	}

  const wikiTreesCatalogTitle = document.getElementById("wikiTreesCatalogTitle");
  if (wikiTreesCatalogTitle) wikiTreesCatalogTitle.textContent = t("wikiTreesCatalogTitle");

  const catalogClose = document.getElementById("catalogClose");
  if (catalogClose) catalogClose.textContent = t("wikiTreesClose");

  const treeBack = document.getElementById("treeBack");
  if (treeBack) treeBack.textContent = t("wikiTreesBack");

  const treeClose = document.getElementById("treeClose");
  if (treeClose) treeClose.textContent = t("wikiTreesClose");

  const catalogFilter = document.getElementById("catalogFilter");
  if (catalogFilter) catalogFilter.setAttribute("placeholder", t("wikiTreesFilter"));

  const collapseBtn = document.getElementById("btnWikiTreesCollapse");
  if (collapseBtn) collapseBtn.title = t("wikiTreesCollapseTitle");

  const expandTab = document.getElementById("btnWikiTreesExpand");
  if (expandTab) expandTab.title = t("wikiTreesCollapseTitle");
  
  // Si el panel del árbol está visible y tenemos datos previos, re-localiza con el idioma actual
  if (document.getElementById("wikiTreesPanel") && !document.getElementById("wikiTreesPanel").classList.contains("hidden")) {
    if (state.wikiTrees_lastData) {
      const localized = localizeTaxoTree(state.wikiTrees_lastData, state.lang);
      renderTree(localized);
    }
  }
  // Si el catálogo está visible, recarga (para títulos/descripciones i18n del índice)
  if (document.getElementById("wikiTreesCatalog") && !document.getElementById("wikiTreesCatalog").classList.contains("hidden")) {
    openCatalog(); // volverá a renderizar el catálogo con el idioma activo
  }
  

  // Resto de tu función (sin cambios)
  const step0Title = document.getElementById("step0Title");
  if (step1) step1.querySelector("h3").textContent = t("step1");
  if (step2) step2.querySelector("h3").textContent = t("step2");

  if (backToCats) backToCats.textContent = t("back");
  if (backToList) backToList.textContent = t("back");
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

  // === FullCalendar: refrescar locale al cambiar idioma ===
  if (typeof _fc !== "undefined" && _fc) {
    const map = { es: "es", en: "en", fr: "fr", pt: "pt" };
    _fc.setOption("locale", map[(state.lang || "en").slice(0, 2)] || "en");
    const _calTitleEl = document.getElementById("calTitle");
	if (_calTitleEl) _calTitleEl.textContent = _fc.view?.title || "";
  }

  updateFlagActive();
  applyMediaLabels();
}

function applyMediaLabels(){
  const btnMedia    = document.getElementById("modeMedia");
  const btnVideo    = document.getElementById("modeVideo");
  const btnMusic    = document.getElementById("modeMusic");
  const btnImages   = document.getElementById("modeImages");
  const btnLibrary  = document.getElementById("modeLibrary");
  const btnWhiteboard = document.getElementById("modeWhiteboard");
  const modeFilesBtn  = document.getElementById("modeFiles");
  const btnPortableApps = document.getElementById("modePortableApps");
  const btnSync     = document.getElementById("modeSync");
  const btnTrash    = document.getElementById("modeTrash");

  if (btnMedia)      btnMedia.textContent      = t("modeMedia");
  if (btnVideo)      btnVideo.textContent      = t("modeVideo");
  if (btnMusic)      btnMusic.textContent      = t("modeMusic");
  if (btnImages)     btnImages.textContent     = t("modeImages");
  if (btnLibrary)    btnLibrary.textContent    = t("modeLibrary");
  if (btnWhiteboard) btnWhiteboard.textContent = t("modeWhiteboard");
  if (modeFilesBtn)   modeFilesBtn.textContent   = t("modeFiles");
  if (btnPortableApps) btnPortableApps.textContent = t("modePortableApps") || "🧰 Portable Apps";
  if (btnSync)      btnSync.textContent        = t("modeSync");
  if (btnTrash)    btnTrash.textContent    = t("modeTrash");

  // 🧽 Whiteboard: botones + placeholder del nombre
  const whiteboardNewBtn   = document.getElementById("whiteboardNewBtn");
  const whiteboardSaveBtn  = document.getElementById("whiteboardSaveBtn");
  const whiteboardNameInput = document.getElementById("whiteboardNameInput");

  if (whiteboardNewBtn) {
    const label = t("whiteboardNew");
    whiteboardNewBtn.textContent = `🆕 ${label}`;
    whiteboardNewBtn.title = label;
    whiteboardNewBtn.setAttribute("aria-label", label);
  }
  if (whiteboardSaveBtn) {
    const label = t("whiteboardSave");
    whiteboardSaveBtn.textContent = `💾 ${label}`;
    whiteboardSaveBtn.title = label;
    whiteboardSaveBtn.setAttribute("aria-label", label);
  }
  if (whiteboardNameInput) {
    const ph = t("whiteboardNamePlaceholder") || whiteboardNameInput.placeholder || "";
    whiteboardNameInput.placeholder = ph;
  }

  // 🗺️ Actualizar textos de la barra de búsqueda de mapas si existe
  if (typeof refreshMapsSearchTexts === "function") {
    refreshMapsSearchTexts();
  }
}

// ===== EVENTS =====
function attachEvents(){
  modeLLM.addEventListener("click", ()=> { setMode("llm"); requestAnimationFrame(focusEditor);});
  modeAgents.addEventListener("click", ()=> setMode("agents"));

  const modeWikiBtn = document.getElementById("modeWiki");
  if (modeWikiBtn){
    modeWikiBtn.addEventListener("click", ()=> setMode("wiki"));
  }

  // 📚 Librería (desde el menú Media)
  if (modeLibrary){
    modeLibrary.addEventListener("click", (e)=> {
      e.preventDefault();
      state.library.base = "docs";
      setMode("library");
      const mediaBtn  = document.getElementById("modeMedia");
      const mediaMenu = document.getElementById("mediaMenu");
      mediaMenu?.classList.add("hidden");
      mediaBtn?.setAttribute("aria-expanded", "false");
      if (typeof currentModeTag !== "undefined" && currentModeTag){
        currentModeTag.textContent = t("modeLibrary") || "Library";
      }
    });
  }

  // --- Helper para posicionar menús bajo su botón ---
  function positionMenuUnder(btn, menu){
    const r = btn.getBoundingClientRect();
    const top  = r.bottom + 6;             // 6px de separación
    const left = r.left;                    // alineado al botón
    menu.style.top  = `${top}px`;
    menu.style.left = `${left}px`;
    menu.style.minWidth = `${Math.max(200, r.width)}px`;  // al menos ancho botón
  }

  // --- Dropdown Media (portal al <body>) ---
  const mediaBtn  = document.getElementById("modeMedia");
  const mediaMenu = document.getElementById("mediaMenu");

  // 🎬 Video
  document.getElementById("modeVideo")?.addEventListener("click", (e)=>{
    e.preventDefault();
    state.library.base = "media/video";
    state.library.path = "";
    setMode("library");
    document.getElementById("mediaMenu")?.classList.add("hidden");
    document.getElementById("modeMedia")?.setAttribute("aria-expanded", "false");
    if (typeof currentModeTag !== "undefined" && currentModeTag){
      currentModeTag.textContent = t("modeMedia") + ": " + t("modeVideo");
    }
  });

  // 🎵 Música
  document.getElementById("modeMusic")?.addEventListener("click", (e)=>{
    e.preventDefault();
    state.library.base = "media/music";
    state.library.path = "";
    setMode("library");
    document.getElementById("mediaMenu")?.classList.add("hidden");
    document.getElementById("modeMedia")?.setAttribute("aria-expanded", "false");
    if (typeof currentModeTag !== "undefined" && currentModeTag){
      currentModeTag.textContent = t("modeMedia") + ": " + t("modeMusic");
    }
  });

  // 🖼️ Imágenes
  document.getElementById("modeImages")?.addEventListener("click", (e)=>{
    e.preventDefault();
    state.library.base = "media/images";
    state.library.path = "";
    setMode("library");
    document.getElementById("mediaMenu")?.classList.add("hidden");
    document.getElementById("modeMedia")?.setAttribute("aria-expanded", "false");
    if (typeof currentModeTag !== "undefined" && currentModeTag){
      currentModeTag.textContent = t("modeMedia") + ": " + t("modeImages");
    }
  });

  // 📂 Archivos
  document.getElementById("modeFiles")?.addEventListener("click", (e)=>{
    e.preventDefault();
    state.library.base = "media/files";
    state.library.path = "";
    setMode("library");
    document.getElementById("mediaMenu")?.classList.add("hidden");
    document.getElementById("modeMedia")?.setAttribute("aria-expanded", "false");
    if (typeof currentModeTag !== "undefined" && currentModeTag){
      currentModeTag.textContent = t("modeMedia") + ": " + t("modeFiles");
    }
  });
  
  // 🧰 Portable Apps
  document.getElementById("modePortableApps")?.addEventListener("click", (e)=>{
    e.preventDefault();
    state.library.base = "media/portable_apps";
    state.library.path = "";
    setMode("library");
    document.getElementById("mediaMenu")?.classList.add("hidden");
    document.getElementById("modeMedia")?.setAttribute("aria-expanded", "false");
    if (typeof currentModeTag !== "undefined" && currentModeTag){
      currentModeTag.textContent = t("modeMedia") + ": " + (t("modePortableApps") || "Portable Apps");
    }
  });
  
  // 🔄 Sync
  document.getElementById("modeSync")?.addEventListener("click", (e)=>{
    e.preventDefault();
    // No usamos libraryView, tenemos vista propia
    state.sync.path = "";
    setMode("sync");
    document.getElementById("mediaMenu")?.classList.add("hidden");
    document.getElementById("modeMedia")?.setAttribute("aria-expanded", "false");
    if (typeof currentModeTag !== "undefined" && currentModeTag){
      currentModeTag.textContent = t("modeMedia") + ": " + t("modeSync");
    }
  });
  
  // 🗑️ Papelera
  document.getElementById("modeTrash")?.addEventListener("click", (e)=>{
    e.preventDefault();
    state.library.base = "trash";
    state.library.path = "";
    setMode("library");
    document.getElementById("mediaMenu")?.classList.add("hidden");
    document.getElementById("modeMedia")?.setAttribute("aria-expanded", "false");
    if (typeof currentModeTag !== "undefined" && currentModeTag){
      currentModeTag.textContent = t("modeMedia") + ": " + t("modeTrash");
    }
  });

  // ✅ NUEVOS: botones de acciones masivas de la papelera
  const btnTrashRestoreAll = document.getElementById("btnTrashRestoreAll");
  if (btnTrashRestoreAll) {
    btnTrashRestoreAll.addEventListener("click", onTrashRestoreAllClick);
  }

  const btnTrashDeleteAll = document.getElementById("btnTrashDeleteAll");
  if (btnTrashDeleteAll) {
    btnTrashDeleteAll.addEventListener("click", onTrashDeleteAllClick);
  }

  // 📚 Librería (docs)
  document.getElementById("modeLibrary")?.addEventListener("click", (e)=>{
    e.preventDefault();
    state.library.base = "docs";
    setMode("library");
    document.getElementById("mediaMenu")?.classList.add("hidden");
    document.getElementById("modeMedia")?.setAttribute("aria-expanded", "false");
    if (typeof currentModeTag !== "undefined" && currentModeTag){
      currentModeTag.textContent = t("modeLibrary");
    }
  });
  
  // Apps (“➕”) dropdown — portal al <body> y posición bajo el botón
  {
    const appsBtn  = document.getElementById("modeApps");
    const appsMenu = document.getElementById("appsMenu");

    if (appsBtn && appsMenu) {
      // Portal al body (como Media y Mundo)
      if (appsMenu.parentElement !== document.body){
        document.body.appendChild(appsMenu);
      }

      const hideApps = ()=>{
        appsMenu.classList.add("hidden");
        appsBtn.setAttribute("aria-expanded", "false");
      };

      appsBtn.addEventListener("click", (e)=>{
        e.preventDefault();
        const isHidden = appsMenu.classList.contains("hidden");
        // cierra otros menús abiertos (Media, Mundo, etc.)
        document.querySelectorAll(".dropdown-menu").forEach(m => m.classList.add("hidden"));
        if (isHidden){
          positionMenuUnder(appsBtn, appsMenu);   // 👈 igual que Media/Mundo
          appsMenu.classList.remove("hidden");
          appsBtn.setAttribute("aria-expanded", "true");
        } else {
          hideApps();
        }
      });

      // Recolocar si cambia tamaño o scroll (como Media/Mundo)
      const reflowAppsIfOpen = ()=>{
        if (!appsMenu.classList.contains("hidden")){
          positionMenuUnder(appsBtn, appsMenu);
        }
      };
      window.addEventListener("resize", reflowAppsIfOpen);
      window.addEventListener("scroll", reflowAppsIfOpen, true);

      // Cerrar si clic fuera
      document.addEventListener("click", (e)=>{
        const insideBtn  = e.target.closest && e.target.closest("#modeApps");
        const insideMenu = e.target.closest && e.target.closest("#appsMenu");
        if (!insideBtn && !insideMenu){
          hideApps();
        }
      });
    }

    // Abrir Audio Notes desde el menú
    document.getElementById("modeAudioNotes")?.addEventListener("click", async (e)=>{
      e.preventDefault();
      await setMode("audio-notes");
      document.getElementById("appsMenu")?.classList.add("hidden");
      document.getElementById("modeApps")?.setAttribute("aria-expanded", "false");
      if (currentModeTag) currentModeTag.textContent = t("modeAudioNotes");
    });

    // Abrir Notes desde el menú
    document.getElementById("modeNotes")?.addEventListener("click", async (e)=>{
      e.preventDefault();
      await setMode("notes");
      document.getElementById("appsMenu")?.classList.add("hidden");
      if (currentModeTag) currentModeTag.textContent = t("modeNotes");
    });
    // Abrir Hoja de Cálculo desde el menú
    document.getElementById("modeSpreadsheet")?.addEventListener("click", async (e)=>{
      e.preventDefault();
      await setMode("spreadsheet");
      document.getElementById("appsMenu")?.classList.add("hidden");
      document.getElementById("modeApps")?.setAttribute("aria-expanded", "false");
      if (currentModeTag) currentModeTag.textContent = t("modeSpreadsheet");
    });

    // 📄 Documento de texto (Univer v4)
    if (modeTextDoc){
      modeTextDoc.addEventListener("click", (e)=> {
        e.preventDefault();
        setMode("textdoc");

        const appsBtn  = document.getElementById("modeApps");
        const appsMenu = document.getElementById("appsMenu");
        appsMenu?.classList.add("hidden");
        appsBtn?.setAttribute("aria-expanded", "false");

        if (typeof currentModeTag !== "undefined" && currentModeTag){
          currentModeTag.textContent = t("modeTextDoc") || "Text document";
        }
      });
    }
  }

  // Acciones Notes
  noteNewBtn?.addEventListener("click", noteNew);

  noteDelBtn?.addEventListener("click", () => {
    const active = state.notes.items.find(n => n.id === state.notes.activeId);
    const name = active?.title || t("notesUntitled");
    showNoteDeleteConfirm(name);
  });

  noteSaveBtn?.addEventListener("click", noteSave);

  const notesSearchInput = document.getElementById("notesSearch");
  notesSearchInput?.addEventListener("input", (ev) => {
    state.notes.searchQuery = ev.target.value || "";
    renderNotesList();
  });

  // Acciones Audio Notes
  audioNewBtn?.addEventListener("click", () => {
    state.audioNotes.activeId = null;
    if (audioTitleInput) audioTitleInput.value = "";
    if (audioPlayer) {
      audioPlayer.removeAttribute("src");
      audioPlayer.load();
    }
    // nuevo → modo grabación
    setAudioUiMode("new");
  });

  audioDelBtn?.addEventListener("click", () => {
    if (!state.audioNotes.activeId) return;
    const active = state.audioNotes.items.find(n => n.id === state.audioNotes.activeId);
    const name = active?.title || t("audioUntitled");
    showAudioDeleteConfirm(name);
  });

  audioRecBtn?.addEventListener("click", startAudioRecording);
  audioStopBtn?.addEventListener("click", stopAudioRecording);

  audioSearchInput?.addEventListener("input", (ev) => {
    state.audioNotes.searchQuery = ev.target.value || "";
    renderAudioNotesList();
  });

  // Cambios en filtros
  audioFilterNormalize?.addEventListener("change", (e)=>{
    state.audioNotes.filters.normalize = !!e.target.checked;
  });
  audioFilterNoise?.addEventListener("change", (e)=>{
    state.audioNotes.filters.noiseReduction = !!e.target.checked;
  });
  audioFilterHighpass?.addEventListener("change", (e)=>{
    state.audioNotes.filters.highpass = !!e.target.checked;
  });

  if (mediaBtn && mediaMenu){
    // Portal al body
    if (mediaMenu.parentElement !== document.body){
      document.body.appendChild(mediaMenu);
    }

    const hideMenu = ()=>{
      mediaMenu.classList.add("hidden");
      mediaBtn.setAttribute("aria-expanded", "false");
    };

    mediaBtn.addEventListener("click", (e)=>{
      e.preventDefault();
      const isHidden = mediaMenu.classList.contains("hidden");
      // cierra otros menús
      document.querySelectorAll(".dropdown-menu").forEach(m => m.classList.add("hidden"));
      if (isHidden){
        positionMenuUnder(mediaBtn, mediaMenu);
        mediaMenu.classList.remove("hidden");
        mediaBtn.setAttribute("aria-expanded", "true");
      } else {
        hideMenu();
      }
    });

    const reflowIfOpen = ()=>{
      if (!mediaMenu.classList.contains("hidden")){
        positionMenuUnder(mediaBtn, mediaMenu);
      }
    };
    window.addEventListener("resize", reflowIfOpen);
    window.addEventListener("scroll", reflowIfOpen, true);

    document.addEventListener("click", (e)=>{
      const insideBtn  = e.target.closest && e.target.closest("#modeMedia");
      const insideMenu = e.target.closest && e.target.closest("#mediaMenu");
      if (!insideBtn && !insideMenu){
        hideMenu();
      }
    });
  }

  // --- Dropdown Mundo (portal al <body>) ---
  const worldBtn  = document.getElementById("modeWorld");
  const worldMenu = document.getElementById("worldMenu");

  if (worldBtn && worldMenu){
    // Portal al body
    if (worldMenu.parentElement !== document.body){
      document.body.appendChild(worldMenu);
    }

    const hideWorld = ()=>{
      worldMenu.classList.add("hidden");
      worldBtn.setAttribute("aria-expanded", "false");
    };

    worldBtn.addEventListener("click", (e)=>{
      e.preventDefault();
      const isHidden = worldMenu.classList.contains("hidden");
      // cierra otros menús abiertos (incluido Media)
      document.querySelectorAll(".dropdown-menu").forEach(m => m.classList.add("hidden"));
      if (isHidden){
        positionMenuUnder(worldBtn, worldMenu);
        worldMenu.classList.remove("hidden");
        worldBtn.setAttribute("aria-expanded", "true");
      } else {
        hideWorld();
      }
    });

    const reflowWorldIfOpen = ()=>{
      if (!worldMenu.classList.contains("hidden")){
        positionMenuUnder(worldBtn, worldMenu);
      }
    };
    window.addEventListener("resize", reflowWorldIfOpen);
    window.addEventListener("scroll", reflowWorldIfOpen, true);

    document.addEventListener("click", (e)=>{
      const insideBtn  = e.target.closest && e.target.closest("#modeWorld");
      const insideMenu = e.target.closest && e.target.closest("#worldMenu");
      if (!insideBtn && !insideMenu){
        hideWorld();
      }
    });

    // Subopciones: Mapas y Cielo
    const modeMapsBtn = document.getElementById("modeMaps");
    if (modeMapsBtn){
      modeMapsBtn.addEventListener("click", async (e)=>{
        e.preventDefault();
        await setMode("maps");
        hideWorld();
        if (typeof currentModeTag !== "undefined" && currentModeTag){
          currentModeTag.textContent = t("modeMaps");
        }
      });
    }

    const modeSkyBtn = document.getElementById("modeSky");
    if (modeSkyBtn){
      modeSkyBtn.addEventListener("click", async (e)=>{
        e.preventDefault();
        await setMode("sky");
        hideWorld();
        if (typeof currentModeTag !== "undefined" && currentModeTag){
          currentModeTag.textContent = t("modeSky");
        }
      });
    }
  }

  // 🌿 Wiki-trees (Kiwix)
  const btnWikiTrees = document.getElementById("btnWikiTrees");
  if (btnWikiTrees){
    btnWikiTrees.addEventListener("click", async ()=>{
      try { await ensureWikiReady(); } catch {}
      state.wikiTrees_lastView = state.wikiTrees_lastView || "catalog"; // recuerda última vista
      await openCatalog(); // vista intermedia

      // Si estaba colapsado, reabrimos el panel y ocultamos la pestaña lateral
      if (state.wikiTrees_collapsed) {
        state.wikiTrees_collapsed = false;
        restoreWikiTreesLastView();
        const H = document.getElementById("splitHandle");
        if (H) H.classList.remove("hidden");
        const expandTab = document.getElementById("btnWikiTreesExpand");
        if (expandTab) expandTab.classList.add("hidden");
      }
    });
  }

  // "Volver" dentro del panel
  document.getElementById("treeBack")?.addEventListener("click", ()=> openCatalog());

  // Botón interno para CERRAR el panel de árboles
  const collapseBtn = document.getElementById("btnWikiTreesCollapse");
  const expandTab   = document.getElementById("btnWikiTreesExpand");

  if (collapseBtn){
    const H = ()=> document.getElementById("splitHandle");
    collapseBtn.addEventListener("click", ()=>{
      // Colapsamos siempre (esta vez no es toggle dentro del mismo botón)
      state.wikiTrees_collapsed = true;

      // Ocultamos catálogo + panel de árbol
      document.getElementById("wikiTreesCatalog")?.classList.add("hidden");
      document.getElementById("wikiTreesPanel")?.classList.add("hidden");
      H()?.classList.add("hidden");

      // Mostramos la pestaña lateral para reabrir
      if (expandTab) expandTab.classList.remove("hidden");
    });
  }

  // Pestaña lateral para ABRIR el panel de árboles
  if (expandTab){
    expandTab.addEventListener("click", ()=>{
      state.wikiTrees_collapsed = false;

      // Restaurar la vista que hubiera (catálogo o panel)
      restoreWikiTreesLastView();

      const H = document.getElementById("splitHandle");
      if (H) H.classList.remove("hidden");

      // Ocultar pestaña lateral
      expandTab.classList.add("hidden");
    });
  }

  document.getElementById("catalogClose")?.addEventListener("click", ()=>{
    const cat = document.getElementById("wikiTreesCatalog");
    if (cat) cat.classList.add("hidden");
    state.wikiTrees_lastView = "catalog";
  });

  document.getElementById("treeBack")?.addEventListener("click", ()=> openCatalog());

  document.getElementById("treeClose")?.addEventListener("click", ()=>{
    const pnl = document.getElementById("wikiTreesPanel");
    if (pnl) pnl.classList.add("hidden");
    state.wikiTrees_lastView = "panel";
  });

  document.getElementById("catalogFilter")?.addEventListener("input", filterCatalog);

  // (Eliminados los listeners "placeholder" directos a Sky/Maps;
  // ahora se manejan dentro del submenú Mundo)

  const suppBtn = document.getElementById("modeSupporters");
  if (suppBtn){
    suppBtn.addEventListener("click", ()=> setMode("supporters"));
  }

  if (selectAgentBtn){
    selectAgentBtn.addEventListener("click", ()=>{
      saveCurrentScroll();
      state.mode = "agents";
      localStorage.setItem("mode","agents");

      agentsSteps.classList.remove("hidden");
      chatView.classList.add("hidden");
      if (activeProfessionTag) activeProfessionTag.classList.add("hidden");

      if (step0) step0.classList.add("hidden");
      if (step1) step1.classList.remove("hidden");
      if (step2) step2.classList.add("hidden");

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

  if (themeToggle) {
    themeToggle.addEventListener("click", () => {
      const root    = document.documentElement;
      const current = root.getAttribute("data-theme") || root.dataset.theme || "dark";
      const next    = (current === "dark") ? "light" : "dark";

      // 1) Actualizar atributo + dataset + localStorage
      root.setAttribute("data-theme", next);
      root.dataset.theme = next;
      try {
        localStorage.setItem("theme", next);
      } catch(e){}

      // 2) Sincronizar otros subsistemas (juegos, whiteboard, etc.)
      if (typeof syncGamesTheme === "function") {
        try { syncGamesTheme(next); } catch(e){}
      }
      if (typeof broadcastThemeToWhiteboard === "function") {
        try { broadcastThemeToWhiteboard(next); } catch(e){}
      }
      try {
        window.dispatchEvent(new CustomEvent("OFFLINED_THEME_CHANGED", {
          detail: { theme: next }
        }));
      } catch(e){}

      // 3) 🗺️ Si hay mapa, recargar estilo con el nuevo tema
      if (typeof reloadMapStyleForTheme === "function" && _map) {
        try {
          console.log("[MAPS] themeToggle → recargando style para", next);
          // No hace falta pasar themeOverride: internamente usa getAppTheme()
          reloadMapStyleForTheme(); 
        } catch (err) {
          console.warn("[MAPS] Error reloading map style on theme toggle:", err);
        }
      }
    });
  }

  if (fsToggle){
    fsToggle.addEventListener("click", async ()=>{
      try{
        if (isFullscreen()) await exitFullscreen();
        else await enterFullscreen();
      } finally {
        syncFsUi();
      }
    });
  }
  document.addEventListener("fullscreenchange", syncFsUi);
  document.addEventListener("webkitfullscreenchange", syncFsUi);
  document.addEventListener("msfullscreenchange", syncFsUi);

  document.getElementById("resetChat").addEventListener("click", async ()=>{
    state.chats = { model: [], agents: {} };
    chat.innerHTML = "";

    state.recentAgents = [];
    saveRecentAgents();
    renderRecentAgentsBar();

    state._encarthaIntroShown = false;

    try {
      await fetch(`${BASE_URL}/api/reset`, { method: "POST" });
      if (state.mode === "llm") {
        addMessage("bot", t("survivorInit"));
        renderConversation();
        if (activeProfessionTag) activeProfessionTag.classList.add("hidden");
      } else if (state.mode === "agents" && state.selectedAgent) {
        if (isEncarthaActive()) {
          // 🔁 Para Michael Encartha, usamos la misma intro que desde “Hablar con Michael Encartha”
          // (árboles-wiki + categorías, usando encarthaInitialView)
          await encarthaInitialView();
        } else {
          // Resto de agentes → saludo normal
          const greet = pickGreeting(state.selectedAgent);
          if (greet) addMessage("bot", greet);
          renderConversation();
        }
      }
      requestAnimationFrame(focusEditor);
    } catch (err) {
      addMessage("bot", `⚠️ Could not reset: ${err.message}`);
    }
  });

  // ✅ ÚNICO bloque de clicks globales (restaurar/borrar, wiki, agentes, chips…)
  document.addEventListener("click", async (e) => {

    // ♻️ Botón de restaurar en la papelera
    const restoreBtn = e.target.closest && e.target.closest(".lib-restore-btn");

    // 🗑️ Botón de borrar en filas de librería/media (incluida papelera → borrado definitivo)
    const delBtn = e.target.closest && e.target.closest(".lib-delete-btn");
    if (delBtn) {
      e.preventDefault();
      e.stopPropagation();

      const row  = delBtn.closest(".lib-row");
      const rel  = delBtn.getAttribute("data-rel") || (row && row.getAttribute("data-rel")) || "";
      const type = delBtn.getAttribute("data-type") || (row && row.getAttribute("data-type")) || "file";
      const name = row?.querySelector(".lib-name")?.textContent || rel;

      showLibDeleteConfirm({ rel, name, type });
      return; // ⬅️ IMPORTANTE: no dejar que siga a otras ramas
    }

    const wiki = e.target.closest && e.target.closest('a.wiki-link');
    if (wiki){
      e.preventDefault();
      const title = wiki.getAttribute('data-wiki-title') || (wiki.textContent || "").trim();
      if (title) { try { await openWikiArticle(title); } catch {} }
    }

    const link = e.target.closest && e.target.closest('a.agent-link');
    if (link){
      e.preventDefault();
      if (state.mode !== "agents") return;
      const name = link.getAttribute('data-agent-name') || link.textContent || "";
      if (name) openAgentByName(name);
      return;
    }

    const card = e.target.closest && e.target.closest('.ref-card');
    if (card){
      e.preventDefault();
      if (state.mode !== "agents") return;
      const name = card.getAttribute('data-agent-name') || "";
      if (name) openAgentByName(name);
      return;
    }

    const chip = e.target.closest && e.target.closest('.recent-chip');
    if (chip){
      e.preventDefault();
      const name = chip.getAttribute('data-agent-name') || chip.getAttribute('title') || '';
      if (name) await openAgentByName(name);
      return;
    }

    const row = e.target.closest && e.target.closest('.lib-row');
    if (row){
      const type = row.getAttribute('data-type');
      const rel  = row.getAttribute('data-rel');
      if (!type || !rel) return;

      e.preventDefault();

      // Carpeta especial “..” → subir un nivel dentro de la sección actual
      if (rel === "..") {
        libraryGoUp();
        return;
      }

      if (type === "dir") {
        // Navegar dentro del árbol de carpetas
        libraryNavigateTo(rel);
      } else {
        // Archivo → que decida libraryOpen (docs / imágenes / video / música)
        libraryOpen(rel);
      }
      return;
    }
  });

  if (libUpBtn) {
    libUpBtn.addEventListener("click", (e)=>{
      e.preventDefault();
      libraryGoUp();
    });
  }

  const debouncedShow = (()=>{
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

  /* ====== ⬇️ CALENDAR (FullCalendar) — protección de refs + listeners ⬇️ ====== */
  // Evita ReferenceError si aún no existen las variables globales:
  if (typeof modeCalendar === "undefined") { window.modeCalendar = document.getElementById("modeCalendar"); }
  if (typeof calNewBtn    === "undefined") { window.calNewBtn    = document.getElementById("calNewBtn"); }
  if (typeof calTodayBtn  === "undefined") { window.calTodayBtn  = document.getElementById("calTodayBtn"); }
  if (typeof calPrevBtn   === "undefined") { window.calPrevBtn   = document.getElementById("calPrevBtn"); }
  if (typeof calNextBtn   === "undefined") { window.calNextBtn   = document.getElementById("calNextBtn"); }
  if (typeof calTitle     === "undefined") { window.calTitle     = document.getElementById("calTitle"); }

  // 📅 Calendar
  if (modeCalendar){
    modeCalendar.addEventListener("click", async (e)=>{
      e.preventDefault();
      await setMode("calendar");
      // cierra el menú Apps si lo tienes abierto:
      document.getElementById("appsMenu")?.classList.add("hidden");
      document.getElementById("modeApps")?.setAttribute("aria-expanded", "false");
      if (typeof currentModeTag !== "undefined" && currentModeTag){
        currentModeTag.textContent = t("modeCalendar");
      }
    });
  }
  if (modeWhiteboard) {
    modeWhiteboard.addEventListener("click", async (e)=>{
      e.preventDefault();
      await setMode("whiteboard");
      document.getElementById("appsMenu")?.classList.add("hidden");
      document.getElementById("modeApps")?.setAttribute("aria-expanded", "false");
    });
  }
  if (modeSpreadsheet) {
    modeSpreadsheet.addEventListener("click", () => {
      showSpreadsheetView();
    });
  }

  // 📄 Documento de texto desde botón global (si lo usas fuera del menú)
  if (modeTextDoc){
    modeTextDoc.addEventListener("click", (e)=> {
      e.preventDefault();
      setMode("textdoc");

      const appsBtn  = document.getElementById("modeApps");
      const appsMenu = document.getElementById("appsMenu");
      appsMenu?.classList.add("hidden");
      appsBtn?.setAttribute("aria-expanded", "false");

      if (typeof currentModeTag !== "undefined" && currentModeTag){
        currentModeTag.textContent = t("modeTextDoc") || "Text document";
      }
    });
  }

  if (modeGames && gamesMenu) {
    modeGames.addEventListener("click", () => {
      gamesMenu.classList.toggle("hidden");
      // opcional: cerrar otros submenús si quieres
    });
  }

  if (modeMinesweeper) {
    modeMinesweeper.addEventListener("click", () => {
      // Cierra el menú Apps al seleccionar el juego
      const appsMenu = document.getElementById("appsMenu");
      if (appsMenu) appsMenu.classList.add("hidden");

      // Cambia de modo a la vista del buscaminas
      setMode("minesweeper");
    });
  }

  calTodayBtn?.addEventListener("click", ()=> { _fc?.today(); calTitle.textContent = _fc?.view?.title || ""; });
  calPrevBtn?.addEventListener("click", ()=> { _fc?.prev();  calTitle.textContent = _fc?.view?.title || ""; });
  calNextBtn?.addEventListener("click", ()=> { _fc?.next();  calTitle.textContent = _fc?.view?.title || ""; });
  // Cambio de vista
  calViewMonth?.addEventListener("click", ()=> {
    _fc?.changeView("dayGridMonth");
    calTitle.textContent = _fc?.view?.title || "";
  });
  calViewWeek?.addEventListener("click", ()=> {
    _fc?.changeView("timeGridWeek");
    calTitle.textContent = _fc?.view?.title || "";
  });
  calViewDay?.addEventListener("click", ()=> {
    _fc?.changeView("timeGridDay");
    calTitle.textContent = _fc?.view?.title || "";
  });
  calViewList?.addEventListener("click", ()=> {
    _fc?.changeView("listWeek");        // si prefieres lista mensual: "listMonth"
    calTitle.textContent = _fc?.view?.title || "";
  });
  calViewMulti?.addEventListener("click", ()=> {
    _fc?.changeView("multiMonthYear");  // requiere @fullcalendar/multimonth
    calTitle.textContent = _fc?.view?.title || "";
  });

  /* ====== ⬆️ CALENDAR (FullCalendar) — fin bloque listeners ⬆️ ====== */
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

// Delegado de clicks en la lista de la Library (carpetas/archivos + “Abrir en el editor”)
document.addEventListener("click", async (e)=>{
  // 1) ¿Botón "Abrir en el editor" (pizarra)?
  const editorBtn = e.target.closest && e.target.closest(".lib-open-editor-btn");
  if (editorBtn) {
    e.preventDefault();
    e.stopPropagation();

    const base = (state.library && state.library.base) || "";
    let rel = editorBtn.getAttribute("data-rel") || "";
    const normRel = rel.replace(/\\/g, "/");

    // Solo tiene sentido en media/images → Paint Image Files
    if (base.startsWith("media/images") && /^Paint Image Files\//i.test(normRel)) {
      const fileName = normRel.split("/").pop() || "";
      const jsonName = fileName.replace(/\.[^.]+$/, "") + ".excalidraw.json";

      state.whiteboardFile = jsonName;
      state._forceReloadWhiteboard = true;
      whiteboardIframeInitialized = false;

      await setMode("whiteboard");
      ensureWhiteboardIframe();
    }

    return;
  }

  // 🚫 Ignorar clicks en restaurar/borrar (los maneja el otro listener global)
  const restoreBtn = e.target.closest && e.target.closest(".lib-restore-btn");
  const deleteBtn  = e.target.closest && e.target.closest(".lib-delete-btn");
  if (restoreBtn || deleteBtn) {
    return;
  }

  // 2) Click normal en una fila de la librería
  const row = e.target.closest && e.target.closest("#libList .lib-row");
  if (!row) return;

  e.preventDefault();

  const base = state.library.base || "docs";
  
  // En la papelera NO navegamos al hacer click en la fila
  if (base === "trash") {
    return;
  }
  const type = row.getAttribute("data-type") || "";
  const rel  = row.getAttribute("data-rel")  || "";

  if (!rel) return;

  // Carpetas → navegar
  if (type === "dir") {
    libraryNavigateTo(rel);
    return;
  }

  // Archivos → abrir con la lógica de docs/media
  libraryOpen(rel);
});


function chooseCategory(catKey){
  state.selectedCategory = catKey;
  if (step0) step0.classList.add("hidden");
  if (step1) step1.classList.remove("hidden");
  if (step2) step2.classList.add("hidden");
  renderCategoryFilters();
  renderAgentsList();
}

function sanitizeWhiteboardName(raw){
  const s = (raw || "").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._]+|[._]+$/g, "");
  return s || "";
}

async function whiteboardFileExists(rawName){
  const safe = sanitizeWhiteboardName(rawName);
  if (!safe) return false;

  const file = `${safe}.excalidraw.json`;
  try {
    const res = await fetch(`${BASE_URL}/api/whiteboard/load?file=${encodeURIComponent(file)}`);
    return res.ok;
  } catch (err) {
    console.warn("[WHITEBOARD] whiteboardFileExists error", err);
    return false;
  }
}

// Devuelve true/false según exista el JSON de Excalidraw
async function whiteboardFileExists(safe) {
  const file = `${safe}.excalidraw.json`;
  try {
    const res = await fetch(
      `${BASE_URL}/api/whiteboard/load?file=${encodeURIComponent(file)}`
    );
    return res.ok;          // true si el backend lo encuentra, false si 404
  } catch (err) {
    console.warn("[WHITEBOARD] whiteboardFileExists error", err);
    return false;
  }
}

function ensureWhiteboardIframe() {
  if (!whiteboardFrame) return;

  // ⚠️ Si ya está inicializado y no hay petición explícita de recarga,
  // NO tocamos el src del iframe. Así evitamos “matar” Excalidraw
  // al cambiar de secciones después de guardar.
  if (whiteboardIframeInitialized && !state._forceReloadWhiteboard) {
    return;
  }

  const theme = getAppTheme();
  const themeParam = `theme=${encodeURIComponent(theme || "light")}`;

  // ⛔️ Ya no pasamos el archivo por la URL. Solo el tema.
  const url = `${BASE_URL}/vendor/excalidraw/index.html?${themeParam}`;

  whiteboardFrame.dataset.src = url;
  whiteboardFrame.src = url;

  whiteboardIframeInitialized = true;
  state._forceReloadWhiteboard = false;
}
// Cargar en el iframe la escena del JSON actual guardado en state.whiteboardFile
async function loadWhiteboardFromCurrentFile() {
  const file = state.whiteboardFile;
  if (!file) {
    console.warn("[WHITEBOARD] No hay whiteboardFile definido; no cargo escena.");
    return;
  }
  if (!whiteboardFrame || !whiteboardFrame.contentWindow) {
    console.warn("[WHITEBOARD] Iframe no listo para recibir la escena.");
    return;
  }

  try {
    const res = await fetch(
      `${BASE_URL}/api/whiteboard/load?file=${encodeURIComponent(file)}`
    );
    if (!res.ok) {
      console.error("[WHITEBOARD] Error HTTP al cargar escena:", res.status);
      return;
    }

    let scene = await res.json();

    // Por si acaso viniera como string JSON (aunque tú lo guardas como objeto)
    if (typeof scene === "string") {
      scene = JSON.parse(scene);
    }

    // Enviamos la escena al iframe para que Excalidraw la aplique
    whiteboardFrame.contentWindow.postMessage(
      {
        type: "OFFLINED_WHITEBOARD_LOAD_SCENE",
        scene
      },
      "*"
    );
  } catch (err) {
    console.error("[WHITEBOARD] Error cargando escena:", err);
  }
}


// 🔁 Click en "Abrir en el editor" de la librería de imágenes (Paint Image Files)
// Usamos fase de captura (true) para interceptar ANTES que el handler de .lib-row
document.addEventListener("click", async (e) => {
  const editorBtn = e.target.closest && e.target.closest(".lib-open-editor-btn");
  if (!editorBtn) return; // No es nuestro botón, dejamos que otros handlers actúen

  // Evitamos que la fila .lib-row procese el click (galería de imágenes)
  e.preventDefault();
  e.stopPropagation();

  try {
    const base = (state.library && state.library.base) || "";
    let rel = editorBtn.getAttribute("data-rel") || "";
    const normRel = rel.replace(/\\/g, "/");

    // Solo actuamos si estamos en media/images y dentro de "Paint Image Files"
    if (!(base.startsWith("media/images") && /^Paint Image Files\//i.test(normRel))) {
      return;
    }

    // Nombre del fichero de imagen (png/jpg/...) → nombre del JSON de Excalidraw
    const fileName = normRel.split("/").pop() || "";
    const jsonName = fileName.replace(/\.[^.]+$/, "") + ".excalidraw.json";

    // Guardamos qué JSON debe cargar el whiteboard
    state.whiteboardFile = jsonName;

    // Forzamos recarga del iframe de Excalidraw
    state._forceReloadWhiteboard = true;
    if (typeof whiteboardIframeInitialized !== "undefined") {
      whiteboardIframeInitialized = false;
    }

    // Cambiamos al modo "whiteboard" (pizarra)
    await setMode("whiteboard");

    // Aseguramos que el iframe se (re)inicializa con el archivo indicado
    if (typeof ensureWhiteboardIframe === "function") {
      ensureWhiteboardIframe();
    }
  } catch (err) {
    console.error("Error al abrir en el editor:", err);
  }
}, true); // 👈 true = fase de captura, se ejecuta antes que el handler de .lib-row

// ==== Whiteboard: botones Nuevo / Guardar ====
if (whiteboardNewBtn) {
  whiteboardNewBtn.addEventListener("click", async (e)=>{
    e.preventDefault();
    console.log("[WHITEBOARD] Click en Nuevo");

    // Confirmación antes de borrar la pizarra
    const ok = await showWhiteboardConfirm("new");
    if (!ok) {
      console.log("[WHITEBOARD] Nuevo cancelado por el usuario");
      return;
    }

    if (!whiteboardFrame || !whiteboardFrame.contentWindow) {
      console.warn("[WHITEBOARD] No hay iframe aún, llamando a ensureWhiteboardIframe()");
      ensureWhiteboardIframe();
      return;
    }

    console.log("[WHITEBOARD] Enviando OFFLINED_WHITEBOARD_REQUEST_RESET al iframe");
    whiteboardFrame.contentWindow.postMessage(
      { type: "OFFLINED_WHITEBOARD_REQUEST_RESET" },
      "*"
    );

    // Limpiar el nombre del dibujo también
    if (whiteboardNameInput) {
      whiteboardNameInput.value = "";
    }
  });
} else {
  console.warn("[WHITEBOARD] whiteboardNewBtn es null (ID no encontrado en el HTML)");
}

if (whiteboardSaveBtn) {
  whiteboardSaveBtn.addEventListener("click", async (e)=>{
    e.preventDefault();
    console.log("[WHITEBOARD] Click en Guardar");

    if (!whiteboardFrame || !whiteboardFrame.contentWindow) {
      console.warn("[WHITEBOARD] No hay iframe aún, llamando a ensureWhiteboardIframe()");
      ensureWhiteboardIframe();
      return;
    }

    // 1) Determinar el nombre del dibujo (input o nombre por defecto)
    const rawName = (whiteboardNameInput && whiteboardNameInput.value || "").trim();
    let finalName = rawName;

    if (!finalName) {
      // Nombre por defecto tipo: 15/11/2025 23:42
      const now = new Date();
      const fmtDate = new Intl.DateTimeFormat(state.lang || "es", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      }).format(now);
      finalName = fmtDate;
      if (whiteboardNameInput) {
        whiteboardNameInput.value = finalName;
      }
    }

    // 2) Mirar si ya existe un archivo con ese nombre en la galería
    let exists = false;
    try {
      exists = await whiteboardFileExists(finalName);
    } catch (err) {
      console.warn("[WHITEBOARD] Error comprobando existencia de archivo", err);
    }

    // 3) Mostrar modal de confirmación (con mensaje distinto si hay overwrite)
    const kind = exists ? "overwrite" : "save";
    const ok = await showWhiteboardConfirm(kind);
    if (!ok) {
      console.log("[WHITEBOARD] Guardado cancelado por el usuario");
      return;
    }

    console.log("[WHITEBOARD] Enviando OFFLINED_WHITEBOARD_REQUEST_EXPORT al iframe con nombre:", finalName);
    whiteboardFrame.contentWindow.postMessage(
      {
        type: "OFFLINED_WHITEBOARD_REQUEST_EXPORT",
        name: finalName
      },
      "*"
    );
  });
} else {
  console.warn("[WHITEBOARD] whiteboardSaveBtn es null (ID no encontrado en el HTML)");
}


// ==== Whiteboard: recepción de exportación desde el iframe ====
window.addEventListener("message", async (event)=>{
  const data = event.data || {};
  if (!data.type) return;

  console.log("[WHITEBOARD] Mensaje recibido desde iframe:", data.type, data);

  // 1) El iframe nos avisa de que está listo
  if (data.type === "OFFLINED_WHITEBOARD_IFRAME_READY") {
    state.whiteboardIframeReady = true;

    // Si hay un archivo asociado (por ejemplo, desde "Abrir en el editor"),
    // cargamos la escena ahora.
    if (state.whiteboardFile) {
      await loadWhiteboardFromCurrentFile();
    }
    return;
  }

  // 2) Resultado de exportar (guardar PNG + JSON)
  if (data.type !== "OFFLINED_WHITEBOARD_EXPORT_RESULT") return;

  // Nombre base para el archivo (el iframe puede mandar uno, o usamos timestamp)
  const name = data.name || `drawing-${Date.now()}`;

  try {
    const res = await fetch(`${BASE_URL}/api/whiteboard/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        pngDataUrl: data.pngDataUrl,   // "data:image/png;base64,...."
        excalidraw: data.excalidraw    // JSON de la escena
      })
    });

    if (res.ok) {
      const json = await res.json().catch(()=>null);

      // Guardamos el nombre del .excalidraw para poder reabrirlo
      if (json?.jsonFile) {
        state.whiteboardFile = json.jsonFile;
      }

      // Aviso al usuario
      if (typeof toast === "function") {
        toast(t("whiteboardSaveToast") || "Whiteboard saved");
      }
    } else {
      console.error("whiteboard save failed", res.status);
    }
  } catch (err) {
    console.error("whiteboard save error", err);
  }
});


// ===== MODE =====
async function setMode(mode){
  saveCurrentScroll();

  // Oculta el botón rápido si cambiamos de sección
  try { hideWikiQuickUI(); } catch {}

  state.mode = mode;
  localStorage.setItem("mode", mode);

  // Refs principales
  const chatContainer = document.getElementById("chatContainer");
  const wikiView      = document.getElementById("wikiView");
  const libraryView   = document.getElementById("libraryView");

  // ✨ SKY & 🗺️ MAPS
  const skyView   = document.getElementById("skyView");
  const modeSky   = document.getElementById("modeSky");
  const mapsView  = document.getElementById("mapsView");
  const modeMaps  = document.getElementById("modeMaps");

  // 🔄 SYNC
  const syncView      = document.getElementById("syncView");

  // 🤝 SUPPORTERS
  const supportersView = document.getElementById("supportersView");

  // Desactivar active en todos los botones de modo (los que existen)
  modeLLM.classList.remove("active");
  modeAgents.classList.remove("active");
  modeWiki.classList.remove("active");
  if (modeLibrary) modeLibrary.classList.remove("active");
  if (modeSky)  modeSky.classList.remove("active");
  if (modeMaps) modeMaps.classList.remove("active");

  // Helpers compactos
  const hide = el => el && el.classList.add("hidden");
  const show = el => el && el.classList.remove("hidden");

  // Oculta TODAS las vistas primero (evita olvidos)
  const resetViews = () => {
    hide(chatContainer);
    hide(wikiView);
    hide(libraryView);
    hide(skyView);
    hide(mapsView);
    hide(supportersView);
    hide(syncView);
    hide(chatView);
    hide(agentsSteps);
    hide(notesView);
    hide(audioNotesView);
    hide(spreadsheetView);
    hide(whiteboardView);
    hide(gamesView);
    hide(textDocView);                      // 🆕 nueva vista de documentos de texto

    const calendarView = document.getElementById("calendarView");
    hide(calendarView);
	
	const skyModal = document.getElementById("skySettingsModal");
    if (skyModal) {
      skyModal.classList.add("hidden");
      skyModal.setAttribute("aria-hidden", "true");
    }

	// reset de layout especiales
	document.documentElement.classList.remove(
	  "full-bleed-library",
	  "full-bleed-supporters",
	  "full-bleed-sky"
	);
    if (_supportersResizeHandler) {
      window.removeEventListener("resize", _supportersResizeHandler);
      _supportersResizeHandler = null;
    }
    // 🖼 Cierra el visor de imágenes (galería) si está abierto
    if (typeof closeImageViewer === "function") {
      try {
        closeImageViewer();
      } catch (e) {
        console.warn("[IMGV] Error al cerrar el visor de imágenes:", e);
      }
    }
    // ⛔️ Detén el watcher del iframe Kiwix al salir de Wiki
    stopWikiUrlWatcher();
  };

  resetViews();
  document.querySelectorAll(".dropdown-menu").forEach(m => m.classList.add("hidden"));

  if (mode === "llm") {
    state.selectedAgent = null;   // ← evita heredar agente anterior
    modeLLM.classList.add("active");

    show(chatContainer);
    show(chatView);
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
      addMessage("bot", t("survivorInit"));
    } else {
      normalizeModelGreeting();
    }
    renderConversation();
    requestAnimationFrame(focusEditor);

  } else if (mode === "agents") {
    modeAgents.classList.add("active");

    show(chatContainer);
    show(chatView);
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

      // (en setMode, rama "agents")
      const k = agentKey(state.selectedAgent);
      if (!state.chats.agents[k] || state.chats.agents[k].length === 0){
        const greet = pickGreeting(state.selectedAgent);
        // ⬇️ solo saludamos si NO venimos de un “encartha-oculto”
        if (!state.skipNextAgentGreeting && greet) {
          addMessage("bot", greet);
        }
        // limpia el flag siempre después
        state.skipNextAgentGreeting = false;
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
    show(wikiView);

    if (selectAgentBtn) selectAgentBtn.classList.add("hidden");
    if (activeProfessionTag) activeProfessionTag.classList.add("hidden");

    try {
      hideWikiQuickUI();

      const iframe = document.getElementById("wikiFrame");

      // Prefer pending URL; else last-visited; else language landing
      let targetUrl = state.wiki.pendingUrl || state.wiki.url;
      if (!targetUrl) {
        const startUrl = await resolveStartUrl(state.lang);
        state.wiki.started = true;
        targetUrl = startUrl;
      }

      if (iframe.src !== targetUrl) iframe.src = targetUrl;

      state.wiki.url = targetUrl;
      state.wiki.pendingUrl = null;

      // Track navigation inside the viewer
      attachWikiFrameTracker();
      startWikiUrlWatcher();     // ✅ start it…
      // (do NOT stop it here)
    } catch (err) {
      console.error(err);
      toast((err && err.message) || t("wikiNotAvailable"));
    }

  } else if (mode === "library") {
    if (modeLibrary) modeLibrary.classList.add("active");

    show(libraryView);
    if (selectAgentBtn) selectAgentBtn.classList.add("hidden");
    if (activeProfessionTag) activeProfessionTag.classList.add("hidden");

    document.documentElement.classList.toggle("full-bleed-library", mode === "library");

    currentModeTag.textContent = t("libModeTag");
    ensureLibToolbarExtras();

    await libraryEnsurePath();
    await libraryListRender();
    return;

  } else if (mode === "sync") {
    show(syncView);

    if (selectAgentBtn) selectAgentBtn.classList.add("hidden");
    if (activeProfessionTag) activeProfessionTag.classList.add("hidden");
    activeAgentTag?.classList.add("hidden");

    if (currentModeTag) {
      currentModeTag.textContent = t("modeMedia") + ": " + t("modeSync");
    }

    await syncEnsurePeersAndList();
    return;

  } else if (mode === "sky") {
    if (modeSky) modeSky.classList.add("active");

    show(skyView);

    if (selectAgentBtn) selectAgentBtn.classList.add("hidden");
    if (activeProfessionTag) activeProfessionTag.classList.add("hidden");
    activeAgentTag?.classList.add("hidden");

    if (currentModeTag) currentModeTag.textContent = t("modeSky");

    // Layout tipo full-bleed (como mapas / supporters)
    document.documentElement.classList.add("full-bleed-sky");

    // Inicializar contenedor y d3-celestial
    ensureSkyCanvas();
    initSkyOnce();
    refreshSky();
    setupSkySettingsSidebar();

    return;

  } else if (mode === "maps") {
    if (modeMaps) modeMaps.classList.add("active");

    show(mapsView);

    if (selectAgentBtn) selectAgentBtn.classList.add("hidden");
    if (activeProfessionTag) activeProfessionTag.classList.add("hidden");
    activeAgentTag?.classList.add("hidden");

    currentModeTag.textContent = t("modeMaps");

    const canvas = ensureMapCanvas();
    const placeholder = mapsView ? mapsView.querySelector('.empty-state') : null;

    try {
      if (placeholder) placeholder.style.display = 'none';
      if (canvas) canvas.style.display = 'block';

      await initOfflineMap();
      if (_map) _map.resize();

      // 🆕 Panel de búsqueda + favoritos
      ensureMapsSearchPanel();
    } catch (err) {
      console.error('Error iniciando mapas:', err);
      if (canvas) canvas.style.display = 'none';
      if (placeholder) {
        placeholder.style.display = 'block';
        paintMapsPlaceholderV2();
      }
    }
    return;

  } else if (mode === "supporters") {
    // El botón está en footer, no marcamos "active" en header
    show(supportersView);

    if (selectAgentBtn) selectAgentBtn.classList.add("hidden");
    if (activeProfessionTag) activeProfessionTag.classList.add("hidden");
    activeAgentTag?.classList.add("hidden");

    currentModeTag.textContent = t("modeSupportersTag");

    // 💥 ancho completo + alto usable + scroll
    document.documentElement.classList.add("full-bleed-supporters");
    ensureSupportersLayout();
    _supportersResizeHandler = () => ensureSupportersLayout();
    window.addEventListener("resize", _supportersResizeHandler, { passive: true });

    // cargar SIEMPRE del backend para reflejar cambios del JSON
    await fetchSupporters();
    renderSupporters();
    return;

  } else if (mode === "notes") {
    localStorage.setItem("mode", "notes");
    chatContainer.classList.add("hidden");
    wikiView.classList.add("hidden");
    libraryView.classList.add("hidden");
    notesView.classList.remove("hidden");
    currentModeTag.textContent = t("modeNotes");

    await ensureQuill();
    await loadNotes();       // ⬅ ahora es async y pide al backend
    renderNotesList();
    if (state.notes.activeId) {
      openNote(state.notes.activeId);  // cargamos contenido de la activa
    }
    return;

  } else if (mode === "audio-notes") {
    localStorage.setItem("mode", "audio-notes");
    hide(chatContainer);
    hide(wikiView);
    hide(libraryView);
    show(audioNotesView);

    if (selectAgentBtn) selectAgentBtn.classList.add("hidden");
    if (activeProfessionTag) activeProfessionTag.classList.add("hidden");
    activeAgentTag?.classList.add("hidden");

    if (currentModeTag) currentModeTag.textContent = t("modeAudioNotes");

    await loadAudioNotes();
    renderAudioNotesList();
    if (state.audioNotes.activeId) {
      openAudioNote(state.audioNotes.activeId);   // esto ya pone readonly
    } else {
      if (audioPlayer) {
        audioPlayer.removeAttribute("src");
        audioPlayer.load();
      }
      // Sin nota -> modo nueva grabación
      setAudioUiMode("new");
    }
    return;

  } else if (mode === "calendar") {
    localStorage.setItem("mode", "calendar");
    document.documentElement.classList.add("full-bleed-calendar");
    const calendarView = document.getElementById("calendarView");
    show(calendarView);
    currentModeTag.textContent = t("modeCalendar");
    await ensureCalendar();
    return;

  } else if (mode === "whiteboard") {
    localStorage.setItem("mode", "whiteboard");

    resetViews();

    if (modeWhiteboard) modeWhiteboard.classList.add("active");

    if (currentModeTag) currentModeTag.textContent = t("modeWhiteboard");
    if (whiteboardTitle) whiteboardTitle.textContent = t("whiteboardTitle");

    show(whiteboardView);
    ensureWhiteboardIframe();
    return;

  } else if (mode === "textdoc") {
    // 🆕 NUEVO MODO: Documento de texto (Univer v4)
    localStorage.setItem("mode", "textdoc");

    // Mostrar sólo la vista de documento de texto (el resto ya está oculto por resetViews)
    show(textDocView);

    // Ocultar cosas de agentes
    if (selectAgentBtn) selectAgentBtn.classList.add("hidden");
    if (activeProfessionTag) activeProfessionTag.classList.add("hidden");
    if (activeAgentTag) activeAgentTag.classList.add("hidden");

    if (currentModeTag) {
      currentModeTag.textContent = t("modeTextDoc") || "Text document";
    }

    // Pinta el placeholder traducido si la función existe
    if (typeof paintTextDocPlaceholder === "function") {
      paintTextDocPlaceholder();
    }

    return;

  } else if (mode === "spreadsheet") {
    localStorage.setItem("mode", "spreadsheet");

    // Ocultar vistas principales
    chatContainer.classList.add("hidden");
    wikiView.classList.add("hidden");
    libraryView.classList.add("hidden");
    notesView.classList.add("hidden");
    const calendarView = document.getElementById("calendarView");
    if (calendarView) calendarView.classList.add("hidden");

    // Mostrar Hoja de Cálculo
    if (spreadsheetView) spreadsheetView.classList.remove("hidden");

    // Ocultar cosas de agentes
    if (selectAgentBtn) selectAgentBtn.classList.add("hidden");
    if (activeProfessionTag) activeProfessionTag.classList.add("hidden");
    if (activeAgentTag) activeAgentTag.classList.add("hidden");

    if (currentModeTag) currentModeTag.textContent = t("modeSpreadsheet");
    return;

  } else if (mode === "minesweeper") {
    localStorage.setItem("mode", "minesweeper");

    // Ocultar vistas principales
    chatContainer.classList.add("hidden");
    wikiView.classList.add("hidden");
    libraryView.classList.add("hidden");
    notesView.classList.add("hidden");
    const calendarView = document.getElementById("calendarView");
    if (calendarView)     calendarView.classList.add("hidden");
    if (whiteboardView)   whiteboardView.classList.add("hidden");
    if (spreadsheetView)  spreadsheetView.classList.add("hidden");

    // Mostrar vista Juegos / Buscaminas
    if (gamesView) gamesView.classList.remove("hidden");
    // Sincronizar tema actual con el iframe de Buscaminas
    syncGamesTheme();
    // Ocultar elementos de agentes
    if (selectAgentBtn)    selectAgentBtn.classList.add("hidden");
    if (activeProfessionTag) activeProfessionTag.classList.add("hidden");
    if (activeAgentTag)    activeAgentTag.classList.add("hidden");

    // Texto del modo actual (puedes poner el título del juego)
    if (currentModeTag) currentModeTag.textContent = t("gameMinesweeper");

    return;
  }

  // Actualiza barra de agentes recientes
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
    toast(t("agentsLoadError"));
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


async function previewAgent(agent){
  state.selectedAgent = agent;
  step1.classList.add("hidden");
  step2.classList.remove("hidden");

  const avatarHTML = agent.avatar
    ? `<img src="${agent.avatar}" class="large-avatar" alt="${escapeHTML(agent.name)}"/>`
    : `<div class="large-avatar">${initials(agent.name)}</div>`;

  // Cargar y renderizar el .md de la bio
  const md = await loadAgentMarkdown(agent);
  const bioHTML = renderMarkdown(md);

  // ⚠️ Mostramos SOLO avatar + markdown
  agentPreview.innerHTML = `
    ${avatarHTML}
    <div class="agent-bio markdown">${bioHTML}</div>
  `;
}

// ===== SUPPORTERS =====
async function fetchSupporters(){
  try{
    // 1) intenta API backend; 2) fallback a JSON estático en /frontend/supporters.json
    const lang2 = (state.lang || "en").slice(0,2).toLowerCase();
    let res = await fetch(`${BASE_URL}/api/supporters?lang=${encodeURIComponent(lang2)}`);
    if (!res.ok) res = await fetch("supporters.json");

    const data = await res.json();
    state.supporters = {
      order: Array.isArray(data.order) ? data.order : [],
      labels: data.labels || {},
      items: Array.isArray(data.items) ? data.items : []
    };
    console.log("Supporters loaded:", state.supporters.items.length);
  }catch(e){
    console.error("Supporters error:", e);
    state.supporters = { order: [], labels: {}, items: [] };
  }
}

function labelForCat(key){
  const lbl = (state.supporters.labels && state.supporters.labels[key]) || null;
  if (lbl) return lbl;
  const map = {
    creators: "cat_creators",
    promoters: "cat_promoters",
    collaborators: "cat_collaborators",
    donors: "cat_donors",
    funders: "cat_funders"
  };
  return t(map[key] || key);
}

// 👇 Meta por grupo (título, emoji, descripción) con i18n (en/es/fr/pt)
function getSupporterGroupMeta(key) {
  const lang = (state.lang || "en").slice(0,2).toLowerCase();

  const T = {
    creators: {
      emoji: "👥",
      title: { es: "Creadores", en: "Creators", fr: "Créateurs", pt: "Criadores" },
      desc: {
        es: "Personas que concibieron y diseñaron el proyecto, alineando la visión de una IA offline para supervivencia. Definieron la arquitectura, el estilo y el propósito social del software, y tomaron decisiones para mantenerlo simple, robusto y útil en situaciones críticas. Además, documentaron los principios del proyecto en GitHub para que cualquiera pueda descargarlo y unirse para colaborar. Añadimos también que no somos nada expertos en este tema, es nuestro primer desarrollo; por tanto, ¡toda ayuda es bien recibida!",
        en: "People who conceived and designed the project, aligning the vision of an offline AI for survival. They defined the architecture, style, and social purpose of the software, and made decisions to keep it simple, robust, and useful in critical situations. They also documented the project principles on GitHub so anyone can download it and join to collaborate. We also add that we’re not experts in this field—this is our first development—so any help is welcome!",
        fr: "Personnes qui ont conçu et imaginé le projet, en alignant la vision d’une IA hors ligne pour la survie. Elles ont défini l’architecture, le style et la finalité sociale du logiciel, et ont pris des décisions pour le garder simple, robuste et utile en situation critique. Elles ont aussi documenté les principes du projet sur GitHub afin que chacun puisse le télécharger et collaborer. Nous ajoutons que nous ne sommes pas experts—c’est notre premier développement—toute aide est la bienvenue !",
        pt: "Pessoas que idealizaram e desenharam o projeto, alinhando a visão de uma IA offline para sobrevivência. Definiram a arquitetura, o estilo e o propósito social do software, tomando decisões para mantê-lo simples, robusto e útil em situações críticas. Além disso, documentaram os princípios do projeto no GitHub para que qualquer pessoa possa baixar e colaborar. Acrescentamos também que não somos especialistas—este é o nosso primeiro desenvolvimento—por isso, toda ajuda é bem-vinda!"
      }
    },
    funders: {
      emoji: "💎",
      title: { es: "Financiadores", en: "Funders", fr: "Financeurs", pt: "Financiadores" },
      desc: {
        es: "Entidades y personas que aportaron recursos económicos para avanzar sin depender de internet o servicios externos. Su apoyo permitió continuar con el proyecto, evolucionarlo y darle mayor alcance. Damos especialmente las gracias a...",
        en: "Entities and individuals who provided financial resources to move forward without relying on the internet or external services. Their support allowed the project to continue, evolve, and reach a wider audience. Special thanks to...",
        fr: "Entités et personnes ayant apporté des ressources financières pour avancer sans dépendre d’Internet ni de services externes. Leur soutien a permis de poursuivre le projet, de le faire évoluer et d’en élargir la portée. Merci en particulier à...",
        pt: "Entidades e pessoas que forneceram recursos financeiros para avançar sem depender da internet ou de serviços externos. O seu apoio permitiu que o projeto continuasse, evoluísse e alcançasse um público mais amplo. Agradecimentos especiais a..."
      }
    },
    promoters: {
      emoji: "📣",
      title: { es: "Promotores", en: "Promoters", fr: "Promoteurs", pt: "Promotores" },
      desc: {
        es: "Difunden el proyecto en redes y comunidades, ayudando a que llegue a quienes más lo necesitan. ¡Gracias por vuestro esfuerzo, amigos!",
        en: "They spread the project across networks and communities, helping it reach those who need it most. Thank you for your effort, friends!",
        fr: "Ils diffusent le projet sur les réseaux et dans les communautés, aidant à le faire parvenir à celles et ceux qui en ont le plus besoin. Merci pour vos efforts, les amis !",
        pt: "Divulgam o projeto em redes e comunidades, ajudando a que chegue a quem mais precisa. Obrigado pelo vosso esforço, amigos!"
      }
    },
    donors: {
      emoji: "🎁",
      title: { es: "Donantes", en: "Donors", fr: "Donateurs", pt: "Doadores" },
      desc: {
        es: "Donaciones que mantienen viva nuestra ilusión por seguir con el proyecto. Cada grano de arena importa. Muchísimas gracias por todas y cada una de vuestras donaciones—sin vosotros no estaríamos aquí evolucionando.",
        en: "Donations that keep our motivation alive to continue the project. Every grain of sand matters. Thank you very much for each and every one of your donations—without you, we wouldn’t be here evolving.",
        fr: "Des dons qui maintiennent notre motivation à poursuivre le projet. Chaque grain de sable compte. Merci beaucoup pour chacune de vos contributions—sans vous, nous ne serions pas ici à évoluer.",
        pt: "Doações que mantêm viva a nossa motivação para continuar o projeto. Cada pequeno gesto conta. Muito obrigado por cada uma das vossas doações—sem vocês, não estaríamos aqui a evoluir."
      }
    },
    collaborators: {
      emoji: "🤝",
      title: { es: "Colaboradores", en: "Collaborators", fr: "Collaborateurs", pt: "Colaboradores" },
      desc: {
        es: "Aportaciones puntuales: revisión de código, avatares, traducciones, test de instaladores e ideas prácticas. ¡Muchísimas gracias por vuestro apoyo!",
        en: "Occasional contributions: code review, avatars, translations, installer testing, and practical ideas. Many thanks for your support!",
        fr: "Contributions ponctuelles : relecture de code, avatars, traductions, tests d’installateur et idées pratiques. Un grand merci pour votre soutien !",
        pt: "Contribuições pontuais: revisão de código, avatares, traduções, testes de instaladores e ideias práticas. Muito obrigado pelo vosso apoio!"
      }
    },
    thanks: {
      emoji: "🙏",
      title: { es: "Agradecimientos", en: "Thanks to", fr: "Remerciements", pt: "Agradecimentos" },
      desc: {
        es: "Gracias a todos los desarrolladores que estáis detrás de estos proyectos por hacerlo posible. Nunca habría pensado, hasta conoceros, que el proyecto que tenía en mente fuera tan fácil gracias a vosotros.",
        en: "Thanks to all the developers behind these projects for making this possible. I would never have thought, until I met you, that the project I had in mind could be so easy thanks to you.",
        fr: "Merci à tous les développeurs derrière ces projets de les avoir rendus possibles. Je n’aurais jamais pensé, avant de vous connaître, que le projet que j’avais en tête serait si facile grâce à vous.",
        pt: "Obrigado a todos os programadores por trás destes projetos por torná-los possíveis. Nunca imaginei, até vos conhecer, que o projeto que tinha em mente pudesse ser tão simples graças a vocês."
      }
    }
  };

  const fallback = { es: key, en: key, fr: key, pt: key };
  const m = T[key] || { emoji: "🧩", title: fallback, desc: { es: "", en: "", fr: "", pt: "" } };
  const title = (m.title && (m.title[lang] || m.title.en || m.title.es || m.title.fr || key)) || key;
  const desc  = (m.desc  && (m.desc[lang]  || m.desc.en  || m.desc.es  || m.desc.fr  || "" )) || "";
  return { emoji: m.emoji || "🧩", title, desc };
}


// 👇 NUEVO: helpers de tarjetas
function buildCreatorCard(s){
  const initials = (name)=>{
    const parts = String(name||"").trim().split(/\s+/).slice(0,2);
    return parts.map(p=>p[0]?.toUpperCase()||"").join("");
  };
  const avatar = s.avatar ? `<img src="${absolutizeAsset(s.avatar)}" alt="${escapeHTML(s.name)}"/>`
                          : `<span class="initials">${escapeHTML(initials(s.name))}</span>`;
  const role = s.role || s.desc || "Co-Creator";
  return `
    <div class="creator-card">
      <div class="creator-avatar">${avatar}</div>
      <div class="creator-meta">
        <div class="creator-name">${escapeHTML(s.name||"")}</div>
        <div class="creator-role">${escapeHTML(role)}</div>
      </div>
    </div>`;
}

function buildFunderCard(s){
  const tier = (s.tier || "silver").toLowerCase();
  const logo = s.logo ? `<div class="supporter-logo"><img src="${absolutizeAsset(s.logo)}" alt="${escapeHTML(s.name||"")}" loading="lazy"></div>` : "";
  const name = s.url
    ? `<a href="${s.url}" target="_blank" rel="noopener sponsored nofollow">${escapeHTML(s.name||"")}</a>`
    : `<span>${escapeHTML(s.name||"")}</span>`;
  const desc = s.desc ? `<div class="supporter-desc">${escapeHTML(s.desc)}</div>` : "";
  return `<div class="supporter-card tier-${tier}">${logo}<div class="supporter-name">${name}</div>${desc}</div>`;
}

function buildTextOnlyCard(s, opts = {}){
  const name = s.url
    ? `<a href="${s.url}" target="_blank" rel="noopener nofollow">${escapeHTML(s.name||"")}</a>`
    : `<span>${escapeHTML(s.name||"")}</span>`;
  const showDesc = !opts.noDesc && !!s.desc;
  const desc = showDesc ? `<div class="supporter-desc">${escapeHTML(typeof s.desc==='string' ? s.desc : (s.desc?.[state.lang] || s.desc?.en || ""))}</div>` : "";
  return `<div class="supporter-card text-only"><div class="supporter-name">${name}</div>${desc}</div>`;
}

function buildPromoterCircle(s){
  const name = String(s.name || "");
  const logo = s.logo || s.img || "";
  const initials = name.split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase() || "★";
  const inner = logo
    ? `<img src="${absolutizeAsset(logo)}" alt="${escapeHTML(name)}" loading="lazy">`
    : `<span class="initials">${initials}</span>`;

  return `
    <div class="promoter-item">
      <div class="supporter-card promoter">
        <div class="promoter-avatar">${inner}</div>
      </div>
      <div class="supporter-name">${escapeHTML(name)}</div>
    </div>`;
}

function buildFunderAsCreatorStyle(it){
  const initials = (it.name||"").trim().split(/\s+/).map(s=>s[0]).slice(0,2).join("").toUpperCase();
  const hasLogo = !!it.logo;
  const avatar = hasLogo
    ? `<img src="${absolutizeAsset(it.logo)}" alt="${escapeHTML(it.name||"")}">`
    : `<span class="initials">${escapeHTML(initials || "?")}</span>`;
  const role = (typeof it.desc==='string' ? it.desc : (it.desc?.[state.lang] || it.desc?.en || "")) || "";
  const desc = role ? `<div class="creator-role">${escapeHTML(role)}</div>` : "";
  return `<div class="creator-card supporter-card tier-${(it.tier||'').toLowerCase()}">
    <div class="creator-avatar">${avatar}</div>
    <div class="creator-meta">
      <div class="creator-name">${escapeHTML(it.name || "")}</div>
      ${desc}
    </div>
  </div>`;
}

function buildCollaboratorsLine(list){
  if (!list || !list.length) return "";
  const names = list.map(s => escapeHTML(s.name||"")).join(" - ");
  return names;
}


// ✅ REEMPLAZA toda tu función por ésta
function renderSupporters(){
  const wrap = document.getElementById("supportersContent");
  if (!wrap) return;

  const { order = [], items = [] } = state.supporters || {};
  if (!items.length){
    wrap.innerHTML = `<div class="muted">${t("noSupporters")}</div>`;
    return;
  }

  // Agrupar por tipo
  const tierRank = { bronze:1, silver:2, gold:3, platinum:4, diamond:5 };
  const groups = {};
  for (const it of items){
    const k = it.type || "collaborators";
    if (!groups[k]) groups[k] = [];
    groups[k].push(it);
  }
  // Orden interno: por tier y nombre
  for (const k of Object.keys(groups)){
    groups[k].sort((a,b)=>{
      const ta = tierRank[(a.tier||"").toLowerCase()] || 0;
      const tb = tierRank[(b.tier||"").toLowerCase()] || 0;
      return (tb - ta) || String(a.name||"").localeCompare(String(b.name||""));
    });
  }

  const orderList = order.length ? order : ["creators","funders","promoters","donors","collaborators"]
    .filter(k => groups[k]?.length);

  wrap.innerHTML = orderList.map(k=>{
    const list = groups[k] || [];
    if (!list.length) return "";

    const meta = getSupporterGroupMeta(k);
    const heading = `
      <h3><span class="emoji">${meta.emoji}</span> ${escapeHTML(meta.title)}</h3>
      ${meta.desc ? `<p class="group-desc">${escapeHTML(meta.desc)}</p>` : ""}`;

    if (k === "creators") {
      const cards = list.map(buildCreatorCard).join("");
      return `<section class="supporters-group supporters-group--${k} creators" id="sg-${k}">
        ${heading}
        <div class="creators-row">${cards}</div>
      </section>`;
    }

if (k === "funders") {
  const v = (n) => list.filter(it => (Number(it.variant) || 1) === n);

  const htmlV1 = v(1).map(buildFunderCard).join("");           // grid con logos
  const htmlV2 = v(2).map(buildFunderAsCreatorStyle).join(""); // estilo creators

  // tamaños deseados
  const SIZE_CREATORS = "17px"; // = creators-name
  const SIZE_SUPPORT  = "12px"; // = supporter.name

  // NOTA: cubrimos varios posibles nombres de clase para el título
  // (.name, .card-title, .supporter-name). Si tu builder usa otro, añádelo aquí.
  const inlineStyles = `
    <style>
      /* Variant 1 -> mismo tamaño que creators-name (17px) */
      #sg-funders .funders-v1 .name,
      #sg-funders .funders-v1 .card-title,
      #sg-funders .funders-v1 .supporter-name { font-size: ${SIZE_CREATORS} !important; }

      /* Variant 2 -> mismo tamaño que supporter.name (12px) */
      #sg-funders .funders-v2 .name,
      #sg-funders .funders-v2 .card-title,
      #sg-funders .funders-v2 .supporter-name { font-size: ${SIZE_SUPPORT} !important; }
    </style>
  `;

  return `
    <section class="supporters-group supporters-group--${k} funders" id="sg-funders" data-type="funders">
      ${inlineStyles}
      ${heading}
      ${htmlV1 ? `
        <div class="variant-block v1" data-type="funders" data-variant="1">
          <div class="supporters-grid funders-v1">${htmlV1}</div>
        </div>` : ""}
      ${htmlV2 ? `
        <div class="variant-block v2" data-type="funders" data-variant="2">
          <div class="creators-row funders-v2">${htmlV2}</div>
        </div>` : ""}
    </section>`;
}


	
	// THANKS TO → como grid de logos (mismo builder que funders tipo 1)
	if (k === "thanks") {
	  const cards = (groups[k] || []).map(buildFunderCard).join("");
	  return `<section class="supporters-group supporters-group--thanks thanks" id="sg-${k}">
		${heading}
		<div class="supporters-grid">${cards}</div>
	  </section>`;
	}


    // PROMOTERS → círculo con imagen + nombre debajo
if (k === "promoters") {
  const cards = list.map(buildPromoterCircle).join("");
  return `<section class="supporters-group supporters-group--promoters promoters" id="sg-${k}">
    ${heading}
    <div class="supporters-grid promoters-grid">${cards}</div>
  </section>`;
}

// DONORS → se queda como texto (sin imagen)
if (k === "donors") {
  const cards = list.map(buildTextOnlyCard).join("");
  return `<section class="supporters-group supporters-group--donors donors" id="sg-${k}">
    ${heading}
    <div class="supporters-grid">${cards}</div>
  </section>`;
}


    // colaboradores: listado centrado con guiones
    if (k === "collaborators") {
      const names = list.map(s => escapeHTML(s.name||"")).join(" - ");
      return `<section class="supporters-group collaborators" id="sg-${k}">
        ${heading}
        <div class="collab-list">${names}</div>
      </section>`;
    }

    // fallback (grid normal)
    const cards = list.map(buildTextOnlyCard).join("");
    return `<section class="supporters-group supporters-group--${k} ${k}" id="sg-${k}">
      ${heading}
      <div class="supporters-grid">${cards}</div>
    </section>`;
  }).join("");
}


// ===== CHAT =====
function trySend(){
  const text = input.value.trim();
  if(!text || state.typing) return;

  input.value = "";

  addMessage("user", text);
  sendToBackend(text);

  requestAnimationFrame(focusEditor);
}

async function sendToBackend(userText, opts = {}) {
  const started = performance.now();
  setBusy(true);

  const payload = { message: userText, lang: state.lang };
  if (state.mode === "agents" && state.selectedAgent) {
    payload.agent = state.selectedAgent;
  }

  if (state.mode === "agents" && isEncarthaActive()) {
    const encarthaMode = opts.encarthaMode || "wiki"; // "wiki" (por defecto) | "def"
    if (encarthaMode === "def") {
      payload.agent = { name: state.selectedAgent?.name || "Michael Encartha", role: "encartha-def" };
    } else {
      let catalog = { items: [], categories: [] };
      try { catalog = await fetch(`${BASE_URL}/api/taxonomy/catalog`).then(r => r.json()); } catch {}
      payload.agent = { name: state.selectedAgent?.name || "Michael Encartha", role: "wiki-encartha" };
      payload.encartha = {
        lang: state.lang,
        catalog: catalog.items || [],
        categories: catalog.categories || []
      };
    }
  }

  let typingBubble, typingIdx, stopSpin;

  try {
    const arr = currentThreadArray();

    // 1) bubble "typing"  (✅ NO wiki en typing)
    typingBubble = addMessage("bot", `${t("typing")} |`, { __noWiki: true });
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

    // Asegura perfiles (por si queremos enriquecer avatar/profesión desde local)
    if (!state.agents || !state.agents.length) {
      try { await fetchAgents(); } catch {}
    }

    // --- TEXTO crudo del backend
    const replyRaw = (data && data.response) ? String(data.response) : "(empty response)";
    let replyClean = sanitizeAgentMarkup(replyRaw);

    // === DEBUG LaTeX/Markdown ===
    console.groupCollapsed("🧪 DEBUG CHAT RESPONSE");
    console.log("RAW (data.response):", replyRaw);
    console.log("CLEAN (after sanitizeAgentMarkup):", replyClean);
    console.groupEnd();

    // 4) métricas
    const ms = Math.max(0, Math.round(performance.now() - started));
    if (typeof latency !== "undefined" && latency) latency.textContent = `⏱️ ${ms} ms`;
    if (typeof tokenEst !== "undefined" && tokenEst) tokenEst.textContent = `🧮 ~${estimateTokens(replyClean)} tokens`;

    // 5) pintar respuesta definitiva (con typing effect)
    if (stopSpin) stopSpin();
    await typeMessage(replyClean, typingBubble);
    if (typingIdx != null) arr[typingIdx].text = replyClean;

    // ✅ NEW: Wikipedia links + hint como mensaje separado (post-render)
    setTimeout(() => {
      if (!typingBubble) return;

      // Forzar recalcular (typing cambia el DOM a trozos)
      typingBubble.dataset.wikiHash = "";

      WikiLinker.decorateBubble(typingBubble, state.lang)
        .then(() => {
          // ✅ ahora el hint es un mensaje nuevo del bot (avatar + bubble)
          WikiHint.pushFromBubble(typingBubble, state.lang);
        })
        .catch(() => {});
    }, 0);

    // ——— 5.1 Acciones UI Encartha (si vienen del backend) ———
    if (isEncarthaActive() && data && data.meta && data.meta.encartha_ui && Array.isArray(data.meta.encartha_ui.actions)) {
      addMessage("bot", renderEncarthaNavFooter(""), { asHTML: true, __noWiki: true });
      encarthaBindButtons();
    }

    // 6) Vanilla chat: sin post-procesado adicional
    // (no-op)

  } catch (err) {
    if (stopSpin) stopSpin();
    const msg = `⚠️ ${err.message}`;

    if (typingBubble) {
      typingBubble.innerHTML = renderMarkdown(msg);
      typesetMath(typingBubble); // ✅ también en errores

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
  if (opts.asHTML) msg.__html = true;
  if (opts.__wikiInfo) msg.__wikiInfo = true;

  // ✅ NEW: flags para no relinkear / para identificar el aviso
  if (opts.__noWiki) msg.__noWiki = true;
  if (opts.__wikiHint) msg.__wikiHint = true;

  arr.push(msg);
  return renderRow(who, text, msg);
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

  // ✅ KaTeX SOLO al final (evita recalcular en cada frame)
  typesetMath(bubble);

  chat.scrollTop = chat.scrollHeight;
  state.typing = false;
}


// --- Encartha: tipeo progresivo de HTML (recursivo, real) ---
async function typeHTMLIntoBubble(html, bubble, opts = {}) {
  const elementDelay = Number(opts.elementDelay ?? (state.encarthaDelays?.element ?? 80));
  const charDelay    = Number(opts.charDelay    ?? (state.encarthaDelays?.char    ?? 12));

  const tmp = document.createElement("div");
  tmp.innerHTML = html;

  async function renderNode(node, target) {
    // Texto → letra a letra
    if (node.nodeType === Node.TEXT_NODE) {
      const span = document.createElement("span");
      target.appendChild(span);
      await typeTextInto(span, node.textContent || "", charDelay, (state.encarthaDelays && state.encarthaDelays.mode) || "char");
      chat.scrollTop = chat.scrollHeight;
      return;
    }

    // Elemento → lo montamos vacío y procesamos hijos
    if (node.nodeType === Node.ELEMENT_NODE) {
      const shell = node.cloneNode(false);
      target.appendChild(shell);
      chat.scrollTop = chat.scrollHeight;

      const children = Array.from(node.childNodes);

      // Si sólo tiene texto, lo tecleamos; si no, recorremos hijos recursivamente
      if (children.every(n => n.nodeType === Node.TEXT_NODE)) {
        await typeTextInto(shell, node.textContent || "", charDelay, (state.encarthaDelays && state.encarthaDelays.mode) || "char");
      } else {
        for (const child of children) {
          await renderNode(child, shell);
          await sleep(elementDelay);
        }
      }
    }
  }

  // Recorremos los nodos de primer nivel del HTML origen
  for (const child of Array.from(tmp.childNodes)) {
    await renderNode(child, bubble);
    await sleep(elementDelay);
  }

  try { encarthaBindButtons(); } catch {}
}


// Reemplaza esta función por completo
async function typeTextInto(el, fullText, delay, granularity){
  el.textContent = ""; // empezamos vacío

  const mode = granularity || (state.encarthaDelays && state.encarthaDelays.mode) || "char";

  // ✅ MODO PALABRA: añade tokens (palabras y espacios) uno a uno
  if (mode === "word") {
    // Conserva espacios/ saltos de línea separándolos como tokens propios
    const tokens = String(fullText).match(/\S+|\s+/g) || [];
    for (const tok of tokens) {
      el.textContent += tok;
      if (typeof chat !== "undefined" && chat) chat.scrollTop = chat.scrollHeight;
      await sleep(delay);
    }
    return;
  }

  // (modo por defecto) carácter a carácter
  for (const ch of String(fullText)) {
    el.textContent += ch;
    if (typeof chat !== "undefined" && chat) chat.scrollTop = chat.scrollHeight;
    await sleep(delay);
  }
}


// Azúcar: decide si es texto plano o markup y aplica el tipeo correcto
async function encarthaReply(content, opts = {}){
  const isHTML = /<[^>]+>/.test(String(content));
  if (isHTML){
    const bubble = addMessage("bot", "", { asHTML: true }); // crea fila y bubble vacía
    bubble.innerHTML = "";                                  // importante: vacío inicial
    await typeHTMLIntoBubble(content, bubble, opts);
    // ⬇️ NUEVO: persistimos el HTML final en el último mensaje del hilo
    const arr = currentThreadArray();
    if (arr && arr.length) arr[arr.length - 1].text = bubble.innerHTML;
  } else {
    const bubble = addMessage("bot", "");
    await typeMessage(String(content), bubble);
  }
}

function renderEncarthaHintsMultiline(){
  const t = (key)=> (I18N[state.lang] && I18N[state.lang][key]) || key;
  return `
    <div class="encartha-hints" style="margin:8px 0 12px 0; line-height:1.35; font-size: .80rem;">
      <p style="margin:4px 0;">${t("encartha_hint_open")}</p>
      <p style="margin:4px 0;">${t("encartha_hint_expand")}</p>
      <p style="margin:4px 0;">${t("encartha_hint_article")}</p>
      <p style="margin:4px 0;">${t("encartha_hint_resume")}</p>
    </div>
  `;
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

function extractMath(text) {
  const blocks = [];
  let idx = 0;

  // Display math $$...$$ (multiline seguro)
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => {
    const key = `§§MATHBLOCK${idx}§§`;
    blocks.push({ key, expr, display: true });
    idx++;
    return key;
  });

  // Inline math $...$
  text = text.replace(/\$([^\$\n]+?)\$/g, (_, expr) => {
    const key = `§§MATHINLINE${idx}§§`;
    blocks.push({ key, expr, display: false });
    idx++;
    return key;
  });

  return { text, blocks };
}

function renderMathBlocks(blocks) {
  const rendered = {};

  for (const b of blocks) {
    try {
      rendered[b.key] = katex.renderToString(b.expr, {
        displayMode: b.display,
        throwOnError: false,
      });
    } catch (e) {
      console.warn("KaTeX error:", e);
      rendered[b.key] = b.expr; // fallback seguro
    }
  }

  return rendered;
}

function renderMarkdown(mdText = "") {
  if (!mdText) return "";

  // Bloquear HTML crudo del modelo
  const escapeHTML = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[ch]));

  mdText = String(mdText || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  
  mdText = mdText.replace(
    /(^|\n)\$\s*\n([\s\S]*?)\n\s*\$(?=\n|$)/g,
    (m, pre, body) => `${pre}$$\n${body}\n$$`
  );

  // ==================================================
  // (A) NORMALIZACIÓN LaTeX (TU CÓDIGO ORIGINAL)
  // ==================================================

  // 1) \$$ ... \$$  ->  $$ ... $$
  mdText = mdText.replace(/\\\$\$([\s\S]*?)\\\$\$/g, (m, body) => `$$${body}$$`);

  // 2) \$ ... \$ -> $ ... $ (solo si parece LaTeX)
  mdText = mdText.replace(/\\\$([\s\S]*?)\\\$/g, (m, body) => {
    const b = String(body || "");
    const looksLatex =
      /\\[A-Za-z]+|[\^_{}]|\\,|\\tfrac|\\frac|\\sum|\\int|\\begin|\\left|\\right|\\\\/.test(b);
    return looksLatex ? `$${b}$` : m;
  });

  // 3) BUG $$2pt]  -> \\[2pt]
  mdText = mdText.replace(/\$\$([0-9.]+pt\])/g, "\\\\[$1");
  mdText = mdText.replace(/\\\$\$([0-9.]+pt\])/g, "\\\\[$1");

  // 4) Evitar indentación que rompa $$ en Markdown
  mdText = (function unindentMathDelims(s) {
    const lines = String(s || "").split("\n");
    let inFence = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;

      if (/^\s*(\$\$)\s*$/.test(line)) {
        lines[i] = line.trim();
        continue;
      }
      if (/^\s*\$\$/.test(line)) {
        lines[i] = line.replace(/^\s+/, "");
      }
    }
    return lines.join("\n");
  })(mdText);

  // ==================================================
  // (B) EXTRAER + RENDERIZAR KATEX (ANTES DE MARKDOWN)
  // ==================================================

  const { text, blocks } = extractMath(mdText);
  const renderedMath = renderMathBlocks(blocks);

  // ==================================================
  // (C) MARKDOWN SOLO TEXTO
  // ==================================================

  if (typeof marked !== "undefined") {
    const r = new marked.Renderer();
    r.html = (html) => escapeHTML(html);

    marked.setOptions({
      gfm: true,
      breaks: true,
      headerIds: false,
      mangle: false,
      renderer: r,
    });

    let html = marked.parse(text);

    // ==================================================
    // (D) REINYECTAR KATEX HTML
    // ==================================================

    for (const key in renderedMath) {
      html = html.replaceAll(key, renderedMath[key]);
    }

    // Wrap tablas
    html = html
      .replace(/<table>/g, '<div class="table-wrap"><table>')
      .replace(/<\/table>/g, "</table></div>");

    return `<div class="markdown">${html}</div>`;
  }

  return `<pre>${escapeHTML(mdText)}</pre>`;
}

// =========================
// WIKIPEDIA LINKER (NEW)
// =========================
const WikiLinker = (() => {
  const MAX_FOUND = 10;
  const MAX_TRIES = 160; // seguridad para no spamear si hay textos enormes

  // Cache por idioma: key => url|null
  const cache = new Map(); // `${lang}|${normKey}` => string|null

  function lang2(lang) {
    return String(lang || "en").slice(0, 2).toLowerCase();
  }

  function stripDiacritics(s) {
    return String(s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  function cleanupSpaces(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  function urlSafeTitle(s) {
    let v = cleanupSpaces(s);
    v = v.replace(/[’‘´`]/g, "'");  // normaliza
    v = v.replace(/'/g, "");        // quita apóstrofes
    v = v.replace(/[^\p{L}\p{N}\s\-]/gu, " "); // quita símbolos no URL-friendly
    v = cleanupSpaces(v);
    return v;
  }

  function normKey(s) {
    return cleanupSpaces(urlSafeTitle(stripDiacritics(s))).toLowerCase();
  }

  function tokenize(text) {
    // letras + números, soporta guión interno
    const m = String(text || "").match(/[\p{L}\p{M}\p{N}]+(?:-[\p{L}\p{M}\p{N}]+)*/gu);
    return m || [];
  }

  // Reglas:
  // - 2 palabras seguidas: cada una > 5 caracteres
  // - 3 palabras seguidas: 1ª y 3ª >= 5, 2ª >= 1
  function extractCandidatesFromText(text) {
    const words = tokenize(text);
    const out = [];
    const seen = new Set();

    const push = (phrase) => {
      const k = normKey(phrase);
      if (!k) return;
      if (seen.has(k)) return;
      seen.add(k);
      out.push(phrase);
    };

    for (let i = 0; i < words.length; i++) {
      if (i + 1 < words.length) {
        const w1 = words[i];
        const w2 = words[i + 1];
        if (w1.length > 5 && w2.length > 5) {
          push(`${w1} ${w2}`);
        }
      }

      if (i + 2 < words.length) {
        const w1 = words[i];
        const w2 = words[i + 1];
        const w3 = words[i + 2];
        if (w1.length >= 5 && w3.length >= 5 && w2.length >= 1) {
          push(`${w1} ${w2} ${w3}`);
        }
      }
    }

    return out;
  }

  async function wikipediaResolveTitle(lang, rawTitle) {
    const code = lang2(lang);

    const base = cleanupSpaces(rawTitle);
    const variants = [];

    if (base) variants.push(base);

    const noDia = cleanupSpaces(stripDiacritics(base));
    if (noDia && noDia !== base) variants.push(noDia);

    const safe = cleanupSpaces(urlSafeTitle(base));
    if (safe && safe !== base) variants.push(safe);

    const safeNoDia = cleanupSpaces(urlSafeTitle(noDia));
    if (safeNoDia && !variants.includes(safeNoDia)) variants.push(safeNoDia);

    // dedup case-insensitive
    const uniq = [];
    const s = new Set();
    for (const v of variants) {
      const k = v.toLowerCase();
      if (!s.has(k)) { s.add(k); uniq.push(v); }
    }

    for (const v of uniq) {
      const api =
        `https://${code}.wikipedia.org/w/api.php` +
        `?action=query&format=json&formatversion=2&origin=*` +
        `&redirects=1&titles=${encodeURIComponent(v)}`;

      try {
        const r = await fetch(api, { cache: "no-store" });
        if (!r.ok) continue;
        const j = await r.json();
        const page = j?.query?.pages?.[0];
        if (!page || page.missing) continue;

        const canonical = page.title || v;
        const wikiUrl =
          `https://${code}.wikipedia.org/wiki/` +
          encodeURIComponent(canonical.replace(/ /g, "_"));

        return { title: canonical, url: wikiUrl };
      } catch {
        // seguimos probando variantes
      }
    }

    return null;
  }

  async function buildLinks(lang, candidates) {
    const found = [];
    const code = lang2(lang);

    let tries = 0;
    for (const phrase of candidates) {
      if (found.length >= MAX_FOUND) break;
      if (tries++ >= MAX_TRIES) break;

      const k = normKey(phrase);
      const ck = `${code}|${k}`;

      if (cache.has(ck)) {
        const cached = cache.get(ck);
        if (cached) found.push({ phrase, url: cached, key: k });
        continue;
      }

      const resolved = await wikipediaResolveTitle(lang, phrase);
      if (resolved?.url) {
        cache.set(ck, resolved.url);
        found.push({ phrase, url: resolved.url, key: k });
      } else {
        cache.set(ck, null);
      }
    }

    return found;
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function isForbiddenParent(el) {
    if (!el) return false;
    const tag = (el.tagName || "").toUpperCase();
    if (tag === "A" || tag === "CODE" || tag === "PRE" || tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA") {
      return true;
    }
    // no tocar KaTeX
    if (el.closest && el.closest(".katex, .katex-display")) return true;
    return false;
  }

  function applyLinksToBubble(bubbleEl, links) {
    if (!bubbleEl || !links?.length) return;

    // frases largas primero (evita solapes)
    const sorted = [...links].sort((a, b) => b.phrase.length - a.phrase.length);

    const map = new Map();
    for (const it of sorted) map.set(normKey(it.phrase), it.url);

    const alts = sorted.map(it => escapeRegExp(it.phrase)).join("|");
    if (!alts) return;

    const re = new RegExp(
      `(^|[^\\p{L}\\p{M}\\p{N}])(${alts})(?=$|[^\\p{L}\\p{M}\\p{N}])`,
      "giu"
    );

    const walker = document.createTreeWalker(
      bubbleEl,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const p = node.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          if (isForbiddenParent(p)) return NodeFilter.FILTER_REJECT;
          const txt = node.nodeValue || "";
          if (!txt.trim()) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    for (const node of nodes) {
      const text = node.nodeValue;
      re.lastIndex = 0;

      let m;
      let last = 0;
      let changed = false;

      const frag = document.createDocumentFragment();

      while ((m = re.exec(text)) !== null) {
        changed = true;

        const leftSep = m[1] || "";
        const phrase = m[2] || "";
        const start = m.index;

        frag.appendChild(document.createTextNode(text.slice(last, start)));
        if (leftSep) frag.appendChild(document.createTextNode(leftSep));

        const url = map.get(normKey(phrase));
        if (url) {
          const a = document.createElement("a");
          a.href = url;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.className = "wiki-link";
          a.textContent = phrase;
          frag.appendChild(a);
        } else {
          frag.appendChild(document.createTextNode(phrase));
        }

        last = re.lastIndex;
      }

      if (!changed) continue;

      frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
  }

  async function decorateBubble(bubbleEl, lang) {
    if (!bubbleEl) return;

    // Evita re-linkear el mismo contenido
    const plain = bubbleEl.innerText || bubbleEl.textContent || "";
    const hash = normKey(plain).slice(0, 200);
    if (bubbleEl.dataset.wikiHash === hash) return;
    bubbleEl.dataset.wikiHash = hash;

    const candidates = extractCandidatesFromText(plain);
    if (!candidates.length) return;

	const links = await buildLinks(lang, candidates);

	// guarda contador (para el aviso)
	bubbleEl.dataset.wikiFound = String(links.length);
	bubbleEl.dataset.wikiFoundMax = (links.length >= MAX_FOUND) ? "1" : "0";

	if (!links.length) return;

	applyLinksToBubble(bubbleEl, links);
  }

  return { decorateBubble };
})();

// =========================
// WIKIPEDIA HINT (NEW) - AS CHAT MESSAGE
// =========================
const WikiHint = (() => {
  let bound = false;

  function lang2(lang) {
    return String(lang || "en").slice(0, 2).toLowerCase();
  }

  const I18N = {
    es: {
      found: (n, maybeMore) =>
        `He encontrado ${n} artículo${n === 1 ? "" : "s"} de Wikipedia en mi respuesta.${maybeMore} Para buscar más, selecciona texto y pulsa “Buscar en Wikipedia”.`,
      btn: "Buscar en Wikipedia",
      noSel: "Selecciona primero un texto en la respuesta.",
      more: " No obstante, puede haber más.",
    },
    en: {
      found: (n, maybeMore) =>
        `I found ${n} Wikipedia article${n === 1 ? "" : "s"} in my answer.${maybeMore} To search for more, select text and click “Search Wikipedia”.`,
      btn: "Search Wikipedia",
      noSel: "Select some text in the answer first.",
      more: " There may be more.",
    },
    fr: {
      found: (n, maybeMore) =>
        `J’ai trouvé ${n} article${n === 1 ? "" : "s"} Wikipédia dans ma réponse.${maybeMore} Pour en chercher d’autres, sélectionnez du texte puis cliquez sur « Rechercher sur Wikipédia ».`,
      btn: "Rechercher sur Wikipédia",
      noSel: "Sélectionnez d’abord un texte dans la réponse.",
      more: " Il peut y en avoir d’autres.",
    },
    pt: {
      found: (n, maybeMore) =>
        `Encontrei ${n} artigo${n === 1 ? "" : "s"} da Wikipédia na minha resposta.${maybeMore} Para procurar mais, selecione texto e clique em “Pesquisar na Wikipédia”.`,
      btn: "Pesquisar na Wikipédia",
      noSel: "Selecione primeiro um texto na resposta.",
      more: " Pode haver mais.",
    },
  };

  function openWikipediaSearch(lang) {
    const code = lang2(lang);
    const sel = window.getSelection();
    const q = sel ? String(sel.toString() || "").trim() : "";
    const t = I18N[code] || I18N.en;

    if (!q) {
      alert(t.noSel);
      return;
    }

    const url = `https://${code}.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(q)}`;
    window.open(url, "_blank", "noopener");
  }

  function ensureBound() {
    if (bound) return;
    bound = true;

    // Delegación global: vale para TODOS los hints, incluso tras re-render
    document.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest ? e.target.closest(".wiki-hint-btn") : null;
      if (!btn) return;
      e.preventDefault();
      const lang = btn.getAttribute("data-lang") || state.lang;
      openWikipediaSearch(lang);
    });
  }

function makeHintHTML(n, lang, reachedMax) {
  const code = lang2(lang);
  const t = I18N[code] || I18N.en;
  const maybeMore = reachedMax ? t.more : "";
  const msg = t.found(n, maybeMore);

  // Importante: escapamos HTML por seguridad
  const safeMsg = escapeHTML(msg);

  return `
    <div class="wiki-hint-bubble">
      <div class="wiki-hint-text">${safeMsg}</div>
    </div>
  `;
}

  function pushFromBubble(bubbleEl, lang) {
    ensureBound();

    if (!bubbleEl) return;
    const n = parseInt(bubbleEl.dataset.wikiFound || "0", 10);
    if (!n) return;

    const reachedMax = bubbleEl.dataset.wikiFoundMax === "1";

    // Evita duplicados: si el último mensaje ya es un wikiHint, no lo metas otra vez
    const arr = currentThreadArray();
    const last = arr[arr.length - 1];
    if (last && last.__wikiHint) return;

    const html = makeHintHTML(n, lang, reachedMax);
    addMessage("bot", html, { asHTML: true, __noWiki: true, __wikiHint: true });
  }

  return { pushFromBubble };
})();


function typesetMath(root) {
  if (!root || typeof renderMathInElement !== "function") return;
  try {
    renderMathInElement(root, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
        // ❌ QUITAMOS \[ \] y \( \) para no romper \\[2pt] dentro de matrices
      ],
      throwOnError: false,
      strict: "ignore", // evita warnings/errores por unicode o “latex no perfecto”
    });
  } catch (_) {}
}

// === Helpers para bio Markdown de agentes ===
function basenameNoExt(path=""){
  const f = String(path).split("/").pop() || "";
  return f.replace(/\.[a-z0-9]+$/i, ""); // quita extensión
}
function slugifyName(s=""){
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/-+/g,"-").replace(/^-|-$/g,"");
}
async function fetchFirstOk(urls=[]){
  for (const u of urls){
    try {
      const res = await fetch(u);
      if (res.ok) return await res.text();
    } catch {}
  }
  return null;
}

async function loadAgentMarkdown(agent){
  const lang = state.lang || "en";
  const avatar = String(agent?.avatar || "");
  const base = avatar.split("/").pop().replace(/\.[a-z0-9]+$/i,""); // basename sin extensión
  const byName = (agent?.name || "").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/-+/g,"-").replace(/^-|-$/g,"");

  const candidates = [];
  if (base) { candidates.push(`avatars/${base}.${lang}.md`, `avatars/${base}.md`); }
  if (byName) { candidates.push(`avatars/${byName}.${lang}.md`, `avatars/${byName}.md`); }

  for (const url of candidates){
    try { const r = await fetch(url); if (r.ok) return await r.text(); } catch {}
  }
  return `> _No biography found for **${agent?.name||"this agent"}**._`;
}

async function previewAgent(agent){
  state.selectedAgent = agent;
  step1.classList.add("hidden");
  step2.classList.remove("hidden");

  const avatarHTML = agent.avatar
    ? `<img src="${agent.avatar}" class="large-avatar" alt="${escapeHTML(agent.name)}"/>`
    : `<div class="large-avatar">${initials(agent.name)}</div>`;

  // Campos i18n enviados por el backend
  const born = (agent.birth_year != null) ? String(agent.birth_year) : "";
  const birthplace = agent.birthplace ? escapeHTML(String(agent.birthplace)) : "";
  const nationality = agent.nationality ? escapeHTML(String(agent.nationality)) : "";
  const profession = agent.profession ? escapeHTML(L(agent.profession)) : "";
  const bio = agent.bio ? escapeHTML(String(agent.bio)) : "";

  // Etiquetas i18n
  const lblBorn = t("lbl_born");
  const lblBirthplace = t("lbl_birthplace"); // (por si decides mostrarlo por separado)
  const lblNationality = t("lbl_nationality");
  const lblBio = t("lbl_bio");

  const metaRows = [
    profession ? `<div class="kv"><span class="k">${escapeHTML(profession)}</span></div>` : "",
    (born || birthplace) ? `<div class="kv"><span class="k">${lblBorn}:</span> <span class="v">${escapeHTML([born, birthplace].filter(Boolean).join(" — "))}</span></div>` : "",
    nationality ? `<div class="kv"><span class="k">${lblNationality}:</span> <span class="v">${nationality}</span></div>` : ""
  ].join("");

  agentPreview.innerHTML = `
    ${avatarHTML}
    <div class="agent-bio">
      ${metaRows}
      ${bio ? `<div class="section-title">${lblBio}</div><p class="bio-text">${bio}</p>` : ""}
    </div>
  `;
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

function renderRow(who, text, msgObj) {
  const row = document.createElement("div");
  row.className = `msg ${who}`;

  const avatar = document.createElement("div");
  avatar.className = "avatar";

  if (who === "user") {
    avatar.innerHTML = `<img src="avatars/user.png" alt="You"/>`;
  } else {
    if (state.mode === "agents" && state.selectedAgent?.avatar) {
      avatar.innerHTML = `<img src="${state.selectedAgent.avatar}" alt="${state.selectedAgent.name}"/>`;
    } else {
      avatar.innerHTML = `<img src="avatars/model_only.png" alt="Model Only"/>`;
    }
  }

  const bubble = document.createElement("div");
  bubble.className = "bubble markdown";

  // ✅ Respetar HTML interno (UI), pero el modelo sigue pasando por renderMarkdown()
  if (msgObj && msgObj.__html) {
    bubble.innerHTML = msgObj.text || "";
  } else {
    bubble.innerHTML = renderMarkdown(text || "");
  }

  // KaTeX: solo si aún quedan delimitadores $ / $$ en el texto final
  // (si renderMarkdown ya lo convirtió, esto normalmente no hará nada)
  if (bubble.textContent.includes("$")) {
    typesetMath(bubble);
  }
  // ✅ NEW: Wikipedia links (post-render) — SOLO linkeo
  if (who !== "user" && !(msgObj && (msgObj.__noWiki || msgObj.__wikiHint))) {
    setTimeout(() => {
      bubble.dataset.wikiHash = "";
      WikiLinker.decorateBubble(bubble, state.lang).catch(() => {});
    }, 0);
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

  for (let i = 0; i < arr.length; i++){
    const m = arr[i];
    const bubble = renderRow(m.role, m.text, m);

	// ✅ NEW: Wikipedia links también al re-render del historial
	if (m.role === "bot" && bubble) {
	  setTimeout(() => {
		bubble.dataset.wikiHash = ""; // por si venía cacheado

		WikiLinker.decorateBubble(bubble, state.lang)
		  .then(() => {
			WikiHint.renderForBubble(bubble, state.lang);
		  })
		  .catch(() => {});
	  }, 0);
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
function scrollToEndSoon(){
  requestAnimationFrame(()=>{
    restoreCurrentScroll();
    if (chat) chat.scrollTop = chat.scrollHeight;
  });
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
function setBatteryColor(pct){
  batteryFill.classList.remove("b-red","b-orange","b-green");
  if (pct <= 20) batteryFill.classList.add("b-red");
  else if (pct <= 50) batteryFill.classList.add("b-orange");
  else batteryFill.classList.add("b-green");
}

// ===== DISK COLOR =====
function setDiskColor(pct){
  // Eliminamos estilos previos
  diskFill.style.background = "";

  if (pct < 60){
    diskFill.style.background = "#22c55e";   // verde
  } 
  else if (pct < 85){
    diskFill.style.background = "#c5a422";   // naranja
  } 
  else {
    diskFill.style.background = "#c52a22";   // rojo
  }
}


async function setupBattery(){
  if (navigator.getBattery){
    try{
      const batt = await navigator.getBattery();
      const update = ()=>{
        const pct = Math.round(batt.level * 100);
        batteryFill.style.width = pct + "%";
        batteryPct.textContent = pct + "%";
        setBatteryColor(pct);
      };
      update();
      batt.addEventListener("levelchange", update);
      batt.addEventListener("chargingchange", update);
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
  setBatteryColor(100);
}

// ===== SYSTEM METRICS POLLING =====
async function pollMetrics(){
  try{
    const res = await fetch(`${BASE_URL}/api/metrics`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const m = await res.json();

    // CPU
    if (typeof m.cpu === "number"){
      const v = Math.max(0, Math.min(100, Math.round(m.cpu)));
      if (cpuFill) cpuFill.style.width = v + "%";
      if (cpuPct)  cpuPct.textContent  = v + "%";
    }

    // RAM
    if (typeof m.ram === "number"){
      const v = Math.max(0, Math.min(100, Math.round(m.ram)));
      if (ramFill) ramFill.style.width = v + "%";
      if (ramPct)  ramPct.textContent  = v + "%";
    }

    // TEMP (si hay dato)
    if (typeof m.temp_c === "number" && isFinite(m.temp_c)){
      const t = Math.round(m.temp_c);
      const w = Math.max(0, Math.min(100, t));
      if (tempFill) tempFill.style.width = w + "%";
      if (tempVal)  tempVal.textContent  = `${t}°C`;
    } else {
      if (tempFill) tempFill.style.width = "0%";
      if (tempVal)  tempVal.textContent  = "—";
    }

	// 🆕 STORAGE (disco donde está la app)
	if (m.disk && typeof m.disk.percent === "number") {
	  const v = Math.max(0, Math.min(100, Math.round(m.disk.percent)));

	  // actualizar ancho y texto
	  diskFill.style.width = v + "%";
	  diskPct.textContent  = v + "%";

	  // aplicar color según tus reglas
	  setDiskColor(v);

	  // mostrar unidad (C:\, D:\, etc.)
	  if (m.disk.root) {
		diskPct.title = `${m.disk.root} — ${v}% used`;
	  }
	}

    // Batería (si no hay Battery API en el navegador)
    if (!navigator.getBattery && m.battery && typeof m.battery.percent === "number"){
      const pct = Math.round(m.battery.percent);
      batteryFill.style.width = pct + "%";
      batteryPct.textContent  = pct + "%";
      setBatteryColor(pct);
    }
  }catch(e){
    // silencioso
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
  if (lang === "pt") return "wikipedia_pt_all_maxi_2025-09";
  return "wikipedia_en_all_maxi_2025-08";
}
function encodeWikiTitle(title){
  // 1) normaliza espacios a _
  const raw = String(title || "").trim().replace(/\s+/g, "_");

  // 2) quita tildes/diacríticos SIEMPRE (ES/FR/PT…)
  const noAcc = stripAccents(raw);

  // 3) NO rompas "/" (para "A/...")
  return noAcc.split("/").map(seg => encodeURIComponent(seg)).join("/");
}
function wikiArticlePath(titleOrPath){
  const raw = String(titleOrPath || "").trim();
  if (!raw) return "";
  // Si ya viene con namespace tipo "A/...", "I/...", etc, lo respetamos
  if (/^[A-Za-z]\//.test(raw)) return encodeWikiTitle(raw);
  // ✅ Por defecto, artículos en Wikipedia ZIM → "A/"
  return `A/${encodeWikiTitle(raw)}`;
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
      // ✅ algunos proxies Kiwix no soportan HEAD → usamos GET con Range
      if (await existsByGet(contentUrl)) {
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

// ——— Wiki frame tracking: recuerda el último artículo abierto ———
let _wikiHashListenerAttached = false;
let _wikiUrlWatcherId = null;   // si ya lo tienes
let _wikiLastHref = "";         // 🔹 añade esta línea una sola vez

function getWikiFrame(){
  return document.getElementById("wikiFrame");
}

// ✅ Watcher global y único (no lo declares dentro de setMode)
function startWikiUrlWatcher(){
  stopWikiUrlWatcher();
  const f = getWikiFrame();
  if (!f) return;
  _wikiUrlWatcherId = setInterval(()=>{
    try {
      const href = f.contentWindow?.location?.href || "";
      if (href && href !== _wikiLastHref && href.includes(`${KIWIX_ORIGIN}/viewer#`)) {
        _wikiLastHref = href;
        state.wiki.url = href; // recuerda SIEMPRE la última vista
      }
    } catch {}
  }, 600);
}

function stopWikiUrlWatcher(){
  if (_wikiUrlWatcherId) {
    clearInterval(_wikiUrlWatcherId);
    _wikiUrlWatcherId = null;
  }
}


// 🔁 REEMPLAZA tu función por esta
function updateWikiUrlFromFrame(){
  try {
    const f = getWikiFrame();
    const href = f?.contentWindow?.location?.href || "";
    if (href && href.includes(`${KIWIX_ORIGIN}/viewer#`)) {
      state.wiki.url = href;
      _wikiLastHref = href; // ← sincroniza con el watcher
    }
  } catch {}
}

// 🆕 Interceptor de enlaces geo: dentro del visor de Wikipedia
function onWikiGeoClick(ev) {
  try {
    let target = ev.target;
    if (!target) return;

    // Log de depuración
    console.debug("[WIKI] onWikiGeoClick: event.target =", target);

    // Asegurarnos de trabajar siempre con un ELEMENT_NODE
    if (target.nodeType !== Node.ELEMENT_NODE) {
      target = target.parentElement;
    }
    if (!target) return;

    // Buscamos el <a> más cercano con href="geo:..."
    const link = target.closest("a[href^='geo:']");
    if (!link) return; // no era un enlace geo:

    console.debug("[WIKI] enlace geo encontrado:", link);

    // Ya hemos encontrado un enlace geo:, paramos el flujo normal
    ev.preventDefault();
    ev.stopPropagation();

    let href = (link.getAttribute("href") || "").trim();
    if (!/^geo:/i.test(href)) return;

    // geo:lat,lon?z=...  → nos quedamos solo con lat,lon
    let coordsRaw = href.replace(/^geo:/i, "").trim();
    coordsRaw = coordsRaw.split(/[?;]/, 1)[0].trim();
    if (!coordsRaw) return;

    // Validamos que las coordenadas son correctas
    const coords = parseLatLon(coordsRaw);
    if (!coords) {
      console.warn("[WIKI] geo: link with invalid coords:", href);
      return;
    }

    console.debug("[WIKI] geo link detected:", href, "→", coordsRaw, coords);

    // Textos del modal según idioma activo
    const lang = state.lang || "en";
    let title, msg, okLabel, cancelLabel;
    if (lang === "es") {
      title       = "Abrir en mapas";
      msg         = "¿Quieres abrir esta localización en los mapas?";
      okLabel     = "OK";
      cancelLabel = "Cancelar";
    } else if (lang === "fr") {
      title       = "Ouvrir dans les cartes";
      msg         = "Voulez-vous ouvrir cet emplacement dans les cartes ?";
      okLabel     = "OK";
      cancelLabel = "Annuler";
    } else if (lang === "pt") {
      title       = "Abrir nos mapas";
      msg         = "Quer abrir esta localização nos mapas?";
      okLabel     = "OK";
      cancelLabel = "Cancelar";
    } else {
      title       = "Open in maps";
      msg         = "Do you want to open this location in Maps?";
      okLabel     = "OK";
      cancelLabel = "Cancel";
    }

    // Usamos tu modal genérico showConfirmDialog
    showConfirmDialog({
      title,
      message: msg,
      confirmLabel: okLabel,
      cancelLabel,
		onConfirm: async () => {
		  try {
			const coordText = coordsRaw;          // Ej: "40.576388888889,-3.93"

			// 1) Cambiamos a la sección Mapas
			await setMode("maps");

			// Función auxiliar que realmente hace el "Ir"
			const doSearch = () => {
			  // 2) Rellenamos el input de búsqueda de mapas
			  const input = document.getElementById("mapsSearchInput");
			  if (input) input.value = coordText;

			  // 3) Ejecutamos la búsqueda (equivalente al botón "Ir")
			  handleMapsSearch(coordText);
			};

			// 🧠 Si el mapa existe y el estilo aún no está cargado, esperamos un poco
			if (window._map && typeof _map.isStyleLoaded === "function" && !_map.isStyleLoaded()) {
			  let tries = 0;
			  const maxTries = 20;   // ~3s como máximo si pones intervalo 150ms
			  const interval = 150;

			  const timer = setInterval(() => {
				try {
				  if (_map && typeof _map.isStyleLoaded === "function" && _map.isStyleLoaded()) {
					clearInterval(timer);
					doSearch();
				  } else if (++tries >= maxTries) {
					// Fallback: si se ha alargado demasiado, intentamos igualmente
					clearInterval(timer);
					doSearch();
				  }
				} catch (e) {
				  clearInterval(timer);
				  doSearch();
				}
			  }, interval);
			} else {
			  // Si el mapa ya está listo, disparamos directamente
			  doSearch();
			}

		  } catch (err) {
			console.error("[WIKI] Error abriendo mapas desde geo link:", err);
			toast(t("mapsOpenError"));
		  }
		}
    });

  } catch (err) {
    console.error("[WIKI] onWikiGeoClick error global:", err);
  }
}


function attachWikiFrameTracker() {
  const f = getWikiFrame();
  if (!f) return;

  // Evita enganchar mil veces sobre el mismo document
  function wireDoc(doc) {
    try {
      if (!doc) return;
      if (doc.__offlinedGeoHooked) return;
      doc.__offlinedGeoHooked = true;

      // Log para depurar
      console.debug("[WIKI] wireDoc() enganchando geo-click en doc", doc.URL || doc.location?.href);

      // Capturamos TODOS los clicks en este documento
      doc.addEventListener("click", (ev) => {
        // Log genérico de click dentro del visor
        console.debug("[WIKI] click capturado en visor", ev.target);
        try {
          onWikiGeoClick(ev);
        } catch (err) {
          console.error("[WIKI] error en onWikiGeoClick:", err);
        }
      }, true);

      // Intentar enganchar también todos los iframes hijos de este doc
      const hookInnerFrame = (ifr) => {
        try {
          if (!ifr) return;

          // Cuando el iframe cargue, intentamos enganchar su document
          ifr.addEventListener("load", () => {
            try {
              const innerDoc = ifr.contentDocument || ifr.contentWindow?.document;
              wireDoc(innerDoc);
            } catch (e) {
              // Puede fallar si es cross-origin (geo:, etc.), lo ignoramos
            }
          });

          // Y también lo intentamos ya por si el iframe ya está cargado
          try {
            const innerDocNow = ifr.contentDocument || ifr.contentWindow?.document;
            wireDoc(innerDocNow);
          } catch (e) {}
        } catch (e) {}
      };

      // Enganchar todos los iframes ya presentes
      const iframes = doc.querySelectorAll("iframe");
      iframes.forEach(hookInnerFrame);

      // Observar futuros iframes (cuando cambias de artículo, etc.)
      const mo = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const n of m.addedNodes) {
            if (n.nodeType === Node.ELEMENT_NODE && n.tagName === "IFRAME") {
              hookInnerFrame(n);
            }
          }
        }
      });

      mo.observe(doc.documentElement || doc.body || doc, {
        childList: true,
        subtree: true
      });
    } catch (err) {
      console.error("[WIKI] wireDoc error:", err);
    }
  }

  const setup = () => {
    try {
      // Seguimos enganchando el hashchange para recordar la URL
      if (f.contentWindow && !_wikiHashListenerAttached) {
        f.contentWindow.addEventListener("hashchange", updateWikiUrlFromFrame);
        _wikiHashListenerAttached = true;
        updateWikiUrlFromFrame(); // lee la URL actual al enganchar
      }

      // Documento principal del wikiFrame
      const doc = f.contentDocument || f.contentWindow?.document;
      if (doc) {
        wireDoc(doc);
      }
    } catch (err) {
      console.error("[WIKI] attachWikiFrameTracker setup error:", err);
    }
  };

  // ‘load’ vuelve a disparar si el viewer recarga (otros cambios además del hash)
  f.addEventListener("load", setup, { once: false });

  // Y lo ejecutamos ya por si el iframe ya está cargado
  setup();
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

  // Para colapsar separadores a un solo espacio y evitar espacios al inicio
  let lastWasSpace = true;

  for (const ch of String(s || "")) {
    const deacc = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    for (let k = 0; k < deacc.length; k++) {
      const c = deacc[k];

      // “carácter de palabra” = letra o número (unicode)
      const isWord = /[\p{L}\p{N}]/u.test(c);

      if (isWord) {
        base += c;
        map.push(origIndex);
        lastWasSpace = false;
      } else {
        // Cualquier puntuación (apóstrofes, guiones, comillas, etc.) → espacio
        if (!lastWasSpace) {
          base += " ";
          map.push(origIndex); // este espacio “apunta” al índice original del separador
          lastWasSpace = true;
        }
      }
    }

    origIndex += ch.length;
  }

  // Quitar espacio final si quedó
  if (base.endsWith(" ")) {
    base = base.slice(0, -1);
    map.pop();
  }

  return { base, map };
}

function wikiKey(s){
  // Misma idea que normalizeForNgrams + stripAccents + lower
  return stripAccents(String(s||""))
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[*_~`#>]+/g, " ")
    .replace(/[.,;:!?¡¿()\[\]{}"“”'‘’«»<>…—–\-_/\\|·•]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  // Convertimos "_" a espacio para que titleCase/ucFirstWord funcionen bien,
  // y luego encodeWikiTitle ya lo devolverá a "_"
  const t0 = String(raw||"").trim().replace(/[_\s]+/g," ").trim();
  if (!t0) return [];

  const na = stripAccents(t0);

  const vars = [];
  const push = (v) => { if (v && v.trim()) vars.push(v.trim()); };

  // ✅ PRIORIDAD: sin tildes primero (y con mayúscula)
  push(ucFirstWord(na));    // "Funcion exponencial"
  push(na);                 // "funcion exponencial"
  push(titleCase(na));      // "Funcion Exponencial"

  // luego variantes con tildes (por si algún ZIM sí las necesita)
  push(ucFirstWord(t0));    // "Función exponencial"
  push(t0);                 // "función exponencial"
  push(titleCase(t0));      // "Función Exponencial"

  // dedupe
  return Array.from(new Set(vars));
}

function stripAccents(s){
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function ucFirstWord(s){
  s = String(s || "");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function encodeWikiTitleKeepSlash(title){
  // espacios => _
  const t = String(title || "").trim().replace(/\s+/g, "_");
  // encode por segmentos para NO romper "A/..."
  return t.split("/").map(seg => encodeURIComponent(seg)).join("/");
}

/**
 * Variantes de título pensadas para ZIM:
 * - primero SIN tildes y con Mayúscula inicial (tu caso: Funcion_exponencial)
 * - luego sin tildes normal
 * - luego con tildes (por si otro ZIM las usa)
 */
function titleVariants(raw){
  const base = String(raw || "").trim().replace(/[_\s]+/g, " ").trim();
  if (!base) return [];

  const noAcc = stripAccents(base);

  const vars = [
    ucFirstWord(noAcc), // ✅ Funcion exponencial
    noAcc,              // funcion exponencial
    ucFirstWord(base),  // Función exponencial
    base,               // función exponencial
  ];

  // dedupe conservando orden
  const seen = new Set();
  const out = [];
  for (const v of vars) {
    const k = v.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(v); }
  }
  return out;
}

function wikiArticlePathFromTitle(title){
  // siempre namespace A/
  // y SIEMPRE sin tildes en URL (porque encodeWikiTitleKeepSlash no quita tildes)
  // => lo hacemos aquí para que sea determinista
  const t = stripAccents(String(title || "").trim());
  return "A/" + encodeWikiTitleKeepSlash(t);
}


// Verificación real de artículos
async function probeTitle(zimId, title){
  // probamos variantes: primero la buena (sin tildes + mayúscula)
  const vars = titleVariants(title);

  for (const v of vars) {
    const url = `${KIWIX_ORIGIN}/content/${zimId}/${wikiArticlePathFromTitle(v)}`;

    try {
      const r = await fetch(url, { method: "GET", headers: { Range: "bytes=0-0" } });
      if (r.ok || r.status === 206) return v; // ✅ existe
    } catch {}
  }

  return null;
}

async function probeTitleUrl(url){
  try {
    const r = await fetch(url, { method: "GET", headers: { Range: "bytes=0-0" } });
    return (r.ok || r.status === 206);
  } catch {
    return false;
  }
}

async function findExistingTitle(rawTitle){
  await ensureWikiReady();
  const zimId = state.wiki.zimId || getZimIdForLang(state.lang);

  // cache por “concepto normalizado”
  const nkey = `${zimId}|${normKey(rawTitle)}`;
  if (Object.prototype.hasOwnProperty.call(state.wikiCanon, nkey)) {
    return state.wikiCanon[nkey];
  }

  const variants = titleVariants(rawTitle);

  for (const v of variants){
    // construye la URL REAL (A/ + sin tildes, etc.)
    const path = wikiArticlePathFromTitle(v); // => "A/Funcion_exponencial" (ya sin tildes)
    const url = `${KIWIX_ORIGIN}/content/${zimId}/${path}`;

    // cache por URL real
    const existKey = `${zimId}|${path}`;
    if (Object.prototype.hasOwnProperty.call(state.wikiExist, existKey)) {
      if (state.wikiExist[existKey]) { state.wikiCanon[nkey] = v; return v; }
      continue;
    }

    const ok = await probeTitleUrl(url);   // ✅ boolean
    state.wikiExist[existKey] = ok;

    if (ok) { state.wikiCanon[nkey] = v; return v; }
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
    toast(t("wikiArticleNotFound"));
    return;
  }
  const zimId = state.wiki.zimId || getZimIdForLang(state.lang);
  const url = `${KIWIX_ORIGIN}/viewer#${zimId}/${wikiArticlePath(canon)}`;
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

async function kiwixSearchAndOpen(query, max = 8){
  await ensureWikiReady();
  const zimId = state.wiki.zimId || getZimIdForLang(state.lang);

  const base = `${KIWIX_ORIGIN}/search?content=${encodeURIComponent(zimId)}&pattern=${encodeURIComponent(query)}&max=${max}`;

  // Intento JSON explícito
  try {
    const rj = await fetch(base + `&format=json`);
    if (rj.ok) {
      const data = await rj.json().catch(()=>null);
      const first = data && (data.results?.[0] || data[0]) || null;

      if (first) {
        // ✅ preferir ruta directa si viene en la respuesta
        const rawPath = first.path || first.href || first.url || "";
        if (rawPath) {
          const tail = String(rawPath).includes(`/content/${zimId}/`)
            ? String(rawPath).split(`/content/${zimId}/`)[1]
            : String(rawPath).replace(/^\/?content\/[^/]+\//, ""); // por si ya viene sin zimId correcto
          if (tail) {
            const articleUrl = `${KIWIX_ORIGIN}/viewer#${zimId}/${tail}`;
            state.wiki.pendingUrl = articleUrl;
            setMode("wiki");
            return true;
          }
        }

        // ↪️ si no hay path, caemos a título (codificado)
        const title = first.title || first.display || first.name || first.article || first.filename;
        if (title) {
          const articleUrl = `${KIWIX_ORIGIN}/viewer#${zimId}/${wikiArticlePath(title)}`;
          state.wiki.pendingUrl = articleUrl;
          setMode("wiki");
          return true;
        }
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
  if (lang === "pt") return "Especial:Pesquisar";
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
    const key = wikiKey(c);
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

// ===== REFERRALS: detección + tarjetas + links =====
function normName(s){ return stripAccents(String(s||"")).toLowerCase().trim(); }

function findAgentByName(name){
  const key = normName(name);
  return state.agents.find(a => normName(a.name) === key) || null;
}

// ⬇️ NUEVO: helpers de matching por keywords (ES/EN/FR)
function normalizeForMatch(s){
  return (" " + stripAccents(String(s||"")).toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ").replace(/\s+/g," ");
}

function getAgentKeywordsForLang(agent, lang){
  const kws = (agent && agent.keywords) ? agent.keywords : null;
  if (!kws) return [];
  // usa el idioma activo, luego cae a EN, luego a cualquier lista disponible
  return (kws[lang] && Array.isArray(kws[lang]) ? kws[lang]
        : (kws.en && Array.isArray(kws.en) ? kws.en
        : Object.values(kws).find(Array.isArray) || []));
}

function countKeywordHits(agent, text, lang){
  if (!agent) return 0;
  const txt = normalizeForMatch(text);
  const seen = new Set();
  let hits = 0;

  for (const kw of getAgentKeywordsForLang(agent, lang)){
    const q = normalizeForMatch(kw || "");
    if (q.length < 3) continue;        // descarta vacíos/insignificantes
    if (seen.has(q)) continue;         // evita contar duplicados
    seen.add(q);
    if (txt.includes(q)) hits++;
  }
  return hits;
}

// Puntúa un agente por nº de keywords que aparecen en el texto
function scoreAgentByKeywords(agent, text, lang) {
  return countKeywordHits(agent, text, lang); // ahora el "peso" ES el nº de hits
}

// Devuelve una lista ordenada de agentes por score (desc), filtrando por umbral y quitando “yo mismo”
function rankAgentsLocally(text, lang) {
  if (!Array.isArray(state.agents) || !state.agents.length) return [];
  const current = (state.mode === "agents" && state.selectedAgent) ? normName(state.selectedAgent.name) : null;

  // Construimos (score, agente)
  const scored = state.agents
    .filter(a => !current || normName(a.name) !== current) // fuera el agente activo
    .map(a => ({ agent: a, score: scoreAgentByKeywords(a, text, lang) }))
    .filter(x => x.score >= REFERRAL_MIN_KEYWORD_HINTS);

  // Orden: 1) score desc, 2) nombre asc (desempate estable)
  scored.sort((a,b)=> (b.score - a.score) || String(a.agent.name).localeCompare(b.agent.name));
  return scored.map(x => x.agent);
}

// Evita repetir el mismo conjunto de nombres que el turno anterior
function dedupeConsecutiveReferrals(list) {
  if (!REFERRAL_DEDUPE_CONSECUTIVE) return list;
  const keys = (list || []).map(a => normName(a.name));
  // si es idéntico al último, no mostramos nada
  const prev = state.lastReferralKeys || [];
  const sameLen = keys.length === prev.length;
  const sameSet = sameLen && keys.every((k,i)=> k === prev[i]); // mismo orden y contenido
  if (sameSet) return [];
  // guarda para el siguiente turno
  state.lastReferralKeys = keys.slice(0);
  return list;
}



function filterOutSelf(agents){
  const current =
    state.mode === "agents" && state.selectedAgent ? normName(state.selectedAgent.name) : null;
  if (!current) return agents;
  return agents.filter(a => normName(a.name) !== current);
}

async function goToAgentChat(agent){
  if (!agent) return;

  saveCurrentScroll();

  state.selectedAgent = agent;
  state.mode = "agents";

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
  if (!isEncarthaActive() && (!state.chats.agents[k] || state.chats.agents[k].length === 0)){
    const greet = pickGreeting(agent);
    if (greet) addMessage("bot", greet);
  }
  rememberRecentAgent(agent);
  renderConversation();
  encarthaBindButtons();  
  requestAnimationFrame(focusEditor);
  
	if (isEncarthaActive()){
	  if (!state._encarthaIntroShown) {
		await encarthaInitialView();       // primera vez → muestra intro
	  } else {
		encarthaBindButtons();             // ya iniciada → no añadas intro
		renderConversation();             // asegura re-pintar el histórico
		scrollToEndSoon();                // baja al último mensaje
	  }
	  return;
	}
}

async function openAgentByName(name){
  let a = findAgentByName(name);
  if (!a){
    try { await fetchAgents(); a = findAgentByName(name); } catch {}
  }
  if (a) goToAgentChat(a);
  else toast(`⚠️ ${t("agentNotFound")} "${name}".`);
}

// === MICHAEL ENCARTHA — helpers de detección y UI ===
function isEncarthaActive(){
  const a = state.selectedAgent;
  return state.mode === "agents" && !!a && /michael\s+encartha/i.test(a.name || "");
}

// NUEVO: helpers para progreso real (reusa tu storage y cálculos actuales)
const WT_FAVS_KEY    = (id) => `wt:favs:${id}`;
const WT_RECENTS_KEY = (id) => `wt:rec:${id}`;
const WT_PROG_KEY    = (id) => `wt:prog:${id}`;
const WT_ACH_KEY     = (id) => `wt:ach:${id}`;
const WT_LAST_KEY = (id) => `wt:last:${id}`; // última hoja (path absoluto) por árbol
function loadLastFor(id){
  try { return localStorage.getItem(WT_LAST_KEY(id)) || ""; } catch { return ""; }
}
function saveLastFor(id, absPath){
  if (!id || !absPath) return;
  try { localStorage.setItem(WT_LAST_KEY(id), String(absPath||"")); } catch {}
}

function loadFavsFor(id){
  try { return JSON.parse(localStorage.getItem(WT_FAVS_KEY(id)) || "[]"); }
  catch { return []; }
}

// Calcula % global dado el JSON del árbol + hojas visitadas guardadas
function calcOverallPctForTree(treeJson, visitedObj){
  const norm = (s)=> String(s||"")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")  // quita acentos
    .replace(/\s+/g," ")                              // espacios múltiples → uno
    .trim();

  const index = buildTreeIndex(treeJson);
  const leafPaths = Object.entries(index).filter(([,m]) => m.leaf).map(([p]) => p);

  const visitedKeys = Object.keys(visitedObj||{});
  const visitedSetNorm = new Set(visitedKeys.map(norm));

  const total = leafPaths.length;
  let done = 0;
  for (const p of leafPaths){
    if (visitedSetNorm.has(norm(p))) done++;
  }
  return total ? Math.round(100*done/total) : 0;
}

function updateTreeHeaderProgress(){
  try {
    const span = document.getElementById("treePct");
    if (!span || !state._currentTreeLocalized) return;
    const pct = calcOverallPctForTree(state._currentTreeLocalized, state._treeVisited || {});
    span.textContent = `(${pct}%)`;
  } catch {}
}


// % SOLO para una sub-rama (pathPrefix) dentro del árbol localizado
function calcPctForSubtree(treeJson, visitedObj, pathPrefix){
  const norm = (s)=> String(s||"")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/\s+/g," ")
    .trim();

  const index = buildTreeIndex(treeJson); // { "A › B": {leaf, children:[]}, ... }
  const leafPaths = Object.entries(index)
    .filter(([,m]) => m.leaf)
    .map(([p]) => p);

  const base = String(pathPrefix||"").trim();
  const isRoot = (base === "/" || base === "");
  const under = isRoot
    ? leafPaths
    : leafPaths.filter(p => p === base || p.startsWith(base + " › "));

  const visitedKeys = Object.keys(visitedObj||{});
  const vs = new Set(visitedKeys.map(norm));

  const total = under.length;
  let done = 0;
  for (const p of under){
    if (vs.has(norm(p))) done++;
  }
  return total ? Math.round(100*done/total) : 0;
}

// Cuenta HOJAS bajo un pathPrefix dentro de un árbol ya localizado
function countLeavesUnder(treeJson, pathPrefix){
  try {
    const index = buildTreeIndex(treeJson); // { "A › B": {leaf, children:[]}, ... }
    const leafPaths = Object.entries(index)
      .filter(([,m]) => m.leaf)
      .map(([p]) => p);

    const base = String(pathPrefix||"").trim();
    const isRoot = (base === "/" || base === "");
    const under = isRoot ? leafPaths : leafPaths.filter(p => p === base || p.startsWith(base + " › "));
    return under.length;
  } catch { return 0; }
}


/**
 * Carga estado de estudio REAL por árbol.
 * Si pasas treesById (mapa {id: json}), computa % exacto.
 * Si no lo pasas, devuelve done≈Object.keys(visited).length y pct=null (lo completaremos luego).
 */
function encarthaLoadStudyState(treesById=null){
  const out = { progress: {}, favorites: {}, achievements: {} };

  // Recorremos por lo que haya en storage (y completaremos con el catálogo cuando toque)
  for (let i=0; i<localStorage.length; i++){
    const k = localStorage.key(i) || "";
    const m = k.match(/^wt:(prog|favs|ach|rec):(.+)$/);
    if (!m) continue;
    const kind = m[1]; const id = m[2];
    if (kind === "favs"){
      out.favorites[id] = loadFavsFor(id);
    } else if (kind === "prog"){
      const visited = loadProgressFor(id);             // { "A › B › C": true, ... }
      let pct = null;
      if (treesById && treesById[id]){
        try { const localized = localizeTaxoTree(treesById[id], state.lang);
pct = calcOverallPctForTree(localized, visited); } catch {}
      }
      out.progress[id] = {
        visitedCount: Object.keys(visited).length,
        overall: (pct==null ? 0 : pct)   // si no tenemos árbol aún, lo rellenaremos luego
      };
    } else if (kind === "ach"){
      out.achievements[id] = loadAchFor(id);
    }
  }
  return out;
}


function renderEncarthaActions(actions){
  if (!Array.isArray(actions) || !actions.length) return "";
  const btns = actions.map(a=>{
    const em = (a.action === "openTree") ? "🔎 " :
               (a.action === "drill" || a.action === "drillRoot") ? "➕ " : "";
    const label = em + (a.label || a.action);
    const attrs = [
      `data-encartha="${a.action}"`,
      a.tree ? `data-tree="${a.tree}"` : "",
      a.node ? `data-node="${a.node}"` : "",
      a.title? `data-title="${a.title}"` : ""
    ].filter(Boolean).join(" ");
    return `<button class="btn-plain" ${attrs}>${label}</button>`;
  }).join(" ");
  return `<div class="encartha-actions" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;">${btns}</div>`;
}

function renderEncarthaNavFooter(treeId){
  const t = (key)=> (I18N[state.lang] && I18N[state.lang][key]) || key;
  const attrsCats = `data-encartha="backCats"`;

  // Solo mostramos "Volver al primer nivel" si hay treeId (estamos dentro de un árbol)
  const hasTree = !!treeId;
  const attrsRoot = hasTree
    ? `data-encartha="backRoot" data-tree="${_html(treeId||"")}" data-node="/"`
    : null;

  const backCatsBtn = `<button class="btn-plain" ${attrsCats}>${t("encartha_backCats")}</button>`;
  const backRootBtn = hasTree
    ? `<button class="btn-plain" ${attrsRoot}>${t("encartha_backRoot")}</button>`
    : "";

  return `
    <div class="encartha-actions" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;">
      ${backCatsBtn}
      ${backRootBtn}
    </div>`;
}



// Vista inicial: primero categorías (para no saturar)
async function encarthaInitialView(variant = "intro"){
  state.encarthaDelays = { element: 10, char: 3, mode: "word" }; // velocidad del tipeo	
  const t = (key)=> (I18N[state.lang] && I18N[state.lang][key]) || key;

  // 1) Catálogo (categorías + items; NO cargamos árboles aún)
  let catalog = { items: [], categories: [] };
  try { catalog = await fetch(`${BASE_URL}/api/taxonomy/catalog`).then(r=>r.json()); } catch {}

  const cats = Array.isArray(catalog.categories) ? catalog.categories : [];
  const items = Array.isArray(catalog.items) ? catalog.items : [];

  // Mapa id->label+emoji localizado
  const lang = state.lang || "en";
  const catById = {};
  for (const c of cats){
    const L = (c.i18n && (c.i18n[lang] || c.i18n.en)) || {};
    catById[c.id] = { id:c.id, emoji:c.emoji||"", label: L.label || c.id };
  }

  // Contador por categoría
  const counts = {};
  for (const it of items) counts[it.category] = (counts[it.category]||0)+1;

  const catBtns = cats.map(c=>{
    const meta = catById[c.id] || {label:c.id, emoji:""};
    const count = counts[c.id]||0;
    return `<button class="btn-plain" data-encartha="pickCat" data-cat="${c.id}">
              ${meta.emoji ? meta.emoji + " " : ""}${_html(meta.label)} (${count})
            </button>`;
  }).join(" ");

	const introKey = (variant === "resume") ? "encartha_intro_resume" : "encartha_intro";
	const html = `
	  <div class="markdown encartha-intro">
		<p>${t(introKey)}</p>
		<p style="margin-top:12px;"><b>${t("encartha_cats_title")}</b></p>
		<div class="encartha-actions" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;">
		  ${catBtns || `<em>${t("libEmpty")||"Empty"}</em>`}
		</div>
	  </div>
	`;
  await encarthaReply(html);
  state._encarthaIntroShown = true;  // 🔒 desde ahora ya no re-mostrar intro
}

async function encarthaBindButtons(){
  if (state._encarthaBound) return;
  state._encarthaBound = true;

  const root = document; 
  root.addEventListener("click", async (ev)=>{
    const btn = ev.target.closest && ev.target.closest("[data-encartha]");
    if (!btn) return;

    const action   = btn.getAttribute("data-encartha");
    const treeId   = btn.getAttribute("data-tree")  || "";
    const nodePath = btn.getAttribute("data-node")  || "";
    const title    = btn.getAttribute("data-title") || "";

    try {
      // --- Abrir árbol directamente (estudio)
      if (action === "openTree"){
        await setMode("wiki");
        openTreeFromCatalog(treeId, title || treeId, nodePath || "");
        return;
      }

      // --- Listar catálogo por categoría (tarjetas con ▶ Reanudar)
      if (action === "pickCat"){
        const cat = btn.getAttribute("data-cat") || "";
        try {
          const res  = await fetch(`${BASE_URL}/api/taxonomy/catalog`);
          const data = await res.json();
          const items = (Array.isArray(data.items) ? data.items : []).filter(it => it.category === cat);

          // Cargar y LOCALIZAR árboles de la categoría
          const trees = {};
          for (const it of items){
            try {
              const raw = await fetch(`${BASE_URL}/api/taxonomy/${encodeURIComponent(it.id)}`).then(r=>r.json());
              trees[it.id] = localizeTaxoTree(raw, state.lang);
            } catch {}
          }
          state._encarthaTrees = trees;
          state._encarthaCat   = cat;

          const study = encarthaLoadStudyState(trees);
          const lang  = state.lang || "en";

          const cards = items.map(it=>{
            const pid   = it.id;
            const L     = (it.i18n && (it.i18n[lang] || it.i18n.en)) || {};
            const ttl   = L.title || it.title || it.id;

            // % global por árbol
            let pct = (study.progress[pid]?.overall ?? null);
            if (pct == null && trees[pid]){
              try{
                const visited = loadProgressFor(pid);
                pct = calcOverallPctForTree(trees[pid], visited); // trees[pid] ya localizado
              }catch{ pct = 0; }
            }
            if (pct == null) pct = 0;

            // ▶ Reanudar (última hoja guardada)
            const last = loadLastFor(pid);  // ← NUEVO
            const resumeBtn = last
              ? `<button class="btn-plain"
                   data-encartha="resumeLast"
                   data-tree="${_html(pid)}"
                   data-node="${_html(last)}"
                   title="${t('resumeLabel')}">▶</button>`
              : "";

            return `
              <div class="card small" data-tree-card="${_html(pid)}">
                <div class="row">
                  <strong>${_html(ttl)}</strong>
                  <span>${t("study_overall")}: ${pct}%</span>
                </div>
                <div class="mini-progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
                  <div class="bar" style="width:${pct}%"></div>
                </div>
                <div class="row" style="gap:8px;display:flex;flex-wrap:wrap; margin-top:8px;">
                  <button class="btn-plain"
                    data-encartha="openTree"
                    data-tree="${_html(pid)}"
                    data-title="${_html(ttl)}"
                    title="${t("openStudy")||"Open & Study"}">🔎</button>
                  <button class="btn-plain"
                    data-encartha="drillRoot"
                    data-tree="${_html(pid)}"
                    data-node="/"
                    title="${t("drilldown")||"Drill down"}">➕</button>
                  ${resumeBtn}
                </div>
              </div>`;
          }).join("");

          // Título de la categoría (evitar sombra con 'title' superior)
          const catTitle = (()=>{
            const c = (Array.isArray(data.categories) ? data.categories : []).find(x=>x.id===cat);
            if (!c) return cat;
            const L = (c.i18n && (c.i18n[lang] || c.i18n.en)) || {};
            return (c.emoji ? (c.emoji + " ") : "") + (L.label || c.id);
          })();

			const nav   = renderEncarthaNavFooter(""); // sin treeId
			const instr = renderEncarthaHintsMultiline(); // 👈 multilinea
			const html = `
			  <div class="markdown">
				<h3>${_html(catTitle)}</h3>
				${instr}
				<div class="cards" style="margin-top: 18px; margin-bottom: 18px;">${cards || `<em>${t("libEmpty")||"Empty"}</em>`}</div>
				${nav}
			  </div>`;
			await encarthaReply(html);

        }catch(e){ console.warn(e); }
        return;
      }

      // --- Drilldown (navegar por ramas en el chat)
      if (action === "drill" || action === "drillRoot"){
        const path = (action === "drillRoot") ? "/" : (nodePath || "/");
        encarthaRenderChildren(treeId, path);
        return;
      }

      // --- Abrir wiki (🌐) + marcar leído + feedback + guardar "último"
      if (action === "openWiki"){
        // 0) Datos base
        const trees = state._encarthaTrees || {};
        const tree  = trees[treeId];
        const rel   = nodePath || "/";  // path RELATIVO dentro del árbol
        if (!tree){ toast(t("err_tree_not_loaded")); return; }

        // 1) Vista wiki + abrir árbol en ese nodo
        await setMode("wiki");
        await openTreeFromCatalog(treeId, tree.title || treeId, rel);

        // 2) Marcar hoja + guardar "último"
        let absPath = "";
        try {
          const localized = state._currentTreeLocalized || tree;
          absPath = encarthaAbsPath(localized, rel);
          if (absPath){
            markVisited(absPath);
            saveLastFor(state._currentTreeId, absPath);
          }
        } catch {}

		// --- 2b) Feedback visual + mensaje de progreso
		try {
		  // pulso verde repetido 3 veces en el árbol
		  if (absPath){
			const sel = `[data-path="${CSS.escape(absPath)}"] > .taxo-row`;
			const rowTree = document.querySelector(sel);
			if (rowTree){
			  rowTree.classList.add("status-done","pulse3");
			  setTimeout(()=> rowTree.classList.remove("pulse3"), 2800); // 0.9s * 3 + margen
			}
		  }

			// % global (toast overlay) + banner en Wiki
			const { pct, done, total } = achievementsProgressSnapshot();
			const titleTree = state._currentTreeLocalized?.title || state._currentTreeId || "";
			const msgHTML = `✅ <b>${pct}%</b> de <i>${escapeHTML(titleTree)}</i> (${done}/${total})`;

			ensureToastSetup();
			toast(msgHTML, 5600);            // ⬅️ duración duplicada

			// (eliminar) NO añadir mensaje en el chat:
			// addMessage("bot", `Has completado el ${msgHTML.replace("✅ ","")}.`, { asHTML:true });

		} catch {}

        // 3) Feedback inmediato en la tarjeta del chat (si existe)
        try {
          const row = btn.closest(".card")?.querySelector(".taxo-row");
          if (row){
            row.classList.remove("status-todo","status-progress");
            row.classList.add("status-done");
          }
        } catch {}

        // 4) Abrir el artículo (exacto o búsqueda)
        const q =
          (btn?.dataset.article || btn?.dataset.title || "").trim() ||
          (rel.split("›").pop() || "").trim() ||
          (title || "").trim();

        let ok = false;
        if (q) ok = await tryOpenExactArticle(q);
        if (!ok && q) ok = await kiwixSearchAndOpen(q, 10);
        if (!ok){
          state.wiki.pendingUrl = buildViewerSearchUrl(q || "");
        }
        return;
      }

      // --- Reanudar último
      if (action === "resumeLast"){
        const path = nodePath || "/";                     // absPath de la última hoja
        await setMode("wiki");
        await openTreeFromCatalog(treeId, title || treeId, path);
        const leaf = path.split(' › ').slice(-1)[0];
		toast?.(t("resume_toast").replace("{name}", leaf));
        return;
      }

      // --- Volver a categorías
      if (action === "backCats"){
        encarthaInitialView("resume");
        return;
      }
      // --- Volver a raíz del árbol actual o a categorías
      if (action === "backRoot"){
        if (treeId) encarthaRenderChildren(treeId, "/");
        else encarthaInitialView();
        return;
      }

    } catch (e) {
      console.warn(e);
    }
  }, true); // capture = true ayuda si hay otros manejadores
}


// ——— Navegación local por árbol (sin LLM) ———
function encarthaFindNode(root, path){
  // path: "/" para raíz, o "Titulo1 › Titulo2"
  if (!root) return null;
  if (!path || path === "/") return root;

  let parts = path.split("›").map(s=>String(s||"").trim()).filter(Boolean);

  // NUEVO: si el primer segmento coincide con el título del root, lo quitamos
  const rootTitle = String(root.title || "").trim();
  if (parts.length && parts[0] === rootTitle){
    parts.shift();
  }

  let node = root;
  for (const part of parts){
    const kids = Array.isArray(node.children) ? node.children : [];
    node = kids.find(ch => String(ch.title||"").trim() === part);
    if (!node) return null;
  }
  return node;
}

function encarthaAbsPath(tree, anyPath){
  const root = String(tree.title || "").trim();
  if (!anyPath || anyPath === "/") return root;
  const p = String(anyPath).trim();
  return p.startsWith(root) ? p : `${root} › ${p}`;
}

async function encarthaRenderChildren(treeId, path="/"){
  const t = (key)=> (I18N[state.lang] && I18N[state.lang][key]) || key;
  const trees = state._encarthaTrees || {};
  const tree  = trees[treeId];
  if (!tree){ toast(t("err_tree_not_loaded_cat")); return; }

  const node = encarthaFindNode(tree, path);
  if (!node){ toast(t("err_node_not_found")); return; }

  const kids = Array.isArray(node.children) ? node.children : [];
  if (!kids.length){
	const leafTitle = (String(path||"").split("›").pop() || "").trim();
	const html = `
	  <div class="markdown">
		<p>${t("libEmpty")||"Carpeta vacía"}</p>
		<div class="encartha-actions" style="display:flex;gap:8px;flex-wrap:wrap;">
		  <button class="btn-plain"
			data-encartha="openWiki"
			data-tree="${_html(treeId)}"
			data-node="${_html(path)}"
			data-title="${_html(leafTitle)}">🌐 ${t('consultWiki')||'Consultar en Wikipedia'}</button>
		</div>
	  </div>`;
	await encarthaReply(html);
	return;
  }

  // Base ABSOLUTA a partir del nodo actual (necesaria para métricas)
  const absBase = encarthaAbsPath(tree, path);

  // Cards por cada sub-rama hija
  const cards = kids.map(k=>{
    const title = String(k.title || "").trim();

    // Paths: relativo para navegar (data-node), ABSOLUTO para métricas
    const relChildPath = (path === "/" || !path) ? title : `${String(path).trim()} › ${title}`;
    const absChildPath = encarthaAbsPath(tree, relChildPath);

    // % de la sub-rama → estado (solo para el dot)
    let childPct = 0;
    try {
      const visited = loadProgressFor(treeId);
      childPct = calcPctForSubtree(tree, visited, absChildPath) || 0;   // ABSOLUTO
    } catch {}
    const status = (childPct >= 100) ? 'done' : (childPct > 0 ? 'progress' : 'todo');

    // Nº total de hojas bajo esa rama (ABSOLUTO)
    const totalElems = countLeavesUnder(tree, absChildPath) || 0;

    const isLeaf = (cleanChildren(k).length === 0);  // hoja si no tiene hijos

	const secondBtn = isLeaf
	  ? `<button class="btn-plain"
		   data-encartha="openWiki"
		   title="${t('consultWiki')||'Consultar en Wikipedia'}"
		   data-tree="${_html(treeId)}"
		   data-node="${_html(relChildPath)}"
		   data-title="${_html(k.wiki || title)}">🌐</button>`
	  : `<button class="btn-plain"
		   data-encartha="drill"
		   title="${t('drilldown')||'Entrar al detalle'}"
		   data-tree="${_html(treeId)}"
		   data-node="${_html(relChildPath)}">➕</button>`;
		   
	const firstBtn = isLeaf
	  ? ''   // ⬅️ en hojas NO mostramos el 🔎
	  : `<button class="btn-plain"
	       data-encartha="openTree"
	       title="${t('openStudy')||'Abrir y estudiar'}"
	       data-tree="${_html(treeId)}"
	       data-title="${_html(tree.title)}"
	       data-node="${_html(relChildPath)}">🔎</button>`;

    return `
      <div class="card small">
        <div class="row taxo-row status-${status}" style="align-items:center; gap:8px;">
          <span class="taxo-status-dot" aria-hidden="true"></span>
          <strong>${_html(title)}</strong>
          <small style="margin-left:auto;opacity:.8;">${totalElems} ${t("elements")||"elementos"}</small>
        </div>
        <div class="row" style="gap:8px;display:flex;flex-wrap:wrap;">
	     ${firstBtn}
	     ${secondBtn}
        </div>
      </div>`;
  }).join("");

  // Instrucciones sobre los iconos (entre h4 y los cards)
	const instr1 = t("encartha_instr_open");
	const instr2 = t("encartha_instr_drill");

  // Nota de navegación antes de las acciones
  const hintNav = `<p class="encartha-hint-nav">${t("encartha_hint_nav")}</p>`;

  // === NUEVO: encabezado + texto Encartha + instrucciones + cards + nav ===

  // Título compuesto "Árbol · Nivel actual"
  const rootTitle = String(tree.title || "").trim();
  const hereTitle = String(node.title || "").trim();
  const header = `${rootTitle}${hereTitle && hereTitle !== rootTitle ? " · " + hereTitle : ""}`;

  // MichaelEncarthaText (solo si NO es hoja y hay texto)
  let encarthaTextHTML = "";
  const isCurrentLeaf = cleanChildren(node).length === 0;
  const encarthaText = (!isCurrentLeaf && node.MichaelEncarthaText)
    ? String(node.MichaelEncarthaText || "").trim()
    : "";
  if (encarthaText) {
    // Lo pasamos por tu renderer Markdown para estilos homogéneos
    encarthaTextHTML = `<div class="encartha-intro">${renderMarkdown(encarthaText)}</div>`;
  }

  // Instrucciones (reutilizamos las de arriba)
  const instrBlock = `
    <p class="encartha-instructions">${instr1}</p>
    <p class="encartha-instructions">${instr2}</p>`;

  // Footer (botones volver) + nota de navegación
  const nav = renderEncarthaNavFooter(treeId);

  // Ensamblado final
  const html = `
    <div class="markdown">
      <h4>${_html(header)}</h4>
      ${encarthaTextHTML}
      ${instrBlock}
      <div class="cards" style="margin-top: 18px; margin-bottom: 18px;">${cards || `<em>${t("libEmpty")||"Empty"}</em>`}</div>
      ${hintNav}
      ${nav}
    </div>`;

  // Pintamos el mensaje y reactivamos los handlers
  await encarthaReply(html);
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

function mergeAgentsByName(a, b){
  const out = [];
  const seen = new Set();
  const push = (arr) => {
    for (const it of (arr || [])) {
      const k = normName(it.name || "");
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(it);
    }
  };
  push(a); push(b);
  return out;
}


function buildReferralCardsHTML(agents, titleText){
  if (state.mode !== "agents") return "";
  if (!agents || !agents.length) return "";

  const title = escapeHTML(titleText || t("suggestedAgentsTitle"));

  const cards = agents.map(a=>{
    const avatar = a.avatar ? absUrl(a.avatar) : "";
    const avatarHTML = avatar
      ? `<img src="${avatar}" alt="${escapeHTML(a.name)}"/>`
      : `<span class="initials">${escapeHTML(initials(a.name))}</span>`;

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
      <h4>${title}</h4>
      <div class="agents-grid">
        ${cards}
      </div>
    </div>`;
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

async function libraryEnsurePath(){
  if (!state.library.path) {
    state.library.path = libraryStartPath();
  }
}

function normalizeLibPath(p){
  p = String(p || "").replace(/\\/g,"/").replace(/^\/+/, "");
  const base = state.library?.base || "docs";
  // Solo recortamos "docs/" cuando NO estamos en la papelera
  if (base !== "trash" && p.startsWith("docs/")) {
    p = p.slice(5);
  }
  return p;
}

function libraryStartPath(){
  const base = state.library.base || "docs";
  if (base === "docs") {
    const lang = (state.lang || "en").slice(0, 2);
    // En docs empezamos en /<idioma> (ej: "es", "en", etc.)
    return libJoin(state.library?.root || "", lang);
  }
  // En media (video/music/images) raíz del sub-árbol → path vacío
  return "";
}

function libraryNavigateTo(rel){
  const norm = normalizeLibPath(rel);
  state.library.path = norm;
  libraryListRender(norm);
}

async function libraryMoveElement(sourceRel, targetRel) {
  const base = state.library.base || "docs";

  // Solo soportamos mover en secciones media/*
  if (!base.startsWith("media/")) {
    console.warn("[LIB] libraryMoveElement: base no es media/*:", base);
    return;
  }

  const curPath = state.library.path || "";

  // En media, los data-rel ya vienen relativos a la raíz de media/<sub>
  // (ej: "Carpeta1/tema.mp3"), así que NO añadimos curPath otra vez
  const sourcePath = String(sourceRel || "").replace(/\\/g, "/");

  let targetPath = "";

  // Caso especial: mover a nivel superior “..”
  if (targetRel === "..") {
    const parts = curPath.split("/").filter(Boolean);
    parts.pop(); // subimos un nivel
    targetPath = parts.join("/"); // puede quedar "" = raíz del subárbol
  } else {
    // targetRel también es relativo a la raíz del subárbol
    targetPath = String(targetRel || "").replace(/\\/g, "/");
  }

  // Evitar mover una carpeta dentro de sí misma (o subcarpeta)
  if (targetPath && sourcePath && targetPath.startsWith(sourcePath)) {
    console.warn("[LIB] Intento de mover dentro de sí mismo:", sourcePath, "→", targetPath);
    alert("⚠️ No puedes mover una carpeta dentro de sí misma.");
    return;
  }
  
  const body = { base, path: sourcePath, newPath: targetPath };

  const res = await fetch(`${BASE_URL}/api/media/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    try {
      const txt = await res.text();
      console.error("[LIB] move error", res.status, txt);
    } catch (e) {
      console.error("[LIB] move error", res.status);
    }
    alert("⚠️ Error moviendo archivo");
    return;
  }

  // Recargar la ruta actual (respetando state.library.path)
  await libraryListRender();
}


function libraryGoUp() {
  const cur = state.library.path ?? libraryStartPath();
  const next = libDirname(cur);
  if (next === "" && cur !== "") {         // ← permitir raíz
    state.library.path = "";
    return libraryListRender();
  }
  if (next && next !== cur) {
    state.library.path = next;
    libraryListRender();
  }
}

function buildMediaItemsFromState(sub){
  // sub debería ser "video", "music" o "images"
  sub = sub || "images";

  // 1) Fuente principal: resultado crudo de /api/media/list
  const curr  = (state.library && state.library.current) ? state.library.current : {};
  let files   = Array.isArray(curr.files) && curr.files.length
    ? curr.files
    : (Array.isArray(state.library?.items) ? state.library.items : []);

  // 2) Nos quedamos solo con archivos (por si vienen mezclados con dirs)
  files = files.filter(f => {
    // Si vienen ya normalizados como items[]
    if (f.type && f.type === "dir") return false;
    return true;
  });

  // 3) Para imágenes, filtramos por mime/ext
  files = files.filter(f => {
    if (sub !== "images") return true; // para video/music podríamos no filtrar

    const mime = String(f.mime || "").toLowerCase();
    const ext  = String(f.ext  || "").toLowerCase();

    if (mime.startsWith("image/")) return true;

    // Filtro por extensión “a prueba de balas”
    const imgExts = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"];
    return imgExts.some(e => ext === e || (f.name || "").toLowerCase().endsWith(e));
  });

  // 4) Normalizamos rel / name y construimos url para el visor
  const base   = state.library?.base || `media/${sub}`;
  const parts  = base.split("/");
  const subdir = parts[1] || sub;  // "video" | "music" | "images"

  return files.map(f => {
    const rawRel = f.rel || f.path || f.name || "";
    const rel    = String(rawRel).replace(/\\/g, "/");
    const name   = f.name || rel.split("/").pop() || rel;

    const url = `${BASE_URL}/api/media/file` +
      `?sub=${encodeURIComponent(subdir)}` +
      `&path=${encodeURIComponent(rel)}` +
      `&disposition=inline`;

    return {
      ...f,
      rel,
      name,
      url
    };
  });
}


function renderMediaPlaylist(){
  const box = document.getElementById("mediavList");
  if (!box) return;
  const items = _mediav.items || [];
  box.innerHTML = items.map((it, i) => {
    const active = (i === _mediav.idx) ? " active" : "";
    const ico = _mediav.sub === "video" ? "🎬" : "🎵";
    const ext = it.ext ? `<span class="meta">.${it.ext}</span>` : "";
    return `<div class="mediav-item${active}" data-i="${i}">
              <div>${ico} ${escapeHTML(it.name || it.rel)}</div>
              <div class="meta">${ext}</div>
            </div>`;
  }).join("");

  // Delegación de clic
  box.addEventListener("click", (e)=>{
    e.stopPropagation();   
	const row = e.target.closest(".mediav-item");
    if (!row) return;
    const i = +row.getAttribute("data-i");
    showMedia(i);
  }, { once:true });
}

async function attachSubtitlesIfAny(videoEl, sub, rel){
  // limpia tracks previos
  [...videoEl.querySelectorAll("track")].forEach(t => t.remove());

  const dir = _mediaDirOf(rel);
  const base = _mediaBaseOf(rel);
  const cand = [
    `${base}.vtt`,
    `${base}.es.vtt`,
    `${base}.en.vtt`,
    `${base}.ES.vtt`,
    `${base}.EN.vtt`
  ];
  for (const fn of cand){
    const relVtt = dir ? `${dir}/${fn}` : fn;
    const url = _mediaUrlOf(sub, relVtt);
    try {
      const r = await fetch(url, { method:"GET" });
      if (!r.ok) continue;
      const tr = document.createElement("track");
      tr.kind = "subtitles";
      tr.src = url;
      // marca idioma por sufijo
      if (/\.es(\.|$)/i.test(fn)) tr.srclang = "es";
      else if (/\.en(\.|$)/i.test(fn)) tr.srclang = "en";
      else tr.srclang = "";
      tr.label = tr.srclang ? `Subtítulos (${tr.srclang.toUpperCase()})` : "Subtítulos";
      tr.default = false;
      videoEl.appendChild(tr);
    } catch {}
  }
}

function showMedia(i){
  if (!_mediav.items.length) return;
  _mediav.idx = (i + _mediav.items.length) % _mediav.items.length;

  const it  = _mediav.items[_mediav.idx];
  const v   = document.getElementById("mediavVideo");
  const a   = document.getElementById("mediavAudio");
  const ttl = document.getElementById("mediavTitle");
  const root= document.getElementById("mediaViewer");

  if (!v || !a) return;

  // --- limpiar listeners de fallback previos ---
  if (v.__fallbackHandler) { try { v.removeEventListener("error", v.__fallbackHandler); } catch {} v.__fallbackHandler = null; }
  if (a.__fallbackHandler) { try { a.removeEventListener("error", a.__fallbackHandler); } catch {} a.__fallbackHandler = null; }

  // reset (esto puede disparar eventos en algunos navegadores, por eso existe _mediav.closing)
  try { v.pause(); } catch {}
  try { a.pause(); } catch {}
  v.classList.add("hidden"); a.classList.add("hidden");

  // Mejor que v.src="" para evitar errores fantasma
  try { v.removeAttribute("src"); v.load(); } catch {}
  try { a.removeAttribute("src"); a.load(); } catch {}

  if (ttl) ttl.textContent = it.name || it.rel || "";

  // --- fallback: abrir en Windows SOLO si NO puede reproducirse ---
  const fallbackToSystem = async (ev) => {
    // Si estamos cerrando o ya está oculto: NO hacer nada
    if (_mediav.closing) return;
    if (root && (root.classList.contains("hidden") || root.getAttribute("aria-hidden") === "true")) return;

    // Evita fallback si el src ya fue limpiado
    const cur = _mediaIsVideo() ? (v.currentSrc || v.src || "") : (a.currentSrc || a.src || "");
    if (!cur) return;

    // Solo si tenemos sub+rel (tu visor ya los maneja desde openMediaViewer)
    if (!_mediav.sub || !it || !it.rel) return;

    // Abrir con el reproductor por defecto del sistema (backend)
    try { await openInSystemPlayer(_mediav.sub, it.rel); } catch {}

    // Cerrar el visor (sin provocar otro fallback)
    try { closeMediaViewer(); } catch {}
  };

  if (_mediaIsVideo()){
    v.classList.remove("hidden");
    v.src = it.url;

    // Armamos fallback en "error"
    v.__fallbackHandler = fallbackToSystem;
    v.addEventListener("error", fallbackToSystem, { once:true });

    v.addEventListener("loadedmetadata", async ()=>{
      try { await attachSubtitlesIfAny(v, _mediav.sub, it.rel); } catch {}
      try { await v.play(); } catch {}
      updateCCState(v);
    }, { once:true });
  } else {
    a.classList.remove("hidden");
    a.src = it.url;

    // Armamos fallback en "error"
    a.__fallbackHandler = fallbackToSystem;
    a.addEventListener("error", fallbackToSystem, { once:true });

    a.addEventListener("canplay", ()=>{ try { a.play(); } catch{} }, { once:true });
  }

  renderMediaPlaylist(); // resalta activo
}

function prevMedia(){ showMedia(_mediav.idx - 1); }
function nextMedia(){ showMedia(_mediav.idx + 1); }

function updateCCState(videoEl){
  const btn = document.querySelector("[data-mediav-cc]");
  if (!videoEl || !btn) return;
  const tracks = videoEl.textTracks || [];
  const on = !!_mediav.ccEnabled && tracks.length > 0;
  for (let k=0;k<tracks.length;k++){
    tracks[k].mode = on ? "showing" : "hidden";
  }
  btn.setAttribute("aria-pressed", on ? "true" : "false");
}

async function openInSystemPlayer(sub, relPath) {
  try {
    const qs = new URLSearchParams({ sub, path: relPath });
    const res = await fetch(`${BASE_URL}/api/media/open?${qs.toString()}`, {
      method: "POST"
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // si tienes toast() úsalo, si no, comenta esta línea
    try { toast("Opened with system default player."); } catch {}
  } catch (e) {
    console.error("[MEDIA] openInSystemPlayer failed:", e);
    alert("Could not open with the system default player.");
  }
}

function libraryOpen(rel) {
  const base    = state.library.base || "docs";
  const normRel = normalizeLibPath(rel);
  const norm    = encodeURIComponent(normRel);

  // 📄 1) LIBRERÍA (docs) → usar visor interno
  if (base === "docs") {
    const url = `${BASE_URL}/api/library/file?path=${norm}&disposition=inline`;
    // ANTES: window.open(...)
    openDocViewer(url);
    return;
  }
  
  // 🧰 PORTABLE APPS — confirmar y lanzar .exe
  if (base === "media/portable_apps") {
    const name  = normRel.split("/").pop() || normRel;
    const title = t("portableAppsConfirmTitle") || "Launch app";
    const msg   = tfmt("portableAppsConfirmMsg", { name }) || `Do you want to start "${name}"?`;

    showConfirmDialog({
      title,
      message: msg,
      confirmLabel: t("portableAppsStart") || "Start",
      cancelLabel: t("resetNo") || "Cancel",
      onConfirm: async ()=>{
        // Esto llama a /api/media/open → os.startfile en Windows
        openInSystemPlayer("portable_apps", normRel);
      }
    });
    return;
  }

  // 📂 2) MEDIA/FILES — abrir con el programa por defecto del sistema
  if (base === "media/files") {
    openInSystemPlayer("files", normRel);
    return;
  }

  // 🖼️ 3) MEDIA/IMAGES — abrir con la galería de imágenes
  if (base === "media/images") {
    const items = buildMediaItemsFromState("images");
    if (!items.length) return;

    // Intentar localizar el índice de la imagen clicada
    const idx = items.findIndex(it =>
      it.rel === normRel ||
      it.rel === rel ||
      it.name === rel
    );
    const startIndex = idx >= 0 ? idx : 0;

    openImageViewer(items, startIndex);
    return;
  }

  // 🎬📻 4) MEDIA (video/music) — usar visor de media
  if (base.startsWith("media/")) {
    const sub  = base.split("/")[1]; // "video" | "music" | (otras)
    const kind = (sub === "video") ? "video" : "audio";
	
	const ext = (normRel.split(".").pop() || "").toLowerCase();

	// Reglas “tal cual” tu requisito:
	// - music: solo mp3 -> visor
	// - video: solo mp4 o mkv -> visor
	// - el resto -> Windows default app
	if (sub === "music" && ext !== "mp3") {
	  openInSystemPlayer("music", normRel);
	  return;
	}
	if (sub === "video" && !["mp4", "mkv"].includes(ext)) {
	  openInSystemPlayer("video", normRel);
	  return;
	}

    const src   = `${BASE_URL}/api/media/file?sub=${encodeURIComponent(sub)}&path=${norm}&disposition=inline`;
    const title = normRel.split("/").pop() || normRel;

    openMediaViewer(kind, src, title, { rel: normRel, sub });
    return;
  }
}



async function libraryList(path){
  const base = state.library.base || "docs";
  const normPath = normalizeLibPath(path);
  const params = new URLSearchParams();

  let url = "";

  if (base === "docs") {
    params.set("path", normPath);
    url = `${BASE_URL}/api/library/list?${params.toString()}`;
  } else if (base.startsWith("media/")) {
    // media/video, media/music, media/images, media/files
    const sub = base.split("/")[1]; // "video" | "music" | "images" | "files"
    params.set("sub", sub);
    params.set("path", normPath);
    url = `${BASE_URL}/api/media/list?${params.toString()}`;
  } else if (base === "trash") {
    // Papelera
    params.set("path", normPath);
    url = `${BASE_URL}/api/trash/list?${params.toString()}`;
  } else {
    // fallback seguro: tratar como docs
    params.set("path", normPath);
    url = `${BASE_URL}/api/library/list?${params.toString()}`;
  }

  const res  = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  // Guardamos SIEMPRE el "current" (path, parent, dirs, files...)
  state.library.current = data;

  const items = [];

  // Normalizamos siempre a una lista items[] con type = "dir" / "file"
  if (Array.isArray(data.dirs)) {
    for (const d of data.dirs) {
      items.push({
        type: "dir",
        name: d.name,
        rel:  d.rel,
        ...d
      });
    }
  }
  if (Array.isArray(data.files)) {
    for (const f of data.files) {
      items.push({
        type: "file",
        name: f.name,
        rel:  f.rel,
        ...f
      });
    }
  }

  return items;
}


function currentLibContext(){
  const base = state.library?.base || "docs";
  const path = state.library?.path || "";

  if (base === "docs") {
    return {
      kind: "docs",
      base,
      path,
      uploadUrl: `${BASE_URL}/api/library/upload`,
      mkdirUrl:  `${BASE_URL}/api/library/mkdir`,
      extra: {}
    };
  }

  if (base.startsWith("media/")) {
    const sub = base.split("/")[1]; // "video" | "music" | "images"
    return {
      kind: "media",
      base,
      path,
      uploadUrl: `${BASE_URL}/api/media/upload`,
      mkdirUrl:  `${BASE_URL}/api/media/mkdir`,
      extra: { sub }
    };
  }

  // fallback por seguridad
  return {
    kind: "docs",
    base: "docs",
    path,
    uploadUrl: `${BASE_URL}/api/library/upload`,
    mkdirUrl:  `${BASE_URL}/api/library/mkdir`,
    extra: {}
  };
}

// crea controles si no existen
function ensureLibToolbarExtras(){
  const bar = document.querySelector("#libraryView .library-toolbar, #libraryView .lib-toolbar");
  if (!bar || bar.querySelector(".lib-tools")) return;

  const tools = document.createElement("div");
  tools.className = "lib-tools";
  bar.appendChild(tools);

  // 🔎 Buscador
  const inp = document.createElement("input");
  inp.id = "libSearch";
  inp.className = "lib-search";
  inp.type = "search";
  inp.placeholder = t("libFilterPlaceholder") || "Filter…";
  inp.value = state.library.filter || "";
  tools.appendChild(inp);

  // ↕️ Orden
  const sel = document.createElement("select");
  sel.id = "libSort";
  sel.className = "lib-sort";

  const optName = document.createElement("option");
  optName.value = "name";
  optName.textContent = t("libSortName") || "Name";

  const optSize = document.createElement("option");
  optSize.value = "size";
  optSize.textContent = t("libSortSize") || "Size";

  const optType = document.createElement("option");
  optType.value = "type";
  optType.textContent = t("libSortType") || "Type";

  sel.appendChild(optName);
  sel.appendChild(optSize);
  sel.appendChild(optType);
  sel.value = state.library.sort || "name";
  tools.appendChild(sel);

  // 📁 Botón "Nueva carpeta"
  const mkdirBtn = document.createElement("button");
  mkdirBtn.id = "libMkdirBtn";
  mkdirBtn.type = "button";
  mkdirBtn.className = "btn-ghost lib-btn-mkdir";
  mkdirBtn.textContent = t("libNewFolder") || "📁 New folder";
  tools.appendChild(mkdirBtn);

mkdirBtn.addEventListener("click", (e) => {
  e.preventDefault();

  openLibNewFolderDialog(async (name) => {
    const ctx = currentLibContext();
    const form = new FormData();
    form.append("path", state.library.path || "");
    form.append("name", name);
    if (ctx.kind === "media" && ctx.extra.sub) {
      form.append("sub", ctx.extra.sub);
    }

    const res = await fetch(ctx.mkdirUrl, {
      method: "POST",
      body: form
    });

    if (!res.ok) {
      // Mejor usar tu sistema de toast que un alert nativo
      if (typeof toast === "function") {
        toast("⚠️ " + t("libMkdirError"));
      } else {
        alert(t("libMkdirError") || "Error creating folder");
      }
      return;
    }

    await libraryListRender();
  });
});

  // ⬆️ Dropzone (subida a la carpeta actual)
  const dzForm = document.createElement("form");
  dzForm.id = "libDropzoneForm";
  dzForm.className = "lib-dropzone dropzone";
  dzForm.action = "#";

  const dzLabel = document.createElement("span");
  dzLabel.className = "lib-dropzone-label";
  dzLabel.textContent = t("libUpload") || "⬆️ Upload";
  dzForm.appendChild(dzLabel);

  tools.appendChild(dzForm);

  // Listeners de filtro + orden (como antes)
  let tDebounce = 0;
  inp.addEventListener("input", ()=>{
    clearTimeout(tDebounce);
    tDebounce = setTimeout(()=>{
      state.library.filter = inp.value;
      libraryListRender();
    }, 150);
  });

  sel.addEventListener("change", ()=>{
    state.library.sort = sel.value;
    libraryListRender();
  });

  // Inicializar Dropzone si está disponible
  if (window.Dropzone) {
    try {
      if (libDropzone) {
        libDropzone.destroy();
        libDropzone = null;
      }

      libDropzone = new Dropzone(dzForm, {
        url: () => {
          const ctx = currentLibContext();
          return ctx.uploadUrl;
        },
        paramName: "file",
        maxFilesize: 1024,          // MB, por si subes cosas grandes
        uploadMultiple: false,
        addRemoveLinks: false,
        timeout: 0,
        previewsContainer: null,    // ⬅️ sin contenedor de previews
        previewTemplate: "<div></div>", // ⬅️ plantilla vacía → sin thumbnail ni texto extra
        clickable: true,
        dictDefaultMessage: t("libDropzoneHint") || "Drop files here or click to upload"
      });

      // Añadir parámetros path/sub en cada envío
      libDropzone.on("sending", (file, xhr, formData)=>{
        const ctx = currentLibContext();
        formData.append("path", state.library.path || "");
        if (ctx.kind === "media" && ctx.extra.sub) {
          formData.append("sub", ctx.extra.sub);
        }
      });

      // Tras subir todo, refrescar la lista
      libDropzone.on("queuecomplete", ()=>{
        libraryListRender();
      });
    } catch (err) {
      console.error("Dropzone init error", err);
    }
  } else {
    console.warn("Dropzone not loaded — upload zone disabled");
  }
}


// ordenadores
const LIB_SORT = {
  name: (a,b)=> (a.type===b.type ? a.name.localeCompare(b.name) : a.type==="dir" ? -1 : 1),
  size: (a,b)=> (a.type===b.type ? (b.size||0)-(a.size||0) : a.type==="dir" ? -1 : 1),
  type: (a,b)=> (a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
};

function fileIcon(ext = "") {
  ext = String(ext).toLowerCase();
  if (["md","markdown","txt","log"].includes(ext)) return "📄";
  if (["pdf"].includes(ext)) return "📕";
  if (["doc","docx","rtf","odt"].includes(ext)) return "📝";
  if (["xls","xlsx","ods","csv"].includes(ext)) return "📊";
  if (["ppt","pptx","odp"].includes(ext)) return "📈";
  if (["png","jpg","jpeg","gif","webp","svg"].includes(ext)) return "🖼️";
  if (["mp3","wav","flac","ogg","m4a"].includes(ext)) return "🎵";
  if (["mp4","mkv","webm","mov","avi"].includes(ext)) return "🎬";
  if (["zip","7z","rar","tar","gz","bz2"].includes(ext)) return "🗜️";
  if (["html","htm"].includes(ext)) return "🌐";
  if (["json","yml","yaml","xml","ini","cfg"].includes(ext)) return "🧾";
  return "📦";
}

function fmtSize(bytes) {
  if (bytes == null || isNaN(bytes)) return "";
  const u = ["B","KB","MB","GB","TB"];
  let i = 0, n = Number(bytes);
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function fmtDate(maybeEpoch) {
  // acepta segundos o milisegundos
  const ms = Number(maybeEpoch) > 1e12 ? Number(maybeEpoch) : Number(maybeEpoch) * 1000;
  try { return new Date(ms).toLocaleDateString(); } catch { return ""; }
}

// Oculta el botón ✏️ Edit si NO existe el JSON de Excalidraw asociado
async function filterPaintImageEditorButtons() {
  const base = state.library?.base || "docs";
  // Solo tiene sentido en la sección de imágenes
  if (base !== "media/images") return;

  const buttons = document.querySelectorAll(".lib-open-editor-btn[data-rel]");
  for (const btn of buttons) {
    const rel = btn.getAttribute("data-rel") || "";
    const normRel = rel.replace(/\\/g, "/");

    // Solo nos interesa la carpeta "Paint Image Files"
    if (!normRel.startsWith("Paint Image Files/")) continue;

    // Nombre del archivo de imagen: "mi_dibujo.png"
    const fileName = normRel.split("/").pop() || "";
    // Base "mi_dibujo"
    const safe = fileName.replace(/\.[^.]+$/, "");

    const exists = await whiteboardFileExists(safe);
    if (!exists) {
      // Si no existe el JSON, quitamos el botón de Edit
      btn.remove();
      // Si prefieres ocultarlo en vez de eliminarlo:
      // btn.style.display = "none";
    }
  }
}


// Renderiza lista + ruta
async function libraryListRender(pathOverride){
  const base = state.library?.base || "docs";
  
  // Mostrar/ocultar controles de crear carpeta / subir según sección
  const inTrash = (base === "trash");
  const mkdirBtn = document.getElementById("libMkdirBtn");
  const dropForm = document.getElementById("libDropzoneForm");
  if (mkdirBtn) {
    mkdirBtn.classList.toggle("hidden", inTrash);
    mkdirBtn.disabled = inTrash;
  }
  if (dropForm) {
    dropForm.classList.toggle("hidden", inTrash);
  }

  // 👉 NUEVO: mostrar/ocultar barra de acciones masivas de la papelera
  const trashActions = document.getElementById("libTrashActions");
  if (trashActions) {
    // visible solo en la papelera
    trashActions.classList.toggle("hidden", !inTrash);
  }
  // 👈 FIN NUEVO
  
  // 📁 Path efectivo (parametro → state.library.path → inicio por defecto)
  let effectivePath;
  if (typeof pathOverride === "string") {
    effectivePath = pathOverride;
  } else if (state.library.path === undefined || state.library.path === null) {
    effectivePath = libraryStartPath();
  } else {
    // ← respeta "" (raíz /docs o raíz de media)
    effectivePath = state.library.path;
  }

  // Normalizar si existe helper
  if (typeof normalizeLibPath === "function") {
    effectivePath = normalizeLibPath(effectivePath);
  }

  state.library.path = effectivePath;
  
  // al cambiar de carpeta, limpiar selección múltiple
  if (typeof _libMultiSelection !== "undefined") {
    _libMultiSelection.clear();
  }

  // Asegurar toolbar (buscador, sort, dropzone…)
  ensureLibToolbarExtras();

  let items = [];
  try {
    items = await libraryList(effectivePath);
  } catch (e) {
    console.error(e);
    state.library.items = [];
    if (typeof libList !== "undefined" && libList) {
      libList.innerHTML = `<div class="muted" style="padding:1rem;">⚠️ ${escapeHTML(String(e.message || "Error"))}</div>`;
    }
    if (typeof libEmpty !== "undefined" && libEmpty) {
      libEmpty.classList.remove("hidden");
    }
    try { renderLibBreadcrumb(base, effectivePath || ""); } catch {}
    return;
  }

  // Guardar en estado
  state.library.items = items;

  // 🔎 Filtro
  if (state.library.filter) {
    const q = state.library.filter.toLowerCase();
    items = items.filter(e => (e.name || "").toLowerCase().includes(q));
  }

  // ↕️ Orden
  items.sort(LIB_SORT[state.library.sort] || LIB_SORT.name);

  // Ruta (breadcrumbs)
  try { renderLibBreadcrumb(base, state.library.path || ""); } catch {}
  
  // ✅ Marcar vista portable apps para CSS
  const listEl = document.getElementById("libList");
  if (listEl) {
    listEl.classList.toggle("portable-apps-view", base === "media/portable_apps");
  }

  if (typeof libList === "undefined" || !libList) return;

  const curPath = state.library.path || "";
  const atRoot  = !curPath; // raíz de docs / media (no se puede subir más)

  // Carpeta vacía
  if (!items.length && atRoot) {
    libList.innerHTML = "";
    if (typeof libEmpty !== "undefined" && libEmpty) {
      libEmpty.classList.remove("hidden");
    }
    return;
  }
  if (typeof libEmpty !== "undefined" && libEmpty) {
    libEmpty.classList.add("hidden");
  }

  // 🧾 Pintar filas
  const rows = [];

  // 👆 Carpeta “..” para subir un nivel (solo si no estamos en la raíz de la sección)
  if (!atRoot) {
    rows.push(`
      <a href="#"
         class="lib-row lib-row-up"
         draggable="true"
         data-type="dir"
         data-rel="..">
        <span class="lib-icon">📁</span>
        <span class="lib-name">..</span>
        <span class="lib-meta-wrap"></span>
      </a>`);
  }

  // Resto de elementos normales
  rows.push(...items.map(entry => {
    const base    = state.library?.base || "docs"; 
	const isDir = entry.type === "dir";
	let icon    = isDir ? "📁" : "📄";

	if (!isDir && base === "media/portable_apps" && (entry.ext || "").toLowerCase() === "exe") {
	  const relIcon = (entry.path || entry.rel || entry.name || "");
	  const u = `${BASE_URL}/api/portable_apps/icon?path=${encodeURIComponent(relIcon)}`;
	  icon = `<img class="lib-exe-icon" src="${u}" alt="exe" onerror="this.style.display='none';">`;
	}
    const name    = entry.name || "";
	const desc = (entry.desc || "").trim();

	// Si es .exe en portable apps -> nombre + descripción debajo
	const isPortableExe = (!isDir && base === "media/portable_apps" && (entry.ext || "").toLowerCase() === "exe");

	const nameHtml = isPortableExe
	  ? `
		<span class="lib-title">
		  <span class="lib-name">${escapeHTML(name)}</span>
		  ${desc ? `<span class="lib-desc">${escapeHTML(desc)}</span>` : ""}
		</span>
	  `
	  : `<span class="lib-name">${escapeHTML(name)}</span>`;

    const rel     = entry.path || entry.rel || "";
    const typeAttr = isDir ? "dir" : "file";

    let metaHtml      = "";
    let openEditorBtn = "";

    if (!isDir) {
      // Tamaño, tipo de fichero, etc.
      if (typeof entry.size === "number") {
        metaHtml += `<span class="lib-size">${formatBytes(entry.size)}</span>`;
      }
      if (entry.ext) {
        metaHtml += `<span class="lib-ext">${entry.ext}</span>`;
      }

      // Solo mostrar botón ✏️ Edit en:
      // base = "media/images"  AND  rel empieza por "Paint Image Files/"
      const relNorm = String(rel || "").replace(/\\/g, "/");

      if (base === "media/images" && relNorm.startsWith("Paint Image Files/")) {
        openEditorBtn = `
          <button type="button"
                  class="ghost lib-open-editor-btn"
                  data-rel="${rel}">
            ✏️ Edit
          </button>`;
      } else {
        openEditorBtn = ""; // en cualquier otro caso, sin botón
      }
    }

    // 🗑️ Botón de borrar (para archivos y carpetas)
    let restoreBtnHtml = "";
    let deleteBtnHtml = "";

    // Para evitar problemas con comillas en el atributo onclick
    const relForOnclick = rel.replace(/'/g, "\\'");

    if (base === "trash") {
      // 🗑️ En la papelera:
      //   - Archivos: ♻️ Restaurar + 🗑️ Borrar definitivo
      //   - Carpetas: SOLO 🗑️ Borrar definitivo
      if (typeAttr === "file") {
        restoreBtnHtml = `
          <button type="button"
                  class="lib-restore-btn"
                  data-rel="${escapeHTML(rel)}"
                  onclick="onTrashRestoreClick(event, '${relForOnclick}')">
            ♻️
          </button>`;
      }

      deleteBtnHtml = `
        <button type="button"
                class="lib-delete-btn"
                data-type="${escapeHTML(typeAttr)}"
                data-rel="${escapeHTML(rel)}">
          🗑️
        </button>`;
    } else {
      // Fuera de la papelera: borrar normal (mueve a la papelera)
      deleteBtnHtml = `
        <button type="button"
                class="lib-delete-btn"
                data-type="${escapeHTML(typeAttr)}"
                data-rel="${escapeHTML(rel)}">
          🗑️
        </button>`;
    }

    const isDirFlag = (typeAttr === "dir");

    // metaHtml ya existe; añadimos la ruta original solo en papelera y solo para archivos
    let originalHtml = "";
    if (base === "trash" && !isDirFlag && entry.original) {
      originalHtml = `<span class="lib-meta-original">(${escapeHTML(entry.original)})</span>`;
    }

    const right = `
      <span class="lib-meta-wrap">
        ${metaHtml}
        ${originalHtml}
        ${openEditorBtn}
        ${restoreBtnHtml}
        ${deleteBtnHtml}
      </span>`;
 

	return `
	  <a href="#"
		 class="lib-row"
		 draggable="true"
		 data-type="${escapeHTML(typeAttr)}"
		 data-rel="${escapeHTML(rel)}">
		<span class="lib-icon">${icon}</span>
		${nameHtml}
		${right}
	  </a>`;
  }));

  libList.innerHTML = rows.join("");
  filterPaintImageEditorButtons();
  setupLibraryDragDrop();
}

// ===== SYNC (media entre Offlineds) =======================================

async function fetchSyncPeers() {
  try {
    const res = await fetch(`${BASE_URL}/api/sync/peers`);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const peers = Array.isArray(data.peers) ? data.peers : [];
    state.sync.peers = peers;
    if (!state.sync.peer && peers.length) {
      state.sync.peer = peers[0].id;
    }
    return peers;
  } catch (err) {
    console.error("[SYNC] fetch peers error:", err);
    state.sync.peers = [];
    return [];
  }
}

async function syncEnsurePeersAndList() {
  const peerSelect = document.getElementById("syncPeerSelect");
  const subSelect  = document.getElementById("syncSubSelect");
  const listEl     = document.getElementById("syncList");
  const noPeersEl  = document.getElementById("syncNoPeers");
  const pathLabel  = document.getElementById("syncPathLabel");

  if (!peerSelect || !subSelect || !listEl || !noPeersEl) return;

  // Reset UI
  noPeersEl.classList.add("hidden");
  listEl.innerHTML = "";
  pathLabel.textContent = "";

  const peers = await fetchSyncPeers();

  if (!peers.length) {
    noPeersEl.textContent = t("syncNoPeers");
    noPeersEl.classList.remove("hidden");
    peerSelect.disabled = true;
    subSelect.disabled  = true;
    return;
  }

  // Rellenar select de peers
  peerSelect.disabled = false;
  peerSelect.innerHTML = peers.map(p => {
    const label = p.label || p.id;
    return `<option value="${escapeHTML(p.id)}">${escapeHTML(label)}</option>`;
  }).join("");

  if (state.sync.peer) {
    peerSelect.value = state.sync.peer;
  } else {
    state.sync.peer = peerSelect.value;
  }

  // Select de tipo (sub)
  subSelect.disabled = false;
  subSelect.value = state.sync.sub || "images";

  peerSelect.onchange = () => {
    state.sync.peer = peerSelect.value;
    state.sync.path = "";
    syncListRemote();
  };

  subSelect.onchange = () => {
    state.sync.sub = subSelect.value;
    state.sync.path = "";
    syncListRemote();
  };

  // Primera carga
  await syncListRemote();
}

async function syncListRemote(pathOverride) {
  const listEl    = document.getElementById("syncList");
  const noPeersEl = document.getElementById("syncNoPeers");
  const pathLabel = document.getElementById("syncPathLabel");

  if (!listEl || !pathLabel) return;

  const peer = state.sync.peer;
  const sub  = state.sync.sub || "images";

  if (!peer) {
    if (noPeersEl) {
      noPeersEl.textContent = t("syncNoPeers");
      noPeersEl.classList.remove("hidden");
    }
    return;
  }

  if (typeof pathOverride === "string") {
    state.sync.path = pathOverride;
  }

  const relPath = state.sync.path || "";
  pathLabel.textContent = relPath ? `/${relPath}` : "/";

  listEl.innerHTML = `<div class="muted">${t("loading") || "Loading..."}</div>`;

  try {
    const params = new URLSearchParams();
    params.set("peer", peer);
    params.set("sub", sub);
    params.set("path", relPath);

    const res = await fetch(`${BASE_URL}/api/sync/media/list?${params.toString()}`);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();

    const dirs  = Array.isArray(data.dirs)  ? data.dirs  : [];
    const files = Array.isArray(data.files) ? data.files : [];
    const rows  = [];

    // Fila ".." para subir si hay parent
    if (typeof data.parent === "string" && (data.parent || relPath)) {
      rows.push(`
        <a href="#" class="lib-row sync-dir" data-type="dir" data-rel="${escapeHTML(data.parent || "")}">
          <span class="lib-icon">⬆️</span>
          <span class="lib-name">..</span>
          <span class="lib-meta-wrap"></span>
        </a>
      `);
    }

    for (const d of dirs) {
      const rel = d.rel || d.path || "";
      rows.push(`
        <a href="#" class="lib-row sync-dir" data-type="dir" data-rel="${escapeHTML(rel)}">
          <span class="lib-icon">📁</span>
          <span class="lib-name">${escapeHTML(d.name || rel)}</span>
          <span class="lib-meta-wrap"></span>
        </a>
      `);
    }

    for (const f of files) {
      const rel = f.rel || f.path || "";
      const sizeLabel = (typeof f.size === "number") ? formatBytes(f.size) : "";
      rows.push(`
        <a href="#" class="lib-row sync-file" data-type="file" data-rel="${escapeHTML(rel)}">
          <span class="lib-icon">📄</span>
          <span class="lib-name">${escapeHTML(f.name || rel)}</span>
          <span class="lib-meta-wrap">
            ${sizeLabel ? `<span class="lib-size">${sizeLabel}</span>` : ""}
            <button type="button" class="btn-secondary sync-import-one" data-rel="${escapeHTML(rel)}">
              ⬇️ ${t("syncImportOne")}
            </button>
          </span>
        </a>
      `);
    }

    listEl.innerHTML = rows.length ? rows.join("") : `<div class="muted">${t("libEmpty")}</div>`;

    // Navegar directorios
    listEl.querySelectorAll(".sync-dir").forEach(row => {
      row.addEventListener("click", (e) => {
        e.preventDefault();
        const rel = row.getAttribute("data-rel") || "";
        state.sync.path = rel;
        syncListRemote();
      });
    });

    // Importar un archivo
    listEl.querySelectorAll(".sync-import-one").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const rel = btn.getAttribute("data-rel") || "";
        if (!rel) return;
        await syncImportFiles([rel]);
      });
    });

  } catch (err) {
    console.error("[SYNC] list error:", err);
    listEl.innerHTML = `<div class="muted">Error loading remote files.</div>`;
  }
}

async function syncImportFiles(relPaths) {
  if (!Array.isArray(relPaths) || !relPaths.length) return;
  const peer = state.sync.peer;
  const sub  = state.sync.sub || "images";
  if (!peer) return;

  try {
    const res = await fetch(`${BASE_URL}/api/sync/media/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peer, sub, paths: relPaths })
    });
    const data = await res.json();
    if (!res.ok || data.status !== "ok") {
      console.error("[SYNC] import error:", data);
      alert("⚠️ Error importing files.");
      return;
    }

    const count = Array.isArray(data.imported) ? data.imported.length : 0;
    toast(`✅ ${count} ${t("libFilesImported")}`);
  } catch (err) {
    console.error("[SYNC] import error:", err);
    alert("⚠️ Error importing files.");
  }
}


// === Selección múltiple en Librería ===
let _libMultiSelection = new Set();   // guarda los data-rel seleccionados

function clearLibSelection() {
  if (!_libMultiSelection) return;
  _libMultiSelection.clear();
  syncLibSelectionStyles();
}

function syncLibSelectionStyles() {
  const list = document.getElementById("libList");
  if (!list) return;

  const rows = list.querySelectorAll(".lib-row");
  rows.forEach(row => {
    const rel  = row.getAttribute("data-rel") || "";
    const type = row.getAttribute("data-type") || "";
    if (type === "dir" && rel === "..") {
      // nunca marcamos la carpeta ".."
      row.classList.remove("selected");
      return;
    }

    if (_libMultiSelection.has(rel)) {
      row.classList.add("selected");
    } else {
      row.classList.remove("selected");
    }
  });

  // Limpia selecciones que ya no existen visualmente
  const valid = new Set();
  rows.forEach(row => {
    const rel = row.getAttribute("data-rel") || "";
    if (!rel) return;
    if (_libMultiSelection.has(rel)) {
      valid.add(rel);
    }
  });
  _libMultiSelection = valid;
}

// === DRAG & DROP en librería ===
function setupLibraryDragDrop() {
  const list = document.getElementById("libList");
  if (!list) return;

  list.querySelectorAll(".lib-row").forEach(row => {
    const rel  = row.getAttribute("data-rel") || "";
    const type = row.getAttribute("data-type") || "";

    // 🖱️ CTRL + clic → selección múltiple
    row.addEventListener("click", (e) => {
      // Si no hay CTRL, usamos comportamiento normal (dejamos que actúe el listener global)
      if (!e.ctrlKey) {
        // En clic normal limpiamos selección para que sólo quede lo que se abra
        if (_libMultiSelection && _libMultiSelection.size) {
          _libMultiSelection.clear();
          syncLibSelectionStyles();
        }
        return;
      }

      // Con CTRL: gestionamos selección y evitamos navegar/abrir
      e.preventDefault();
      e.stopPropagation();

      // No seleccionamos la carpeta ".."
      if (type === "dir" && rel === "..") return;

      if (_libMultiSelection.has(rel)) {
        _libMultiSelection.delete(rel);   // deseleccionar
      } else {
        _libMultiSelection.add(rel);      // seleccionar
      }
      syncLibSelectionStyles();
    }, true); // 👈 en captura, para que salte antes que el listener delegado principal

    // 🎯 Animación al empezar a arrastrar
    row.addEventListener("dragstart", e => {
      const rowRel  = row.getAttribute("data-rel") || "";
      const rowType = row.getAttribute("data-type") || "";

      // Si este elemento NO estaba en la selección, la reseteamos
      // y seleccionamos solo este, como en un explorador de archivos.
      if (!_libMultiSelection.has(rowRel)) {
        _libMultiSelection.clear();
        // De nuevo, no marcamos ".."
        if (!(rowType === "dir" && rowRel === "..")) {
          _libMultiSelection.add(rowRel);
        }
      }

      syncLibSelectionStyles();

      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/rel", rowRel);
      e.dataTransfer.setData("text/type", rowType);
      row.classList.add("dragging");
    });

    row.addEventListener("dragend", e => {
      row.classList.remove("dragging");
    });

    // Permite soltar encima de carpetas (y "..") con highlight
    row.addEventListener("dragover", e => {
      e.preventDefault();
      row.classList.add("drag-over");
    });

    row.addEventListener("dragleave", e => {
      row.classList.remove("drag-over");
    });

    row.addEventListener("drop", async e => {
      e.preventDefault();
      row.classList.remove("drag-over");

      const sourceRel  = e.dataTransfer.getData("text/rel");
      const targetRel  = row.getAttribute("data-rel") || "";
      const targetType = row.getAttribute("data-type") || "";

      // Nada que mover
      if (!sourceRel) return;

      // Solo permitimos soltar sobre carpetas o la carpeta especial ".."
      if (targetType !== "dir" && targetRel !== "..") {
        return;
      }

      // --- Multi-move ---
      let pathsToMove = [];

      // Si hay selección y el origen forma parte de ella -> movemos todos los seleccionados
      if (_libMultiSelection && _libMultiSelection.size > 0 && _libMultiSelection.has(sourceRel)) {
        pathsToMove = Array.from(_libMultiSelection);
      } else {
        // Si no, sólo uno
        pathsToMove = [sourceRel];
      }

      try {
        for (const p of pathsToMove) {
          // evitar mover ".." o cadenas vacías
          if (!p || p === "..") continue;
          await libraryMoveElement(p, targetRel);
        }
      } catch (err) {
        console.error("[LIB] move error (frontend):", err);
        alert("⚠️ Error moviendo archivo");
      }
    });
  });
}

function _currentMediaSubFromBase(){
  const base = state.library?.base || "docs";
  if (!base.startsWith("media/")) return null;
  const parts = base.split("/");
  return parts[1] || null;  // "video", "music" o "images"
}

function showLibDeleteConfirm({ rel, name, type }){
  const base = state.library?.base || "docs";
  const displayName = name || rel;

  if (base === "trash") {
    // Borrado definitivo
    const title = t("trashDeleteConfirmTitle") || t("mediaDeleteConfirmTitle");
    const msg   = tfmt("trashDeleteConfirmMsg", { name: displayName })
               || tfmt("mediaDeleteConfirmMsg", { name: displayName });

    showConfirmDialog({
      title,
      message: msg,
      confirmLabel: t("mediaDelete"),
      cancelLabel: t("resetNo"),
      onConfirm: () => libDelete(rel, type)
    });
  } else {
    // Borrado normal → mover a la papelera
    const title = t("mediaDeleteConfirmTitle");
    const msg   = tfmt("mediaDeleteConfirmMsg", { name: displayName });

    showConfirmDialog({
      title,
      message: msg,
      confirmLabel: t("mediaDelete"),
      cancelLabel: t("resetNo"),
      onConfirm: () => libDelete(rel, type)
    });
  }
}

// Handler directo para el botón ♻️ de restaurar en la papelera
window.onTrashRestoreClick = function (event, rel) {
  event.preventDefault();
  event.stopPropagation(); // 🚫 que la fila no se quede el click

  const name = (rel || "").split("/").pop() || rel;

  const title = t("trashRestoreTitle") || "Restore item";
  const msg   = tfmt("trashRestoreConfirmMsg", { name }) 
             || `Restore "${name}" to its original location?`;

  showConfirmDialog({
    title,
    message: msg,
    confirmLabel: t("trashRestore") || "Restore",
    cancelLabel: t("resetNo"),
    onConfirm: () => {
      trashRestore(rel);
    }
  });
};

function onTrashRestoreAllClick(event){
  event.preventDefault();

  const base = state.library?.base || "docs";
  if (base !== "trash") return;

  // Solo archivos (mismo comportamiento que el botón ♻️ de cada fila)
  const fileRows = Array.from(
    document.querySelectorAll("#libList .lib-row[data-type='file']")
  );

  const rels = fileRows
    .map(row => row.dataset.rel)
    .filter(Boolean);

  if (!rels.length) {
    // Papelera vacía → nada que restaurar
    return;
  }

  const title = t("trashRestoreAllTitle") || t("trashRestoreTitle") || "Restore all items";
  const msg   = tfmt("trashRestoreAllConfirmMsg", { count: rels.length })
             || `Do you want to restore ${rels.length} items from the recycle bin?`;

  showConfirmDialog({
    title,
    message: msg,
    confirmLabel: t("trashRestoreAll") || t("trashRestore") || "Restore",
    cancelLabel: t("resetNo"),
    onConfirm: async () => {
      // Restauramos todos en bloque y luego refrescamos una sola vez
      for (const rel of rels) {
        try {
          await fetch(`${BASE_URL}/api/trash/restore`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: rel })
          });
        } catch (err) {
          console.error("[TRASH] Error restoring:", rel, err);
        }
      }
      await libraryListRender();
    }
  });
}

function onTrashDeleteAllClick(event){
  event.preventDefault();

  const base = state.library?.base || "docs";
  if (base !== "trash") return;

  // Archivos y carpetas
  const rows = Array.from(
    document.querySelectorAll("#libList .lib-row[data-rel]")
  );

  const rels = rows
    .map(row => ({
      rel: row.dataset.rel,
      type: row.dataset.type || "file"
    }))
    .filter(it => it.rel);

  if (!rels.length) {
    // Papelera vacía
    return;
  }

  const title = t("trashDeleteAllTitle") || t("trashDeleteConfirmTitle") || "Delete permanently";
  const msg   = tfmt("trashDeleteAllConfirmMsg", { count: rels.length })
             || `This will permanently delete ${rels.length} items from the recycle bin. Continue?`;

  showConfirmDialog({
    title,
    message: msg,
    confirmLabel: t("trashDeleteAll") || t("mediaDelete") || "Delete",
    cancelLabel: t("resetNo"),
    onConfirm: async () => {
      for (const item of rels) {
        const params = new URLSearchParams({ path: item.rel });
        try {
          await fetch(`${BASE_URL}/api/trash/delete?${params.toString()}`, {
            method: "DELETE"
          });
        } catch (err) {
          console.error("[TRASH] Error deleting:", item.rel, err);
        }
      }
      await libraryListRender();
    }
  });
}

async function libDelete(rel, type){
  const base    = state.library?.base || "docs";
  const mediaSub = _currentMediaSubFromBase();

  try {
    if (base === "trash") {
      // Borrado definitivo desde la papelera
      const params = new URLSearchParams({ path: rel });
      const res = await fetch(`${BASE_URL}/api/trash/delete?${params.toString()}`, {
        method: "DELETE"
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } else if (mediaSub) {
      // Estamos en media (video/music/images/files) → enviar a papelera
      const params = new URLSearchParams({
        sub: mediaSub,
        path: rel
      });
      const res = await fetch(`${BASE_URL}/api/media/delete?${params.toString()}`, {
        method: "DELETE"
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } else {
      // Estamos en docs (librería) → enviar a papelera
      const params = new URLSearchParams({ path: rel });
      const res = await fetch(`${BASE_URL}/api/library/delete?${params.toString()}`, {
        method: "DELETE"
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }

    // Volver a cargar la lista actual
    await libraryListRender();

  } catch (err) {
    console.error("[LIB] Error deleting:", err);
    alert("Error deleting file/folder");
  }
}

async function trashRestore(rel){
  try {
    const res = await fetch(`${BASE_URL}/api/trash/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: rel })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await libraryListRender();
  } catch (err) {
    console.error("[TRASH] Error restoring:", err);
    alert("Error restoring item from trash");
  }
}


// === Visor de imágenes (modal + carrusel) ===
let _imgv = { items: [], idx: 0, esc: null };

/** Aplica el zoom (%) a la imagen principal del visor */
function setImgvZoom(percent) {
  const img    = document.getElementById("imgvMain");
  const slider = document.getElementById("imgvZoomRange");

  let p = parseInt(percent, 10);
  if (!Number.isFinite(p)) p = 100;
  // Limitar entre 10% y 300%
  p = Math.min(300, Math.max(10, p));

  if (slider) slider.value = p;

  if (!img) return;
  const scale = p / 100;
  img.style.transform = `scale(${scale})`;
  img.style.transformOrigin = "center center";
}

function openImageViewer(items, startIndex = 0) {
  _imgv.items = items || [];
  _imgv.idx = Math.min(Math.max(0, startIndex | 0), Math.max(0, _imgv.items.length - 1));

  const root = document.getElementById("imgViewer");
  if (!root) return;

  // ⚙️ Configura barra de zoom
  const zoomRange = document.getElementById("imgvZoomRange");
  if (zoomRange && !zoomRange._bound) {
    zoomRange.addEventListener("input", (e) => {
      setImgvZoom(e.target.value);
    });
    zoomRange._bound = true; // para no duplicar listeners
  }
  // Resetear zoom cada vez que abrimos el visor
  setImgvZoom(100);

  // Pinta miniaturas
  const strip = document.getElementById("imgvStrip");
  strip.innerHTML = "";
  _imgv.items.forEach((it, i) => {
    const thumb = document.createElement("button");
    thumb.className = "imgv-thumb";
    thumb.style.backgroundImage = `url("${it.url}")`;
    thumb.setAttribute("role", "option");
    thumb.setAttribute("aria-label", it.name || `Image ${i + 1}`);
    thumb.addEventListener("click", () => showImage(i));
    strip.appendChild(thumb);
  });

  // Eventos nav/cierre
  root.querySelectorAll("[data-close]")?.forEach(btn => {
    btn.addEventListener("click", closeImageViewer, { once: true });
  });
  root.querySelector("[data-prev]")?.addEventListener("click", prevImage, { once: false });
  root.querySelector("[data-next]")?.addEventListener("click", nextImage, { once: false });

  // Teclado: ← → navegan y Esc cierra
  _imgv.esc = (e) => {
    if (e.key === "Escape")           closeImageViewer();
    else if (e.key === "ArrowLeft")   prevImage();
    else if (e.key === "ArrowRight")  nextImage();
  };
  document.addEventListener("keydown", _imgv.esc);

  // Mostrar visor y primera imagen
  root.classList.remove("hidden");
  root.setAttribute("aria-hidden", "false");
  showImage(_imgv.idx);

  // 🖱️ Desplazamiento horizontal con la rueda en el carrusel
  const stripEl = document.getElementById("imgvStrip");
  if (stripEl && !stripEl._wheelBound) {
    stripEl.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
        e.preventDefault();
        stripEl.scrollLeft += e.deltaY;
      }
    }, { passive: false });
    stripEl._wheelBound = true;
  }
}

function closeImageViewer() {
  const root = document.getElementById("imgViewer");
  if (!root) return;

  root.classList.add("hidden");
  root.setAttribute("aria-hidden", "true");

  if (_imgv.esc) document.removeEventListener("keydown", _imgv.esc);
  _imgv = { items: [], idx: 0, esc: null };
}

function showImage(i) {
  if (!_imgv.items.length) return;
  _imgv.idx = (i + _imgv.items.length) % _imgv.items.length;

  const it = _imgv.items[_imgv.idx];
  const img = document.getElementById("imgvMain");
  const cap = document.getElementById("imgvCaption");

  img.src = it.url;
  img.alt = it.name || "image";
  cap.textContent = it.name || "";

  // Marca miniatura activa
  const thumbs = Array.from(document.querySelectorAll("#imgvStrip .imgv-thumb"));
  thumbs.forEach((th, k) => th.classList.toggle("active", k === _imgv.idx));
}

function prevImage() { showImage(_imgv.idx - 1); }
function nextImage() { showImage(_imgv.idx + 1); }

/* ===== Visor de media (HTML5 video/audio) ===== */
function openMediaViewer(kind, srcOrUrl, title, opts = {}){
  const root  = document.getElementById("mediaViewer");
  const v     = document.getElementById("mediavVideo");
  const a     = document.getElementById("mediavAudio");
  const ttl   = document.getElementById("mediavTitle");
  if (!root || !v || !a) return;

  // Detecta sub (video|music) y rel clicado si lo hay
  const base = state.library.base || "media/video";
  const sub  = (opts.sub || base.split("/")[1] || "video");
  const rel  = opts.rel || null;

  _mediav.sub  = sub;
  _mediav.kind = (kind === "video") ? "video" : "audio";
  _mediav.items = buildMediaItemsFromState(sub);

  // Punto de inicio
  let start = 0;
  if (rel) {
    const j = _mediav.items.findIndex(it => it.rel === rel || it.name === rel);
    start = Math.max(0, j);
  } else if (srcOrUrl) {
    const j = _mediav.items.findIndex(it => it.url === srcOrUrl);
    if (j >= 0) start = j;
  }

  // Título provisional si no entra por playlist
  if (ttl) ttl.textContent = title || (rel || srcOrUrl || "").split("/").pop() || "";

  // Botones
  root.querySelector("[data-mediav-prev]")?.addEventListener("click", prevMedia);
  root.querySelector("[data-mediav-next]")?.addEventListener("click", nextMedia);
  const ccBtn = root.querySelector("[data-mediav-cc]");
  if (ccBtn){
    ccBtn.addEventListener("click", ()=>{
      _mediav.ccEnabled = !_mediav.ccEnabled;
      updateCCState(document.getElementById("mediavVideo"));
    });
  }

  // ⬇️ NUEVO: oculta el botón CC si no hay archivo .vtt asociado
  if (ccBtn){
    const vttCandidate = (srcOrUrl || "").replace(/\.[^/.]+$/, ".vtt");
    fetch(vttCandidate, { method: "HEAD" })
      .then(r => { ccBtn.classList.toggle("hidden", !r.ok); })
      .catch(() => ccBtn.classList.add("hidden"));
  }

  // Teclado: Esc, ←, →
  const onKey = (ev)=>{
    if (ev.key === "Escape") closeMediaViewer();
    else if (ev.key === "ArrowLeft") { ev.preventDefault(); prevMedia(); }
    else if (ev.key === "ArrowRight"){ ev.preventDefault(); nextMedia(); }
  };
  _mediav.esc = onKey;
  window.addEventListener("keydown", onKey);

	// Cierre
	root.querySelector("[data-mediav-close]")?.addEventListener("click", closeMediaViewer, { once:true });

	root.addEventListener("click", (e) => {
	  // Solo cerrar si se hace clic en el overlay, NO dentro del diálogo
	  if (e.target === root) {
		closeMediaViewer();
	  }
	}, { once:true });

  // Abre
  root.setAttribute("aria-hidden", "false");
  root.classList.remove("hidden");

  // Aplica traducción de etiquetas
  i18nApplyViewersLabels();

  // Si no tenemos playlist (carpeta vacía), al menos mostrar el src directo
  if (!_mediav.items.length && srcOrUrl){
    _mediav.items = [{ name: title || srcOrUrl.split("/").pop(), rel: "", url: srcOrUrl, ext:"", mime:"" }];
  }

  // Carga el ítem actual
  showMedia(start);
}

function closeMediaViewer(){
  const root = document.getElementById("mediaViewer");
  const v = document.getElementById("mediavVideo");
  const a = document.getElementById("mediavAudio");
  if (!root || !v || !a) return;

  // ⛔ Candado: durante el cierre ignoramos cualquier "error" de media
  _mediav.closing = true;

  // Quitar listeners de fallback si existieran (evita que salten al limpiar src)
  if (v.__fallbackHandler) {
    try { v.removeEventListener("error", v.__fallbackHandler); } catch {}
    v.__fallbackHandler = null;
  }
  if (a.__fallbackHandler) {
    try { a.removeEventListener("error", a.__fallbackHandler); } catch {}
    a.__fallbackHandler = null;
  }

  // Parar reproducción
  try { v.pause(); } catch {}
  try { a.pause(); } catch {}

  // Ocultar y limpiar
  v.classList.add("hidden");
  a.classList.add("hidden");

  // Importante: removeAttribute+load reduce eventos raros frente a v.src=""
  try { v.removeAttribute("src"); v.load(); } catch {}
  try { a.removeAttribute("src"); a.load(); } catch {}

  root.classList.add("hidden");
  root.setAttribute("aria-hidden", "true");

  // Pequeño delay para cubrir cualquier evento asíncrono que llegue tarde
  setTimeout(() => { _mediav.closing = false; }, 250);
}

/* ===== Visor de documentos ===== */
// Ruta base absoluta del viewer de PDF.js dentro del frontend
const PDFJS_VIEWER = `${BASE_URL}/pdfjs/web/viewer.html`;

// Abre un documento en el visor a pantalla completa.
// - urlFile: URL absoluta al archivo (tu /api/library/file?path=...)
// Detecta PDFs y usa PDF.js con miniaturas; otros tipos, iframe directo.
function openDocViewer(urlFile){
  const overlay = document.getElementById("docViewer");
  const frame   = document.getElementById("docvFrame");
  if (!overlay || !frame) return;

  // ¿Es PDF?
  const isPdf = /\.pdf(\?|#|$)/i.test(urlFile);

  // Construye URL para PDF.js → /pdfjs/web/viewer.html?file=<ENCODED>&#pagemode=thumbs
  const src = isPdf
    ? `${PDFJS_VIEWER}?file=${encodeURIComponent(urlFile)}#pagemode=thumbs`
    : urlFile;

  frame.src = src;
  overlay.setAttribute("aria-hidden", "false");

  // Cierre: botón, fondo y tecla Escape
  const onKey = (ev) => { if (ev.key === "Escape") closeDocViewer(); };
  overlay.__docvKey = onKey;
  window.addEventListener("keydown", onKey);

  // Cerrar si clicas fuera del diálogo
  overlay.addEventListener("click", (ev)=>{
    const inside = ev.target.closest(".docv-dialog");
    if (!inside) closeDocViewer();
  }, { once:true });

  overlay.querySelector("[data-docv-close]")?.addEventListener("click", closeDocViewer, { once:true });
}

/* ===== Estado del visor de media ===== */
let _mediav = {
  sub: "video",                // "video" | "music"
  kind: "video",               // "video" | "audio" (alias)
  items: [],                   // [{ name, rel, url, ext, dur?, mime? }]
  idx: 0,
  esc: null,
  ccEnabled: false,
  closing: false               // ⛔ evita fallback al cerrar
};

function _mediaIsVideo() { return _mediav.kind === "video"; }
function _mediaFilterFor(sub){
  return (f)=>{
    const n = (f.name || "") + "";
    const mime = (f.mime || "") + "";
    if (sub === "video") return /^video\//i.test(mime) || /\.(mp4|webm|ogg|mkv|mov|m4v)$/i.test(n);
    return /^audio\//i.test(mime) || /\.(mp3|ogg|wav|m4a|flac)$/i.test(n);
  };
}
function _mediaUrlOf(sub, rel){
  return `${BASE_URL}/api/media/file?sub=${encodeURIComponent(sub)}&path=${encodeURIComponent(rel)}&disposition=inline`;
}
function _mediaDirOf(rel){
  const i = String(rel||"").lastIndexOf("/");
  return i === -1 ? "" : rel.slice(0, i);
}
function _mediaBaseOf(rel){
  const n = (rel.split("/").pop()||"");
  const j = n.lastIndexOf(".");
  return j === -1 ? n : n.slice(0, j);
}


function closeDocViewer(){
  const overlay = document.getElementById("docViewer");
  const frame   = document.getElementById("docvFrame");
  if (!overlay || !frame) return;

  frame.src = "about:blank";
  overlay.setAttribute("aria-hidden", "true");

  if (overlay.__docvKey){
    window.removeEventListener("keydown", overlay.__docvKey);
    delete overlay.__docvKey;
  }
}

// === Delegación de clics en la lista de la Librería ===
document.getElementById("libList")?.addEventListener("click", async (e) => {
  // 1) Botón de borrar
  const delBtn = e.target.closest(".lib-delete-btn");
  if (delBtn) {
    e.preventDefault();
    e.stopPropagation();

    const rel  = delBtn.getAttribute("data-rel") || "";
    const row  = delBtn.closest(".lib-row");
    const name = row?.querySelector(".lib-name")?.textContent || rel;
    const type = delBtn.getAttribute("data-type") || "file";

    showLibDeleteConfirm({ rel, name, type });
    return;
  }

  // 2) Resto del clic: navegar / abrir
  const row = e.target.closest(".lib-row");
  if (!row) return;

  e.preventDefault();
  e.stopPropagation();

  const type = row.getAttribute("data-type");
  const rel  = row.getAttribute("data-rel") || "";

  // 👉 Caso especial: fila ".." para subir un nivel
  // (la añadimos en libraryListRender con class="lib-row lib-row-up" y data-rel="..")
  if (row.classList.contains("lib-row-up") || rel === "..") {
    libraryGoUp();
    return;
  }

  if (!type || !rel) return;

  // Si es carpeta → navegar dentro
  if (type === "dir") {
    libraryNavigateTo(rel);
    return;
  }

  // Si es archivo → delegar en libraryOpen (docs / images / video / music)
  libraryOpen(rel);
});




function renderLibBreadcrumb(base, relPath) {
  const el = document.getElementById("libPathLabel");
  if (!el) return;

  // Limpia
  el.innerHTML = "";

  // 1) Raíz (docs o media/video|music)
  const baseParts = base.split("/"); // "docs" | "media/video"
  const baseIsDocs = baseParts[0] === "docs";
  const baseLabel = baseIsDocs ? "docs" : `${baseParts[0]} / ${baseParts[1]}`;

  const makeLink = (label, toPath) => {
    const a = document.createElement("a");
    a.className = "lib-bc";
    a.textContent = label;
    a.href = "#";
    a.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // ir a raíz dentro de la base
      state.library.path = toPath || "";
      libraryListRender();
    });
    return a;
  };

  el.appendChild(makeLink(baseLabel, "")); // raíz de la base

  // 2) Segmentos del path relativo
  const parts = String(relPath || "").split("/").filter(Boolean);
  let acc = [];
  for (let i = 0; i < parts.length; i++) {
    el.appendChild(document.createTextNode(" / "));
    acc.push(parts[i]);
    const joined = acc.join("/");
    if (i === parts.length - 1) {
      const span = document.createElement("span");
      span.textContent = parts[i];
      el.appendChild(span);
    } else {
      el.appendChild(makeLink(parts[i], joined));
    }
  }
}


// ===== WIKI-TREES (Catálogo + Árbol + Restaurar vista) =====

// Utilidades pequeñas locales
function _show(el){ if (el) el.classList.remove("hidden"); }
function _hide(el){ if (el) el.classList.add("hidden"); }
function _html(s){ return escapeHTML(String(s||"")); }

// API
async function fetchTaxonomyCatalog(){
  const r = await fetch(`${BASE_URL}/api/taxonomy/catalog`);
  if (!r.ok) throw new Error("No se pudo cargar el catálogo");
  return await r.json();
}
async function fetchTaxonomyTree(treeId){
  const r = await fetch(`${BASE_URL}/api/taxonomy/${encodeURIComponent(treeId)}`);
  if (!r.ok) throw new Error("No se pudo cargar el árbol");
  return await r.json();
}

// Render catálogo
function renderCatalog(items){
  const box = document.getElementById("wikiTreesCatalogList");
  if (!box) return;
  const lang = state.lang || "en";

  const catId = state.wikiTrees_selectedCat || null;
  const q = (document.getElementById("catalogFilter")?.value || "").trim().toLowerCase();

  // Filtros combinados: categoría + texto
  let list = (items || []);
  if (catId) list = list.filter(it => it.category === catId);
  if (q) {
    list = list.filter(it => {
      const L = (it.i18n && (it.i18n[lang] || it.i18n.en)) || {};
      const txt = `${L.title || it.id} ${L.description || ""}`.toLowerCase();
      return txt.includes(q);
    });
  }

  box.innerHTML = list.map(it => {
    const L = (it.i18n && (it.i18n[lang] || it.i18n.en)) || {};
    const title = L.title || it.title || it.id;
    const desc  = L.description || it.description || "";
    const imgUrl = absUrl(`taxonomies/images/${it.id}.png`);

    // Tag de categoría (emoji + etiqueta)
    const cat = (state._wikiCategoriesById || {})[it.category || ""] || null;
    const catHtml = cat
      ? `<span class="tag" style="margin-bottom:6px;display:inline-flex;align-items:center;gap:6px;">
           <span>${cat.emoji || ""}</span>
           <span>${escapeHTML(cat.label || cat.id)}</span>
         </span>`
      : "";

    return `
      <div class="catalog-card">
        ${catHtml}
        <img class="taxo-card-img" src="${imgUrl}" alt="${_html(title)}" onerror="this.style.display='none'">
        <h4>${_html(title)}</h4>
        <p>${_html(desc)}</p>
        <div class="row">
          <span style="font-size:12px;color:var(--ink,#777);opacity:.7;">ID: ${_html(it.id)}</span>
          <button class="btn-plain" onclick="openTreeFromCatalog('${_html(it.id)}','${_html(title)}')">${t("wikiTreesOpen")}</button>
        </div>
      </div>
    `;
  }).join("");
}

function filterCatalog(){
  const q = (document.getElementById("catalogFilter")?.value || "").trim().toLowerCase();
  const cards = document.querySelectorAll("#wikiTreesCatalogList .catalog-card");
  cards.forEach(c => {
    const text = c.textContent.toLowerCase();
    c.style.display = text.includes(q) ? "" : "none";
  });
}

// Localiza un árbol subiendo title/wiki/MichaelEncarthaText al nivel superior de cada nodo
function localizeTaxoNode(node, lang){
  const L = (node.i18n && (node.i18n[lang] || node.i18n.en)) || {};

  // Toma MichaelEncarthaText localizado si existe; si no, intenta plano
  let encarthaText = "";
  if (typeof L.MichaelEncarthaText === "string" && L.MichaelEncarthaText.trim()){
    encarthaText = L.MichaelEncarthaText.trim();
  } else if (typeof node.MichaelEncarthaText === "string" && node.MichaelEncarthaText.trim()){
    encarthaText = node.MichaelEncarthaText.trim();
  }

  return {
    title: (L.title || node.title || "").trim(),
    wiki:  (L.wiki  || node.wiki  || (L.title || node.title || "")).trim(),
    // 👇 CLAVE: lo subimos al plano del nodo localizado
    ...(encarthaText ? { MichaelEncarthaText: encarthaText } : {}),
    children: (node.children || []).map(ch => localizeTaxoNode(ch, lang))
  };
}

function localizeTaxoTree(tree, lang){
  return localizeTaxoNode(tree, lang);
}

// Devuelve SOLO hijos válidos (con title no vacío)
function cleanChildren(node){
  const arr = Array.isArray(node?.children) ? node.children : [];
  return arr.filter(ch => ch && typeof ch.title === "string" && ch.title.trim().length > 0);
}


// Render árbol (sin imágenes, solo Wikisearch)
// - Abre el root por defecto
// - data-title + data-path para breadcrumb/favoritos
function taxoNodeHTML(node, level = 0, parentPath = ""){
  const id = `taxo-${Math.random().toString(36).slice(2)}`;
  const isRoot = (level === 0);
  const title = String(node.title || "").trim();
  const myPath = parentPath ? `${parentPath} › ${title}` : title;
  const kids   = cleanChildren(node);
  const isLeaf = kids.length === 0;                 // ← ya lo tienes
  const caret  = (level === 0) ? "▾" : (isLeaf ? "" : "▸");
  const openAttr = isRoot ? " open" : "";

  return `
    <div class="taxo-node" data-level="${level}">
      <details class="taxo-details"${openAttr} data-title="${_html(title)}" data-path="${_html(myPath)}">
        <summary class="taxo-row" onclick="taxoOnToggle(event, '${id}'); taxoOnFocusSummary(event);">
          <span class="taxo-status-dot" aria-hidden="true"></span>
          <span class="taxo-caret" id="${id}-caret">${caret}</span>
          <span class="taxo-title" data-raw="${_html(title)}">${_html(title)}</span>
          <span class="taxo-actions" style="margin-left:auto; display:flex; gap:6px;">
            <button onclick="taxoWikisearch(event, '${_html(node.wiki||title)}')">🔎</button>
            <button class="btn-star" title="Favorito" onclick="taxoToggleFav(event)">⭐</button>
            ${isLeaf
              ? `<button class="btn-plain" title="Estudiar con Michael Encartha"
                         onclick="taxoAskEncartha(event, '${_html(node.wiki||title)}')">👨‍🏫</button>`
              : ``}
          </span>
        </summary>
        <div class="taxo-children">
          ${kids.map(ch => taxoNodeHTML(ch, level+1, myPath)).join("")}
        </div>
      </details>
    </div>`;
}



// Estado simple en memoria + persistencia (por wiki-tree; se cargan al abrir el árbol)
state._currentTreeId = state._currentTreeId || null;
state._treeFavs = [];
state._treeRecents = [];



function saveFavsFor(id, arr){
  if (!id) return;
  localStorage.setItem(WT_FAVS_KEY(id), JSON.stringify(arr || []));
}

function loadRecentsFor(id){
  try { return JSON.parse(localStorage.getItem(WT_RECENTS_KEY(id)) || "[]"); }
  catch { return []; }
}
function saveRecentsFor(id, arr){
  if (!id) return;
  localStorage.setItem(WT_RECENTS_KEY(id), JSON.stringify(arr || []));
}

// ===== PROGRESO DE ESTUDIO (por wiki-tree) =====
state._treeIndex    = {};  // path -> { children: string[], leaf: boolean }
state._treeVisited  = {};  // path -> true (solo hojas marcadas)

function loadProgressFor(id){
  try {
    const val = JSON.parse(localStorage.getItem(WT_PROG_KEY(id)) || "{}");
    return (val && typeof val === "object") ? val : {};
  } catch { return {}; }
}
function saveProgressFor(id, obj){
  if (!id) return;
  localStorage.setItem(WT_PROG_KEY(id), JSON.stringify(obj || {}));
}

function loadAchFor(id){
  try { return JSON.parse(localStorage.getItem(WT_ACH_KEY(id)) || "{}"); }
  catch { return {}; }
}
function saveAchFor(id, obj){
  if (!id) return;
  localStorage.setItem(WT_ACH_KEY(id), JSON.stringify(obj || {}));
}
function hasAchievement(achId){
  const id = state._currentTreeId; if (!id) return false;
  const bag = loadAchFor(id);
  return !!bag[achId];
}
function unlockAchievement(achId, icon="🏆"){
  const id  = state._currentTreeId; if (!id) return false;
  const bag = loadAchFor(id);
  if (bag[achId]) return false;
  bag[achId] = Date.now();
  saveAchFor(id, bag);

  // (silenciado) antes mostraba toast de logro
  // toast?.(`${icon} ${t('ach_unlock_toast')}: ${achTitle(achId)}`);

  refreshAchievementsUI?.();
  return true;
}
function achTitle(achId){
  const map = {
    first: 'ach_first_open',
    n5:    'ach_5_done',
    p10:   'ach_10_percent',
    p25:   'ach_25_percent',
    p50:   'ach_50_percent',
    p100:  'ach_100_percent'
  };
  return t(map[achId] || 'achievements');
}


// Construye índice por path con los children DIRECTOS
function buildTreeIndex(node, parentPath = "", out = {}){
  const title  = String(node.title||"").trim();
  const myPath = parentPath ? `${parentPath} › ${title}` : title;

  const kids = cleanChildren(node);
  const childPaths = kids.map(ch => `${myPath} › ${String(ch.title||"").trim()}`);

  out[myPath] = { children: childPaths, leaf: childPaths.length === 0 };
  for (const ch of kids) buildTreeIndex(ch, myPath, out);
  return out;
}

// Cálculo de estado del nodo: 'todo' | 'progress' | 'done'
function calcStatus(path){
  const meta = state._treeIndex?.[path];
  if (!meta) return 'todo';
  if (meta.leaf) return state._treeVisited?.[path] ? 'done' : 'todo';

  let seen = 0, done = 0, total = meta.children.length;
  for (const ch of meta.children){
    const st = calcStatus(ch);
    if (st !== 'todo') seen++;
    if (st === 'done') done++;
  }
  if (total === 0) return state._treeVisited?.[path] ? 'done' : 'todo'; // defensa
  if (done === total) return 'done';
  if (seen > 0) return 'progress';
  return 'todo';
}

// Pinta clases de estado + título con % global
function paintStatuses(){
  const root = document.getElementById("wikiTreesContainer");
  if (!root) return;

  // Pinta clase en cada fila (gris/amarillo/verde) SOLO según el árbol actual
  root.querySelectorAll('details.taxo-details').forEach(d=>{
    const path = d.getAttribute('data-path') || "";
    const row  = d.querySelector('.taxo-row');
    if (!row || !path) return;
    row.classList.remove('status-todo','status-progress','status-done');

    const st = calcStatus(path);
    row.classList.add(`status-${st}`);
    row.title = (st==='done' ? t('study_done') : st==='progress' ? t('study_inProgress') : t('study_notStarted'));
  });

  // % sobre HOJAS del árbol ACTUAL
  const leafPaths = Object.entries(state._treeIndex || {}).filter(([,m])=>m.leaf).map(([p])=>p);
  const doneLeafs = leafPaths.filter(p => !!(state._treeVisited?.[p])).length;
  const pct = leafPaths.length ? Math.round(100*doneLeafs/leafPaths.length) : 0;

  const titleEl = document.getElementById("treeTitle");
  if (titleEl){
    const base = state._currentTreeLocalized?.title || (titleEl.textContent || "");
    titleEl.textContent = `${base} · ${pct}%`;
    titleEl.setAttribute('aria-label', `${t('study_overall')}: ${pct}%`);
  }

  // Logros (si los usas) — SIEMPRE por árbol
  if (typeof unlockAchievement === "function"){
    if (doneLeafs >= 1)   unlockAchievement('first', '🌱');
    if (doneLeafs >= 5)   unlockAchievement('n5',    '⭐');
    if (pct >= 10)        unlockAchievement('p10',   '🔟');
    if (pct >= 25)        unlockAchievement('p25',   '🌿');
    if (pct >= 50)        unlockAchievement('p50',   '🌳');
    if (pct >= 100)       unlockAchievement('p100',  '🌲');
  }
  if (typeof refreshAchievementsUI === "function") refreshAchievementsUI();
}

// Marca hoja visitada (se llama SOLO al abrir la wiki desde el botón)
function markVisited(path){
  const id = state._currentTreeId;
  if (!id || !path) return;

  const meta = state._treeIndex?.[path] || { children: [], leaf: true };
  const isLeafEffective = meta.leaf || (Array.isArray(meta.children) && meta.children.length === 0);
  if (!isLeafEffective) return;

  if (!state._treeVisited) state._treeVisited = {};
  if (!state._treeVisited[path]){
    state._treeVisited[path] = true;
    saveProgressFor(id, state._treeVisited);   // 👈 persiste SOLO en wt:prog:<id>
    paintStatuses();                            // recalcula puntos y % del árbol actual
  }
}



// Logros sencillos
function maybeUnlockAchievements(pct, doneLeafCount){
  // Usa SIEMPRE el sistema nuevo (objeto + unlockAchievement)
  const raise = (id)=> unlockAchievement(id);

  if (doneLeafCount >= 1)  raise('first'); // -> ach_first_open
  if (doneLeafCount >= 5)  raise('n5');    // -> ach_5_done
  if (pct >= 10)           raise('p10');   // -> ach_10_percent
  if (pct >= 25)           raise('p25');   // -> ach_25_percent
  if (pct >= 50)           raise('p50');   // -> ach_50_percent
  if (pct >= 100)          raise('p100');  // -> ach_100_percent
}


function taxoOnFocusSummary(ev){
  // Actualiza breadcrumb y "últimos vistos"
  const sum = ev.currentTarget;
  const d = sum?.closest('details.taxo-details');
  const path = d?.getAttribute('data-path') || "";
  updateBreadcrumb(path);
  pushRecent(path);
}
function updateBreadcrumb(path){
  const bc = document.getElementById("treeBreadcrumb");
  if (!bc){ return; }
  const parts = String(path||"").split(" › ").filter(Boolean);
  bc.innerHTML = parts.map((p,i)=>{
    const jump = parts.slice(0, i+1).join(" › ");
    return `<span class="crumb" data-path="${_html(jump)}">${_html(p)}</span>` +
           (i<parts.length-1 ? `<span class="sep">›</span>` : "");
  }).join("");
  // Navegar haciendo click en un “crumb”
  bc.querySelectorAll('.crumb').forEach(el=>{
    el.onclick = ()=>{
      const titles = (el.getAttribute('data-path')||"").split(" › ");
      openPathByTitles(titles);
    };
  });
}
function pushRecent(path){
  if (!path) return;
  const id = state._currentTreeId;
  if (!id) return;

  let arr = (state._treeRecents || []).filter(p => p !== path);
  arr.unshift(path);
  state._treeRecents = arr.slice(0, 6);
  saveRecentsFor(id, state._treeRecents);
  renderRecents();
}

function renderRecents(){
  const box = document.getElementById("recMenu");
  if (!box) return;
  if (!state._treeRecents || state._treeRecents.length === 0){
    box.innerHTML = `<div class="drop-empty">${t("recentsEmpty")}</div>`;
    return;
  }
  box.innerHTML = state._treeRecents.map(p => {
    const last = p.split(' › ').slice(-1)[0];
    return `
      <button class="drop-item" data-path="${_html(p)}" role="menuitem">
        <span>🕘</span>
        <span><b>${_html(last)}</b><small>${_html(p)}</small></span>
      </button>`;
  }).join("");

  box.querySelectorAll('.drop-item').forEach(b=>{
    b.onclick = ()=>{
      const titles = (b.getAttribute('data-path')||"").split(" › ");
      hideMenus();
      setTreeView(true);
      openPathByTitles(titles);
    };
  });
}

function achievementsProgressSnapshot(){
  const leafPaths = Object.entries(state._treeIndex || {})
    .filter(([,m]) => m.leaf)
    .map(([p]) => p);
  const total = leafPaths.length;
  const done  = leafPaths.filter(p => !!(state._treeVisited?.[p])).length;
  const pct   = total ? Math.round(100*done/total) : 0;
  return { total, done, pct };
}

function renderAchievementsMenu(){
  const id  = state._currentTreeId;
  const box = document.getElementById("achMenu");
  if (!id || !box) return;

  const { total, done, pct } = achievementsProgressSnapshot();
  const bag = loadAchFor(id);                      // { achId: ts, ... }
  const unlocked = Object.keys(bag).sort((a,b)=> (bag[b]-bag[a])); // orden por fecha desc

  if (!unlocked.length){
    box.innerHTML = `
      <div class="drop-heading">🏆 ${_html(t("achievementsTitle"))}</div>
      <div class="drop-note">${_html(t("achievementsProgress"))}: <b>${pct}%</b> (${done}/${total})</div>
      <div class="drop-empty">${_html(t("achievementsEmpty"))}</div>`;
    return;
  }

  box.innerHTML = `
    <div class="drop-heading">🏆 ${_html(t("achievementsTitle"))}</div>
    <div class="drop-note">${_html(t("achievementsProgress"))}: <b>${pct}%</b> (${done}/${total})</div>
    ${unlocked.map(code => `
      <div class="drop-item" data-ach="${_html(code)}">
        <span>🏅</span>
        <div class="drop-body">
          <b>${_html(achTitle(code))}</b>
          <small>${new Date(bag[code]).toLocaleString()}</small>
        </div>
      </div>
    `).join("")}
    <div class="drop-note">
      <button id="achResetBtn" class="btn-plain">${_html(t("achievementsReset"))}</button>
    </div>
  `;

  const btn = document.getElementById("achResetBtn");
  if (btn){
    btn.onclick = ()=>{
      saveAchFor(id, {});
      renderAchievementsMenu();
      if (typeof toast === "function"){
        toast(`${t('achievementsTitle')}: ${t('achievementsReset')}`);
      }
      refreshAchievementsUI();
    };
  }
}

function refreshAchievementsUI(){
  const id  = state._currentTreeId;
  const btn = document.getElementById("achMenuBtn");
  if (!id || !btn) return;
  const { pct } = achievementsProgressSnapshot();   // badge muestra % actual
  // quita badge anterior
  btn.querySelector('.ach-badge')?.remove();
  const sp = document.createElement('span');
  sp.className = 'ach-badge';
  sp.textContent = `${pct}%`;
  btn.appendChild(sp);
}



function toggleMenu(id){
  const menu = document.getElementById(id);
  if (!menu) return;
  const isHidden = menu.classList.contains('hidden');
  hideMenus();
  if (isHidden) menu.classList.remove('hidden');
}

function hideMenus(){
  document.getElementById('favMenu')?.classList.add('hidden');
  document.getElementById('recMenu')?.classList.add('hidden');
  document.getElementById('achMenu')?.classList.add('hidden');
}

// ===== Confirm modal específico para Whiteboard =====
function showWhiteboardConfirm(kind){
  // kind: "new" | "save" | "overwrite"
  return new Promise((resolve)=>{
    const ov = document.getElementById("whiteboardConfirm");
    // Si por lo que sea no existe el modal, usar confirm() nativo como fallback
    if (!ov) {
      let msg;
      if (kind === "new") {
        msg = t("whiteboardNewConfirmMsg") || "This will clear the current whiteboard. Do you want to continue?";
      } else if (kind === "overwrite") {
        msg = t("whiteboardOverwriteConfirmMsg") || "A file with this name already exists. Overwrite?";
      } else {
        msg = t("whiteboardSaveConfirmMsg") || "Do you want to save this whiteboard?";
      }
      resolve(window.confirm(msg));
      return;
    }

    const titleEl    = document.getElementById("whiteboardConfirmTitle");
    const msgEl      = document.getElementById("whiteboardConfirmMsg");
    const cancelBtn  = document.getElementById("whiteboardConfirmCancel");
    const okBtn      = document.getElementById("whiteboardConfirmOk");

    if (titleEl) {
      if (kind === "new") {
        titleEl.textContent = t("whiteboardNewConfirmTitle") || "";
      } else {
        titleEl.textContent = t("whiteboardSaveConfirmTitle") || "";
      }
    }

    if (msgEl) {
      let key =
        kind === "new"
          ? "whiteboardNewConfirmMsg"
          : kind === "overwrite"
          ? "whiteboardOverwriteConfirmMsg"
          : "whiteboardSaveConfirmMsg";
      msgEl.textContent = t(key) || "";
    }

    const txtNo  = t("whiteboardConfirmNo")  || t("resetNo")  || "Cancel";
    const txtYes = t("whiteboardConfirmYes") || t("resetYes") || "OK";
    if (cancelBtn) cancelBtn.textContent = txtNo;
    if (okBtn)     okBtn.textContent     = txtYes;

    const hide = () => ov.classList.add("hidden");
    const cleanup = () => {
      document.removeEventListener("keydown", onKey);
      ov.removeEventListener("click", onClickOutside);
      if (cancelBtn) cancelBtn.onclick = null;
      if (okBtn)     okBtn.onclick     = null;
    };

    const onKey = (ev)=>{
      if (ev.key === "Escape") {
        cleanup();
        hide();
        resolve(false);
      }
    };
    const onClickOutside = (ev)=>{
      if (ev.target === ov) {
        cleanup();
        hide();
        resolve(false);
      }
    };

    document.addEventListener("keydown", onKey);
    ov.addEventListener("click", onClickOutside);

    if (cancelBtn) cancelBtn.onclick = ()=>{
      cleanup();
      hide();
      resolve(false);
    };
    if (okBtn) okBtn.onclick = ()=>{
      cleanup();
      hide();
      resolve(true);
    };

    ov.classList.remove("hidden");
  });
}

function showResetModal(){
  const ov = document.getElementById('resetConfirm');
  if (!ov) return;

  const name = state._currentTreeLocalized?.title || state._currentTreeId || "";
  const titleEl = document.getElementById('resetTitle');
  const msgEl   = document.getElementById('resetMsg');
  const noBtn   = document.getElementById('resetNo');
  const yesBtn  = document.getElementById('resetYes');

  if (titleEl) titleEl.textContent = t('resetConfirmTitle');
  if (msgEl)   msgEl.textContent   = (t('resetConfirmMsg') || "").replace("{name}", String(name||""));

  if (noBtn)  noBtn.textContent  = t('resetNo');
  if (yesBtn) yesBtn.textContent = t('resetYes');

  ov.classList.remove('hidden');

  // Cerrar con “Cancelar”, clic fuera o Escape:
  const hide = () => ov.classList.add('hidden');
  const onKey = (ev)=>{ if (ev.key === 'Escape') { cleanup(); hide(); } };
  const onClickOutside = (ev)=>{ if (ev.target === ov) { cleanup(); hide(); } };
  function cleanup(){
    document.removeEventListener('keydown', onKey);
    ov.removeEventListener('click', onClickOutside);
  }
  document.addEventListener('keydown', onKey);
  ov.addEventListener('click', onClickOutside);

  if (noBtn)  noBtn.onclick  = ()=>{ cleanup(); hide(); };
  if (yesBtn) yesBtn.onclick = ()=>{
    cleanup(); hide();
    resetCurrentTreeProgress();
  };
}

async function deleteAudioNote(){
  const id = state.audioNotes.activeId;
  if (!id) return;

  try {
    const resp = await fetch(`${BASE_URL}/audio/delete/${id}`, { method: "DELETE" });
    const out = await resp.json();

    // eliminar del estado local
    state.audioNotes.items = state.audioNotes.items.filter(n => n.id !== id);
    state.audioNotes.activeId = null;

    // limpiar UI
    audioTitleInput.value = "";
    audioPlayer.removeAttribute("src");
    audioPlayer.load();

    renderAudioNotesList();

  } catch (err) {
    console.error("Error deleting audio:", err);
    alert("Error deleting audio");
  }
}

function showConfirmDialog(options){
  const {
    title = "",
    message = "",
    confirmLabel,
    cancelLabel,
    onConfirm
  } = options || {};

  const ov       = document.getElementById("noteDeleteConfirm");
  const titleEl  = document.getElementById("noteDeleteTitle");
  const msgEl    = document.getElementById("noteDeleteMsg");
  const cancelBtn= document.getElementById("noteDeleteCancel");
  const okBtn    = document.getElementById("noteDeleteOk");

  // Fallback si por lo que sea no existe el modal
  if (!ov || !titleEl || !msgEl || !cancelBtn || !okBtn){
    if (window.confirm(message || title || "")) {
      if (typeof onConfirm === "function") onConfirm();
    }
    return;
  }

  // Título y mensaje
  titleEl.textContent = title || "";
  msgEl.textContent   = message || "";

  // Etiquetas de botones (con fallback a las de reset)
  const hasCancel = !(cancelLabel === "" || cancelLabel === null || cancelLabel === undefined);

  if (hasCancel) {
    cancelBtn.textContent = String(
      cancelLabel !== undefined && cancelLabel !== null && cancelLabel !== ""
        ? cancelLabel
        : (t("resetNo") || "Cancel")
    );
    cancelBtn.classList.remove("hidden");
  } else {
    // Modo "alerta": sin botón de cancelar
    cancelBtn.classList.add("hidden");
  }

  okBtn.textContent = (confirmLabel !== undefined && confirmLabel !== null && confirmLabel !== "")
    ? String(confirmLabel)
    : (t("resetYes") || "OK");


  ov.classList.remove("hidden");

  const hide = ()=> ov.classList.add("hidden");

  const onKey = (ev)=>{
    if (ev.key === "Escape"){
      cleanup();
      hide();
    }
  };
  const onClickOutside = (ev)=>{
    if (ev.target === ov){
      cleanup();
      hide();
    }
  };

  function cleanup(){
    document.removeEventListener("keydown", onKey);
    ov.removeEventListener("click", onClickOutside);
    cancelBtn.onclick = null;
    okBtn.onclick = null;
  }

  document.addEventListener("keydown", onKey);
  ov.addEventListener("click", onClickOutside);

  cancelBtn.onclick = ()=>{
    cleanup();
    hide();
  };

  okBtn.onclick = ()=>{
    cleanup();
    hide();
    if (typeof onConfirm === "function") onConfirm();
  };
}


function showNoteDeleteConfirm(noteTitle){
  const ov = document.getElementById("noteDeleteConfirm");
  const msgTemplate = t("notesDeleteConfirmMsg") || 'Are you sure you want to delete the note "{name}"?';
  const finalMsg = msgTemplate.replace("{name}", String(noteTitle || ""));

  // Fallback si por lo que sea no existe el modal
  if (!ov) {
    if (window.confirm(finalMsg)) {
      noteDelete();
    }
    return;
  }

  const titleEl   = document.getElementById("noteDeleteTitle");
  const msgEl     = document.getElementById("noteDeleteMsg");
  const cancelBtn = document.getElementById("noteDeleteCancel");
  const okBtn     = document.getElementById("noteDeleteOk");

  if (titleEl) titleEl.textContent = t("notesDeleteConfirmTitle") || "Delete note";
  if (msgEl)   msgEl.textContent   = finalMsg;

  // Reutilizamos textos existentes para botones
  if (cancelBtn) cancelBtn.textContent = t("resetNo") || "Cancel";
  if (okBtn)     okBtn.textContent     = t("notesDelete") || "Delete";

  ov.classList.remove("hidden");

  const hide = () => ov.classList.add("hidden");
  const onKey = (ev)=>{ if (ev.key === "Escape") { cleanup(); hide(); } };
  const onClickOutside = (ev)=>{ if (ev.target === ov) { cleanup(); hide(); } };

  function cleanup(){
    document.removeEventListener("keydown", onKey);
    ov.removeEventListener("click", onClickOutside);
    if (cancelBtn) cancelBtn.onclick = null;
    if (okBtn)     okBtn.onclick     = null;
  }

  document.addEventListener("keydown", onKey);
  ov.addEventListener("click", onClickOutside);

  if (cancelBtn) cancelBtn.onclick = ()=>{ cleanup(); hide(); };
  if (okBtn)     okBtn.onclick = ()=>{
    cleanup(); hide();
    noteDelete();
  };
}


function resetCurrentTreeProgress(){
  const id = state._currentTreeId;
  if (!id) return;

  try {
    // ✅ Borrar SOLO progreso + recientes + logros (NO favoritos)
    localStorage.removeItem(WT_PROG_KEY(id));    // progreso (hojas visitadas)
    localStorage.removeItem(WT_RECENTS_KEY(id)); // recientes

    // logros (según cuál uses en tu código actual, eliminamos ambos por si acaso)
    if (typeof WT_ACH_KEY === "function")  localStorage.removeItem(WT_ACH_KEY(id));
    if (typeof WT_ACHV_KEY === "function") localStorage.removeItem(WT_ACHV_KEY(id));
  } catch {}

  // Estado en memoria: NO tocar favoritos
  state._treeVisited = {};   // progreso
  state._treeRecents = [];   // recientes
  // ❌ NO limpiar state._treeFavs

  // Refrescar UI (favoritos se mantienen tal cual)
  paintStatuses?.();         // repinta dots + % en título
  renderRecents?.();         // limpia el menú de recientes
  renderAchievementsMenu?.();
  refreshAchievementsUI?.();
  // ❌ NO llamar a renderFavs() si no quieres reordenar; si lo llamas, seguirá mostrando los mismos favoritos

  toast?.(`🧹 ${t('resetDone')}`);
}



// Cerrar menús al hacer clic fuera
document.addEventListener('click', (ev)=>{
  const right = document.querySelector('.wiki-trees-panel .panel-head .right');
  const favBtn = document.getElementById('favMenuBtn');
  const recBtn = document.getElementById('recMenuBtn');
  const achBtn = document.getElementById('achMenuBtn');
  const favMenu = document.getElementById('favMenu');
  const recMenu = document.getElementById('recMenu');
  const achMenu = document.getElementById('achMenu');

  const inRight = right?.contains(ev.target);
  const inFav   = favMenu?.contains(ev.target);
  const inRec   = recMenu?.contains(ev.target);
  const inAch   = achMenu?.contains(ev.target);
  const isBtn   = [favBtn, recBtn, achBtn].includes(ev.target);

  if (!inRight && !inFav && !inRec && !inAch && !isBtn){
    hideMenus();
  }
});

// Tecla Escape cierra menús
document.addEventListener('keydown', (ev)=>{
  if (ev.key === 'Escape') hideMenus();
});

// añade achMenu al hideMenus
function hideMenus(){
  document.getElementById('favMenu')?.classList.add('hidden');
  document.getElementById('recMenu')?.classList.add('hidden');
  document.getElementById('achMenu')?.classList.add('hidden');
}

// Tecla Escape cierra menús
document.addEventListener('keydown', (ev)=>{
  if (ev.key === 'Escape') hideMenus();
});


function taxoToggleFav(ev){
  ev.preventDefault(); ev.stopPropagation();
  const id  = state._currentTreeId;
  if (!id) return;
  const sum = ev.currentTarget?.closest('summary.taxo-row');
  const d   = sum?.closest('details.taxo-details');
  const path = d?.getAttribute('data-path') || "";
  if (!path) return;

  const i = state._treeFavs.indexOf(path);
  if (i === -1) state._treeFavs.unshift(path);
  else state._treeFavs.splice(i,1);
  state._treeFavs = state._treeFavs.slice(0, 24);
  saveFavsFor(id, state._treeFavs);
  renderFavs();
  pushRecent(path);   // 👈 NUEVO: también cuenta como “reciente”
}

function showEncarthaConfirm(message, onYes, onNo){
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';

  overlay.innerHTML = `
    <div class="confirm-modal">
      <div class="confirm-title">Estudiar con Michael Encartha</div>
      <div class="confirm-msg">${escapeHTML(message)}</div>
      <div class="confirm-actions">
        <button class="ghost" id="encarthaNo">No</button>
        <button class="btn-danger" id="encarthaYes">Sí</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const cleanup = ()=> overlay.remove();
  overlay.querySelector('#encarthaNo').onclick  = ()=>{ cleanup(); onNo && onNo(); };
  overlay.querySelector('#encarthaYes').onclick = ()=>{ cleanup(); onYes && onYes(); };
}


function removeFavorite(path){
  if (!path) return;
  const i = state._treeFavs.indexOf(path);
  if (i === -1) return;

  // Encuentra el elemento en el DOM
  const el = document.querySelector(`.drop-item[data-path="${CSS.escape(path)}"]`);
  if (el){
    el.classList.add("fade-out");
    // Esperamos al final de la animación antes de quitarlo
    el.addEventListener("animationend", ()=>{
      state._treeFavs.splice(i,1);
      saveFavsFor(state._currentTreeId, state._treeFavs);
      renderFavs(); // refrescamos el menú
    }, { once: true });
  } else {
    // fallback si no hay elemento visible
    state._treeFavs.splice(i,1);
    saveFavsFor(state._currentTreeId, state._treeFavs);
    renderFavs();
  }
}



function renderFavs(){
  const box = document.getElementById("favMenu");
  if (!box) return;
  if (!state._treeFavs || state._treeFavs.length === 0){
    box.innerHTML = `<div class="drop-empty">${t("favEmpty")}</div>`;
    return;
  }
  box.innerHTML = state._treeFavs.map(p => {
    const last = p.split(' › ').slice(-1)[0];
    return `
      <div class="drop-item" data-path="${_html(p)}" role="menuitem">
        <button class="drop-star" title="${_html(t("favRemoveTitle"))}" data-path="${_html(p)}">⭐</button>
        <div class="drop-body">
          <b>${_html(last)}</b>
          <small>${_html(p)}</small>
        </div>
      </div>`;
  }).join("");

  // 1️⃣ Click en el cuerpo → navegar al nodo
  box.querySelectorAll('.drop-body').forEach(el=>{
    el.onclick = ()=>{
      const parent = el.closest('.drop-item');
      const titles = (parent.getAttribute('data-path')||"").split(" › ");
      hideMenus();
      setTreeView(true);
      openPathByTitles(titles);
    };
  });

  // 2️⃣ Click en la estrella → eliminar de favoritos
  box.querySelectorAll('.drop-star').forEach(btn=>{
    btn.onclick = (ev)=>{
      ev.stopPropagation();
      const path = btn.getAttribute('data-path');
      removeFavorite(path);
    };
  });
}




function renderTree(data){
  const box = document.getElementById("wikiTreesContainer");
  const title = document.getElementById("treeTitle");
  if (box) box.innerHTML = taxoNodeHTML(data, 0);
  if (title) title.textContent = data.title || "Clasificación";
  // Zebra inicial
  applyZebraStriping();

  // Recalcular zebra cuando el usuario abre/cierra niveles
  const panel = document.getElementById("wikiTreesPanel");
  if (panel){
    // Captura eventos toggle en bubbling
    panel.removeEventListener("toggle", applyZebraStriping, true);
    panel.addEventListener("toggle", applyZebraStriping, true);
  }
  // Inicializa breadcrumb (raíz), favoritos y recientes
  const rootPath = (data?.title || "Root");
  updateBreadcrumb(rootPath);
  renderFavs();
  renderRecents();
  // Si ya tenemos índice/progreso cargados (por openTreeFromCatalog), repinta
  if (state._treeIndex && state._currentTreeId) {
    paintStatuses();
	bindWikiToolbarButtons();
	updateTreeHeaderProgress();
  }
 }
 
function bindWikiToolbarButtons(){
  const on = (id, fn)=> {
    const el = document.getElementById(id);
    if (el && !el._bound){
      el.addEventListener("click", fn);
      el._bound = true;
    }
  };

  on("colAll",   ()=> collapseAllTree());     // Colapsar todo
  on("expAll",   ()=> expandAllTree());       // Expandir todo
  on("expLvl2",  ()=> expandToLevel(2));      // Expandir hasta nivel 2
  on("toggleFlat", ()=> toggleFlatList());    // Cambiar vista (árbol <-> plano)

  on("favMenuBtn", ()=> toggleFavMenu());     // Favoritos
  on("recMenuBtn", ()=> toggleRecentsMenu()); // Recientes
  on("achMenuBtn", ()=> toggleAchievementsMenu()); // Logros

  on("resetTreeBtn", ()=> resetProgressForCurrentTree()); // Borrar progreso
}
 
function buildFlatIndex(node, parentPath = "", level = 0, out = []){
  const title = String(node.title||"");
  const myPath = parentPath ? `${parentPath} › ${title}` : title;
  out.push({ title, path: myPath, level });
  for (const ch of (node.children||[])) buildFlatIndex(ch, myPath, level+1, out);
  return out;
}
function renderFlatList(data){
  const box = document.getElementById("wikiFlatList");
  if (!box) return;
  const items = buildFlatIndex(data); // ya nos da { title, path, level }
  const q = (document.getElementById("treeSearch")?.value || "").trim().toLowerCase();

  const filt = q ? items.filter(it => it.title.toLowerCase().includes(q)) : items;
  box.innerHTML = filt.map(it => 
    `<div class="flat-item" data-path="${_html(it.path)}" data-level="${it.level}">
       <b>${_html(it.title)}</b>
       <div class="flat-levelbar" aria-hidden="true"></div>
       <small>${_html(it.path)}</small>
     </div>`
  ).join("");

  box.querySelectorAll('.flat-item').forEach(el=>{
    el.onclick = ()=>{
      const titles = (el.getAttribute('data-path')||"").split(" › ");
      // vuelve a vista árbol y navega a la ruta
      setTreeView(true);
      openPathByTitles(titles);
    };
  });
}
function setTreeView(isTree){
  const tree = document.getElementById("wikiTreesContainer");
  const flat = document.getElementById("wikiFlatList");
  if (tree && flat){
    if (isTree){ _show(tree); _hide(flat); }
    else       { _hide(tree); _show(flat); }
  }
}


// Aplica franjas alternas solo a las filas VISIBLES del árbol
function applyZebraStriping(){
  const cont = document.getElementById("wikiTreesContainer");
  if (!cont) return;

  const all = Array.from(cont.querySelectorAll(".taxo-row"));
  // Filtra solo las visibles (los hijos de <details> cerrados no se pintan)
  const visibles = all.filter(r => r.offsetParent !== null);

  visibles.forEach((r,i)=>{
    r.classList.toggle("zebra-even", i % 2 === 0);
    r.classList.toggle("zebra-odd",  i % 2 === 1);
  });
}


// Acciones del árbol
function taxoOnToggle(ev, id){
  const details = ev.currentTarget?.parentElement;
  const caretEl = document.getElementById(`${id}-caret`);
  if (caretEl) caretEl.textContent = details.open ? "▾" : "▸";
}

async function taxoWikisearch(ev, query){
  ev.preventDefault(); ev.stopPropagation();

  // 1) Resolver el path del nodo del que sale el clic
  const sum  = ev.currentTarget?.closest('summary.taxo-row');
  const d    = sum?.closest('details.taxo-details');
  const path = d?.getAttribute('data-path') || "";

  // 2) Marca optimista (si es hoja, se pondrá en verde y recalculará padres)
  if (path) {
    markVisited(path);   // lo tenías
    pushRecent(path);    // 👈 NUEVO: cuenta como “visto recientemente”
  }

  // 3) Intentar abrir el artículo
  let ok = await tryOpenExactArticle(query);
  if (!ok) ok = await kiwixSearchAndOpen(query, 10);
}

/* === Botón 👨‍🏫 para Encartha en hojas (reemplazo completo) === */
async function taxoAskEncartha(ev, query){
  ev.preventDefault(); ev.stopPropagation();

  // ── Construir "Title (wiki)" para el prompt ───────────────────────────────
  const btn = ev.currentTarget;

  // 1) wikiTerm: intenta leer el término wiki exacto desde data-title del botón
  let wikiTerm = "";
  try {
    wikiTerm = (btn && btn.getAttribute && (btn.getAttribute("data-title") || btn.dataset?.title)) || "";
  } catch {}

  // 2) humanTitle: intenta leer el título humano visible en la fila/tarjeta
  let humanTitle = "";
  try {
    const row = btn.closest("summary.taxo-row") || btn.closest(".row");
    const titleEl = row && (row.querySelector(".taxo-title, .taxo-label, strong"));
    humanTitle = (titleEl && titleEl.textContent || "").trim();
  } catch {}

  if (!humanTitle) humanTitle = (query || "").trim();
  if (!wikiTerm)  wikiTerm  = (query || "").trim();

  // 3) termForPrompt: "Title (wiki)" si son distintos; si no, uno de los dos
  const termForPrompt = (humanTitle && wikiTerm && humanTitle !== wikiTerm)
    ? `${humanTitle} (${wikiTerm})`
    : (humanTitle || wikiTerm || "").trim();

  // Para abrir Wikipedia por detrás, priorizamos el término wiki si existe
  const openKey = (wikiTerm || query || "").trim();

  // ── 1) Abrimos/colocamos el artículo "por detrás" ANTES del modal ─────────
  try {
    let opened = await tryOpenExactArticle(openKey);
    if (!opened) opened = await kiwixSearchAndOpen(openKey, 10);
    if (!opened) {
      // si no hay match exacto, preparamos una búsqueda
      state.wiki.pendingUrl = buildViewerSearchUrl(openKey || "");
    }
    // dejamos la vista de Wikipedia activa por detrás
    await setMode("wiki");
  } catch(e){ console.warn(e); }

  // ── 1.b) Marcar como visitado/completado + guardar “último” + feedback ────
  try {
    // intentamos resolver el path relativo del nodo desde el <details> contenedor
    const sum  = btn.closest('summary.taxo-row') || btn.closest('.row');
    const det  = sum?.closest('details.taxo-details');
    const relPath = det?.getAttribute('data-path') || humanTitle || "";

    const treeId = state._currentTreeId;
    const locTree = state._currentTreeLocalized || (state._encarthaTrees||{})[treeId];
    const absPath = locTree ? encarthaAbsPath(locTree, relPath) : "";

    if (absPath){
      // marca progreso + guarda “último”
      markVisited(absPath);
      saveLastFor(treeId, absPath);

      // pulso verde en el árbol si existe la fila
      try {
        const sel = `[data-path="${CSS.escape(absPath)}"] > .taxo-row`;
        const rowTree = document.querySelector(sel);
        if (rowTree){
          rowTree.classList.remove("status-todo","status-progress");
          rowTree.classList.add("status-done","pulse3");
          setTimeout(()=> rowTree.classList.remove("pulse3"), 2800);
        }
      } catch {}

      // toast con % global del árbol
      try {
        const { pct, done, total } = achievementsProgressSnapshot();
        const titleTree = state._currentTreeLocalized?.title || treeId || "";
        const msgHTML = `✅ <b>${pct}%</b> de <i>${escapeHTML(titleTree)}</i> (${done}/${total})`;
        ensureToastSetup();
        toast(msgHTML, 5600);
      } catch {}
    }
  } catch(e){ console.warn(e); }

  // ── 2) Mostramos el modal ─────────────────────────────────────────────────
  showEncarthaConfirm(
    "¿Quieres que Michael Encartha resuma el artículo abierto y te proponga cómo seguir profundizando?",
    async ()=>{ // Sí
      // 2.a) Saltar saludo/introducción de Encartha SOLO en esta entrada
      state.skipNextAgentGreeting = true;
      state._encarthaIntroShown   = true;

      // 2.a.1) (IMPORTANTE) Vaciar memoria del backend para respuestas largas
      try {
        await fetch(`${BASE_URL}/api/reset`, { method:"POST" });
      } catch {}

      // 2.a.2) Vaciar también el hilo local del agente Encartha
      try {
        const enc = findAgentByName && findAgentByName("Michael Encartha");
        const k = enc ? agentKey(enc) : agentKey({name:"Michael Encartha"});
        if (!state.chats) state.chats = { model:[], agents:{} };
        if (!state.chats.agents) state.chats.agents = {};
        state.chats.agents[k] = [];   // hilo limpio
        renderConversation();
      } catch {}

      // 2.b) Cambiamos a agentes y seleccionamos a Encartha
      await setMode("agents");
      await openAgentByName("Michael Encartha");

      // 2.c) Mensaje "oculto" (no pintamos burbuja del usuario), usando Title (wiki)
      const lang = state.lang || "es";
      const msgES = `Dame una definición divulgativa de “${termForPrompt}”.`;
      const msgEN = `Give me a popular-science style definition of “${termForPrompt}”.`;
      const msgFR = `Donne-moi une définition vulgarisée de « ${termForPrompt} ».`;
      const msg   = (lang.startsWith("en") ? msgEN : lang.startsWith("fr") ? msgFR : msgES);

      // 👇 clave: llamamos directo al backend sin addMessage("user", …)
      await sendToBackend(msg, { encarthaMode: "def" });
    },
    ()=>{ /* No → no hacemos nada */ }
  );
}



// Navegación dentro de Kiwix (2 vistas + recordatorio de última vista)
async function openCatalog(){
  const cat = document.getElementById("wikiTreesCatalog");
  const pnl = document.getElementById("wikiTreesPanel");
  _show(cat); _hide(pnl);
  state.wikiTrees_lastView = "catalog";
  bindWikiToolbarButtons();

  // 1) cargar catálogo completo
  const data = await fetchTaxonomyCatalog();
  state._wikiCatalog = data || {};
  const items = Array.isArray(data.items) ? data.items : [];
  const categories = Array.isArray(data.categories) ? data.categories : [];

  // 2) indexar categorías localizadas para acceso rápido
  const lang = state.lang || "en";
  state._wikiCategoriesById = {};
  for (const c of categories) {
    const L = (c.i18n && (c.i18n[lang] || c.i18n.en)) || {};
    state._wikiCategoriesById[c.id] = {
      id: c.id,
      emoji: c.emoji || "",
      label: L.label || c.id
    };
  }

  // 3) chips dinámicos (incluye "All")
  const chipsBox = document.getElementById("wikiCatChips");
  if (chipsBox){
    const counts = {};
    for (const it of items) { counts[it.category] = (counts[it.category] || 0) + 1; }

    const makeChip = (id, label, emoji, count, active) => {
      const cls = `filter-chip${active ? " active": ""}`;
      const cnt = (typeof count === "number") ? `<span class="count">${count}</span>` : "";
      return `<button class="${cls}" data-cat="${id || ""}">${emoji ? (emoji + " ") : ""}${_html(label)}${cnt}</button>`;
    };

    const allCount = items.length;
    const ALL_LABEL = { en:"All", es:"Todas", fr:"Toutes" }[lang] || "All";
    const chips = [];

    // chip "All"
    chips.push(makeChip("", ALL_LABEL, "✨", allCount, !state.wikiTrees_selectedCat));

    // chips por categoría (orden como viene del JSON)
    for (const c of categories) {
      const count = counts[c.id] || 0;
      if (count === 0) continue; // no muestres chips vacíos
      const L = state._wikiCategoriesById[c.id];
      const active = state.wikiTrees_selectedCat === c.id;
      chips.push(makeChip(c.id, L.label, L.emoji, count, active));
    }

    chipsBox.innerHTML = chips.join("");

    // click handler
    chipsBox.querySelectorAll(".filter-chip").forEach(btn => {
      btn.onclick = () => {
        const sel = btn.getAttribute("data-cat") || "";
        state.wikiTrees_selectedCat = sel || null;

        // actualizar active
        chipsBox.querySelectorAll(".filter-chip").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");

        // re-render catálogo con filtros
        renderCatalog(items);
      };
    });
  }

  // 4) render catálogo inicial
  renderCatalog(items);

  // 5) filtro texto enlazado
  const inp = document.getElementById("catalogFilter");
  if (inp){
    inp.value = "";
    inp.oninput = () => renderCatalog(items);
  }

  // i18n dinámico
  const wikiTreesCatalogTitle = document.getElementById("wikiTreesCatalogTitle");
  if (wikiTreesCatalogTitle) wikiTreesCatalogTitle.textContent = t("wikiTreesCatalogTitle");
  const catalogClose = document.getElementById("catalogClose");
  if (catalogClose) catalogClose.textContent = t("wikiTreesClose");
  if (inp) inp.setAttribute("placeholder", t("wikiTreesFilter"));
}

function encarthaAbsPath(treeOrLocalized, anyPath){
  const rootTitle = String((treeOrLocalized?.title) || "").trim();
  if (!anyPath || anyPath === "/") return rootTitle || anyPath || "/";
  const p = String(anyPath).trim();
  return (rootTitle && !p.startsWith(rootTitle)) ? `${rootTitle} › ${p}` : p;
}

async function openTreeFromCatalog(treeId, title, startPath = ""){
  // Mostrar panel de árbol y ocultar catálogo
  const cat = document.getElementById("wikiTreesCatalog");
  const pnl = document.getElementById("wikiTreesPanel");
  _hide(cat); _show(pnl);
  state.wikiTrees_lastView = "panel";

  // Carga + localiza árbol
  const data = await fetchTaxonomyTree(treeId);
  state.wikiTrees_lastData = data;
  const localized = localizeTaxoTree(data, state.lang || "en");
  state._currentTreeLocalized = localized;

  // Estado base del árbol actual (¡una sola vez, sin duplicados!)
  state._currentTreeId   = treeId;
  state._treeIndex       = buildTreeIndex(localized);     // índice SOLO de este árbol
  state._treeVisited     = loadProgressFor(treeId) || {}; // progreso SOLO de este árbol
  state._treeFavs        = loadFavsFor(treeId);
  state._treeRecents     = loadRecentsFor(treeId);

  // Limpia menús desplegables si venías de otro árbol
  document.getElementById("favMenu")?.classList.add("hidden");
  document.getElementById("recMenu")?.classList.add("hidden");
  const favMenu = document.getElementById("favMenu");
  const recMenu = document.getElementById("recMenu");
  if (favMenu) favMenu.innerHTML = "";
  if (recMenu) recMenu.innerHTML = "";

  // Renderiza árbol
  renderTree(localized);
  paintStatuses();                 // pinta puntos y % con el estado cargado
  refreshAchievementsUI?.();       // si tienes badge de 🏆

  // Si piden abrir un path concreto, expándelo hasta ese nodo exacto
  if (startPath && typeof openPathByTitles === "function"){
    // Normaliza a absoluto con título raíz, luego quita la raíz para el openPathByTitles
    const abs = encarthaAbsPath(localized, startPath);
    let parts = abs.split("›").map(s=>s.trim()).filter(Boolean);
    const rootTitle = String(localized.title || "").trim();
    if (parts.length && parts[0] === rootTitle) parts.shift();
    if (parts.length) openPathByTitles(parts);
  }

  // 🔤 i18n cabecera
  const backBtn  = document.getElementById("treeBack");
  if (backBtn)  backBtn.textContent  = t("wikiTreesBack");
  const closeBtn = document.getElementById("treeClose");
  if (closeBtn) closeBtn.textContent = t("wikiTreesClose");

  // 🔤 i18n buscador (placeholder + botón)
  const inp  = document.getElementById("treeSearch");
  const btn  = document.getElementById("treeSearchBtn");
  if (inp){
    inp.setAttribute("placeholder", t("treeSearchPlaceholder"));
    inp.onkeydown = (ev) => { if (ev.key === "Enter") doTreeSearch(); };
  }
  if (btn){
    btn.textContent = t("treeSearchBtn");
    btn.onclick = () => doTreeSearch();
  }

  // Botones expandir/colapsar/level 2
  const exAll = document.getElementById("expAll");
  const coAll = document.getElementById("colAll");
  const exL2  = document.getElementById("expLvl2");
  if (exAll){
    exAll.onclick = expandAllTree;
    exAll.title   = t("expandAllTitle");
  }
  if (coAll){
    coAll.onclick = collapseAllTree;
    coAll.title   = t("collapseAllTitle");
  }
  if (exL2){
    exL2.onclick  = () => expandToLevel(2);
    exL2.title    = t("expandLevel2Title");
  }

  // Toggle vista plana
  const tog = document.getElementById("toggleFlat");
  if (tog){
    tog.title  = t("toggleViewTitle");
    tog.onclick = () => {
      const treeShown = !document.getElementById("wikiTreesContainer")?.classList.contains("hidden");
      if (treeShown){
        renderFlatList(state._currentTreeLocalized);
        setTreeView(false);
      }else{
        setTreeView(true);
      }
    };
  }

  // Menús desplegables: Favoritos / Recientes / Logros
  const favBtn = document.getElementById('favMenuBtn');
  const recBtn = document.getElementById('recMenuBtn');
  const achBtn = document.getElementById('achMenuBtn');
  if (favBtn){
    favBtn.title = t("favoritesTitle");
    favBtn.onclick = ()=>{
      renderFavs();
      toggleMenu('favMenu');
    };
  }
  if (recBtn){
    recBtn.title = t("recentsTitle");
    recBtn.onclick = ()=>{
      renderRecents();
      toggleMenu('recMenu');
    };
  }
  if (achBtn){
    achBtn.title = t("achievementsTitle");
    achBtn.onclick = ()=>{
      renderAchievementsMenu();
      toggleMenu('achMenu');
    };
  }

  // Botón de reset de progreso (🚫)
  const resetBtn = document.getElementById('resetTreeBtn');
  if (resetBtn){
    resetBtn.title = t("resetProgress");
    resetBtn.onclick = showResetModal;
  }

  // Al abrir un árbol, badge actualizado
  refreshAchievementsUI?.();
}


function forEachDetails(cb){
  const root = document.getElementById("wikiTreesContainer");
  if (!root) return;
  root.querySelectorAll('details.taxo-details').forEach(cb);
}
function expandAllTree(){
  forEachDetails(d => {
    d.open = true;
    const c = d.querySelector('.taxo-caret'); if (c) c.textContent = '▾';
  });
  applyZebraStriping();
}
function collapseAllTree(){
  forEachDetails(d => {
    // mantenemos solo la raíz abierta
    const level = Number(d.closest('.taxo-node')?.getAttribute('data-level')||"0");
    d.open = (level === 0);
    const c = d.querySelector('.taxo-caret'); if (c) c.textContent = d.open ? '▾' : '▸';
  });
  applyZebraStriping();
}
function expandToLevel(n){
  forEachDetails(d => {
    const level = Number(d.closest('.taxo-node')?.getAttribute('data-level')||"0");
    d.open = (level <= n);
    const c = d.querySelector('.taxo-caret'); if (c) c.textContent = d.open ? '▾' : '▸';
  });
  applyZebraStriping();
}


// DFS: devuelve la PRIMERA ruta de títulos que contiene el término (case-insensitive)
function findPathByQuery(node, q, path = []){
  if (!node) return null;
  const here = String(node.title || "");
  const nextPath = path.concat([here]);
  if (here.toLowerCase().includes(q)) return nextPath;
  for (const ch of (node.children || [])){
    const r = findPathByQuery(ch, q, nextPath);
    if (r) return r;
  }
  return null;
}

// Abre detalles siguiendo una lista de títulos (raíz→hoja aproximada)
function openPathByTitles(titles){
  const root = document.getElementById("wikiTreesContainer");
  if (!root || !titles || !titles.length) return;

  // empezamos desde el contenedor y vamos descendiendo
  let scope = root;
  for (let i=0; i<titles.length; i++){
    const wanted = titles[i];
    // buscamos el primer <details taxo-details> con data-title == wanted DENTRO del scope actual
    const detail = Array.from(scope.querySelectorAll('details.taxo-details'))
      .find(d => (d.getAttribute('data-title') || '') === wanted);
    if (!detail) break;

    // abrir y actualizar caret
    detail.open = true;
    const sum = detail.querySelector('summary.taxo-row');
    const caret = sum && sum.querySelector('.taxo-caret');
    if (caret) caret.textContent = '▾';

    // siguiente scope: sus hijos
    const kids = detail.querySelector('.taxo-children');
    if (kids) scope = kids;

    // si es el último de la ruta, hacemos scroll y un pequeño “ping”
	if (i === titles.length - 1){
	  sum?.scrollIntoView({ behavior: 'smooth', block: 'center' });
	  sum?.classList.add('is-highlight');
	  // 900ms * 4 pulsos + margen
	  setTimeout(()=> sum?.classList.remove('is-highlight'), 3800);
	}
  }
}

// Ejecuta la búsqueda y abre el primer match
function doTreeSearch(){
  const inp = document.getElementById("treeSearch");
  const q = String(inp?.value || "").trim();
  clearTreeHighlights();

  if (!q){ return; }

  // Abre y centra la primera coincidencia (como antes)
  const tree = state._currentTreeLocalized || null;
  if (!tree) return;

  const path = findPathByQuery(tree, q.toLowerCase());
  if (path && path.length){ openPathByTitles(path); }

  // Resaltado de TODAS las coincidencias visibles
  highlightTreeMatches(q);
}

function clearTreeHighlights(){
  const cont = document.getElementById("wikiTreesContainer");
  if (!cont) return;
  cont.querySelectorAll('.taxo-title').forEach(el => {
    const raw = el.getAttribute('data-raw') || el.textContent;
    el.setAttribute('data-raw', raw);
    el.textContent = raw;
  });
}

function highlightTreeMatches(q){
  const cont = document.getElementById("wikiTreesContainer");
  if (!cont) return;
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), "ig");

  cont.querySelectorAll('.taxo-title').forEach(el => {
    const raw = el.getAttribute('data-raw') || el.textContent;
    el.setAttribute('data-raw', raw);
    el.innerHTML = raw.replace(re, m => `<mark class="tree-hit">${m}</mark>`);
  });
}

// Restaura la última vista visible tras expandir
function restoreWikiTreesLastView(){
  const cat = document.getElementById("wikiTreesCatalog");
  const pnl = document.getElementById("wikiTreesPanel");
  if (state.wikiTrees_lastView === "panel"){
    _hide(cat); _show(pnl);
  } else {
    _show(cat); _hide(pnl);
  }
}

function ensureToastSetup(){
  if (document.getElementById("toast-host")) return;
  const host = document.createElement("div");
  host.id = "toast-host";
  host.setAttribute("aria-live","polite");
  Object.assign(host.style, {
    position:"fixed", right:"16px", bottom:"16px",
    display:"flex", flexDirection:"column", gap:"8px",
    zIndex:"99999", pointerEvents:"none"
  });
  document.body.appendChild(host);
}

// ===== INTRO MODAL (mensaje inicial OFFLINED) =====

const INTRO_MODAL_KEY = "offlined.intro.dismissed.v1";

function ensureIntroModal() {
  let overlay = document.getElementById("introModalOverlay");
  if (overlay) {
    // Si ya existe, solo actualizamos textos por si ha cambiado el idioma
    rebuildIntroModalTexts(overlay);
    return overlay;
  }

  overlay = document.createElement("div");
  overlay.id = "introModalOverlay";
  overlay.className = "intro-modal-backdrop";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");

  overlay.innerHTML = `
    <div class="intro-modal-dialog">
      <h2 class="intro-modal-title">${t("introModalTitle")}</h2>
      <div class="intro-modal-body markdown">
        ${t("introModalBody")}
      </div>
      <label class="intro-modal-remember">
        <input type="checkbox" id="introModalDontShow">
        <span>${t("introModalNeverShowLabel")}</span>
      </label>
      <div class="intro-modal-actions">
        <button type="button" id="introModalCloseBtn" class="btn-primary">
          ${t("introModalClose")}
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const closeBtn   = overlay.querySelector("#introModalCloseBtn");
  const checkbox   = overlay.querySelector("#introModalDontShow");

  function closeIntroModal() {
    if (checkbox && checkbox.checked) {
      try {
        localStorage.setItem(INTRO_MODAL_KEY, "1");
      } catch {}
    }
    try {
      overlay.remove();
    } catch {}
  }

  if (closeBtn) {
    closeBtn.addEventListener("click", closeIntroModal);
  }

  // Clic fuera del cuadro → cerrar
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) {
      closeIntroModal();
    }
  });

  // ESC para cerrar
  document.addEventListener("keydown", function escHandler(ev) {
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeIntroModal();
      document.removeEventListener("keydown", escHandler);
    }
  });

  return overlay;
}

function rebuildIntroModalTexts(overlay) {
  if (!overlay) return;
  const titleEl   = overlay.querySelector(".intro-modal-title");
  const bodyEl    = overlay.querySelector(".intro-modal-body");
  const labelSpan = overlay.querySelector(".intro-modal-remember span");
  const btn       = overlay.querySelector("#introModalCloseBtn");

  if (titleEl)   titleEl.innerHTML = t("introModalTitle");
  if (bodyEl)    bodyEl.innerHTML  = t("introModalBody");
  if (labelSpan) labelSpan.textContent = t("introModalNeverShowLabel");
  if (btn)       btn.textContent   = t("introModalClose");
}

function maybeShowIntroModalOnBoot() {
  let dismissed = false;
  try {
    dismissed = localStorage.getItem(INTRO_MODAL_KEY) === "1";
  } catch {}
  if (dismissed) return;

  ensureIntroModal();
}


function toast(msg, ms=5600){            // ⬅️ antes 2500; ahora 5600ms
  ensureToastSetup();
  const host = document.getElementById("toast-host");
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = String(msg);
  Object.assign(el.style, {
    padding:"10px 12px", background:"rgba(25,25,25,.92)", color:"#fff",
    borderRadius:"8px", fontSize:"14px", boxShadow:"0 6px 20px rgba(0,0,0,.25)",
    maxWidth:"320px", pointerEvents:"auto", transition:"opacity .35s"
  });
  host.appendChild(el);
  setTimeout(()=>{ el.style.opacity="0"; }, Math.max(800, ms-350)); // ⬅️ fade más tarde
  setTimeout(()=> el.remove(), ms);
}

function showWikiBanner(html, ms=5600){   // ⬅️ antes 2400; ahora 5600ms
  const id = "encartha-wiki-banner";
  let el = document.getElementById(id);
  if (!el){
    el = document.createElement("div");
    el.id = id;
    Object.assign(el.style, {
      position:"fixed", top:"16px", left:"50%", transform:"translateX(-50%)",
      zIndex:"99998", background:"rgba(25,25,25,.92)", color:"#fff",
      padding:"10px 14px", borderRadius:"10px", boxShadow:"0 6px 20px rgba(0,0,0,.25)",
      fontSize:"14px", maxWidth:"80vw", pointerEvents:"none"
    });
    document.body.appendChild(el);
  }
  el.innerHTML = html;
  el.style.opacity = "1";
  clearTimeout(el._t);
  el._t = setTimeout(()=>{
    el.style.transition = "opacity .35s";
    el.style.opacity = "0";
  }, ms);
}

document.addEventListener("DOMContentLoaded", setupWikiSplitDrag);

async function ensureQuill(){
  if (quill) return;
  const toolbar = document.getElementById("quillToolbar");
  const editor  = document.getElementById("quillEditor");
  if (!window.Quill) return;
  quill = new Quill(editor, { theme: "snow", modules: { toolbar: toolbar } });
}

// Podemos dejar notesKey por compatibilidad, aunque ya no usamos localStorage
function notesKey(){ return "offlined.notes.v2"; }

// 🗒️ Helpers backend notebook
async function fetchNotesList(){
  try {
    const res = await fetch(`${BASE_URL}/api/notebook/notes`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arr = await res.json();
    return Array.isArray(arr) ? arr : [];
  } catch (e){
    console.error("[NOTES] Error listando notas:", e);
    return [];
  }
}

async function fetchNoteById(id){
  try {
    const res = await fetch(`${BASE_URL}/api/notebook/note?id=${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e){
    console.error("[NOTES] Error cargando nota:", e);
    return null;
  }
}

async function saveNoteToBackend(id, title, delta){
  try {
    const payload = { id, title, delta };
    const res = await fetch(`${BASE_URL}/api/notebook/note`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e){
    console.error("[NOTES] Error guardando nota:", e);
    throw e;
  }
}

async function deleteNoteOnBackend(id){
  try {
    const res = await fetch(`${BASE_URL}/api/notebook/note?id=${encodeURIComponent(id)}`, {
      method: "DELETE"
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e){
    console.error("[NOTES] Error borrando nota:", e);
    throw e;
  }
}

// 🗒️ Cargar listado de notas (solo metadatos) desde media/notebook
async function loadNotes(){
  state.notes = state.notes || { items: [], activeId: null, searchQuery: "" };

  // 1) Pedimos la lista al backend
  const items = await fetchNotesList();
  state.notes.items = items.map(n => ({
    id: n.id,
    title: n.title || t("notesUntitled")
  }));

  // 2) Si no hay ninguna nota, creamos una por defecto
  if (!state.notes.items.length) {
    const id = Date.now().toString();
    const title = t("notesUntitled");
    const delta = { ops: [] };
    try {
      const saved = await saveNoteToBackend(id, title, delta);
      const finalId    = saved.id || id;
      const finalTitle = saved.title || title;
      state.notes.items.push({ id: finalId, title: finalTitle });
      state.notes.activeId = finalId;
    } catch (e){
      console.error("[NOTES] No se pudo crear la nota inicial:", e);
    }
  }

  // 3) Si no hay nota activa, usamos la primera
  if (!state.notes.activeId && state.notes.items.length) {
    state.notes.activeId = state.notes.items[0].id;
  }
}

// 🗒️ Renderizar listado lateral
function renderNotesList(){
  notesList.innerHTML = "";
  const q = (state.notes.searchQuery || "").toLowerCase().trim();

  const items = !q
    ? state.notes.items
    : state.notes.items.filter(n =>
        (n.title || "").toLowerCase().includes(q)
      );

  items.forEach(n => {
    const li = document.createElement("li");
    li.textContent = n.title || t("notesUntitled");
    if (n.id === state.notes.activeId) {
      li.classList.add("active");
    }
    li.addEventListener("click", () => openNote(n.id));
    notesList.appendChild(li);
  });
}


// 🗒️ Abrir una nota concreta (cargar contenido desde backend)
async function openNote(id){
  state.notes.activeId = id;

  // Re-render de la lista para que marque la activa aunque haya filtro
  renderNotesList();

  const meta = state.notes.items.find(x => x.id === id);
  noteTitleInput.value = meta?.title || "";

  if (!quill) return;

  const fullNote = await fetchNoteById(id);
  if (fullNote && fullNote.delta) {
    quill.setContents(fullNote.delta);
  } else {
    quill.setText("");
  }
}


// 🗒️ Crear nota nueva (1 fichero nuevo en media/notebook)
async function noteNew(){
  const id    = Date.now().toString();
  const title = t("notesUntitled");
  const delta = { ops: [] };

  try {
    const saved = await saveNoteToBackend(id, title, delta);
    const finalId    = saved.id || id;
    const finalTitle = saved.title || title;

    state.notes.items.unshift({ id: finalId, title: finalTitle });
    state.notes.activeId = finalId;
    renderNotesList();
    openNote(finalId);
  } catch (e){
    console.error("[NOTES] Error creando nota:", e);
  }
}

// 🗒️ Borrar nota (borrar fichero JSON y actualizar lista)
async function noteDelete(){
  if (!state.notes.activeId) return;
  const id = state.notes.activeId;

  try {
    await deleteNoteOnBackend(id);
  } catch (e){
    // Aunque falle en backend, seguimos limpiando el estado local
    console.error("[NOTES] Error borrando nota en backend:", e);
  }

  const i = state.notes.items.findIndex(n=> n.id === id);
  if (i >= 0) {
    state.notes.items.splice(i,1);
  }
  state.notes.activeId = state.notes.items[0]?.id || null;

  renderNotesList();

  if (state.notes.activeId) {
    openNote(state.notes.activeId);
  } else {
    noteTitleInput.value = "";
    if (quill) quill.setText("");
  }
}

// 🗒️ Guardar cambios de la nota activa (solo esa nota)
async function noteSave(){
  const id = state.notes.activeId;
  if (!id) return;
  const idx = state.notes.items.findIndex(n=> n.id===id);
  if (idx < 0) return;

  const title = (noteTitleInput.value || "").trim() || t("notesUntitled");
  const delta = quill
    ? quill.getContents()
    : { ops: [{ insert: document.getElementById("quillEditor").innerText + "\n" }] };

  try {
    const saved = await saveNoteToBackend(id, title, delta);
    state.notes.items[idx].title = saved.title || title;
    renderNotesList();
  } catch (e){
    console.error("[NOTES] Error guardando nota:", e);
  }
}


// ===== CALENDAR =====
// ===== CALENDAR: cargar/guardar contra el backend (media/calendar) =====
async function loadCalendarEvents(){
  state.calendar = state.calendar || {};
  try {
    const res = await fetch(`${BASE_URL}/api/calendar/events`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arr = await res.json();
    state.calendar.events = Array.isArray(arr) ? arr : [];
  } catch (e){
    console.warn("[CAL] Error cargando eventos desde backend, usando lista vacía:", e);
    state.calendar.events = [];
  }
}

async function saveCalendarEvents(){
  try {
    const events = state.calendar.events || [];
    await fetch(`${BASE_URL}/api/calendar/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(events)
    });
  } catch (e){
    console.error("[CAL] Error guardando eventos en backend:", e);
  }
}


async function ensureCalendar(){
  // Si el calendario ya existe, solo re-render y recalcular títulos
  if (_fc) { 
    _fc.render();
    calTitle.textContent = _fc.view?.title || "";
    // 🔧 Asegura títulos de cada mes también cuando solo re-renderizamos
    fixMultiMonthTitles();
    return;
  }

  // ⬇️ NUEVO: cargamos eventos desde el backend (media/calendar)
  await loadCalendarEvents();

  // idioma (respetando EN, ES, FR, PT)
  const map = { es: "es", en: "en", fr: "fr", pt: "pt" };
  const locale = map[(state.lang||"en").slice(0,2)] || "en";

  _fc = new FullCalendar.Calendar(calendarHost, {
    initialView: state.calendar.lastView || "dayGridMonth",
    initialDate: state.calendar.lastDate || undefined,
    height: "100%",
    expandRows: true,
    locale,
    editable: true,
    selectable: true,
    headerToolbar: false,    // usamos nuestra toolbar
    navLinks: true,
    dayMaxEventRows: true,

    // 👇 aquí usamos los eventos que acabamos de cargar de media/calendar
    events: state.calendar.events || [],

    // 🔁 Se ejecuta cada vez que cambian las fechas / vista (prev, next, hoy, cambiar vista, etc.)
    datesSet(info){
      state.calendar.lastView = info.view.type;
      state.calendar.lastDate = info.startStr;
      calTitle.textContent = info.view?.title || "";

      // 🔧 Reajusta títulos de cada mes cuando cambian las fechas (punto 2.2)
      fixMultiMonthTitles();
    },

    select(arg){
      // Mostrar modal propio
      openCalModal({ 
        mode: "create", 
        dateStr: arg.startStr, 
        allDay: arg.allDay 
      });
      _fc.unselect();
    },

    eventClick(info){
      const ev = info.event;
      // 🔁 Abrir SIEMPRE el modal de edición, sin confirm nativa
      openCalModal({ mode:"edit", eventObj: ev });
    },

    eventDrop(info){
      persistEventChange(info.event);
    },

    eventResize(info){
      persistEventChange(info.event);
    }
  });

  // Etiquetas traducidas en botones (emoji + texto)
  if (calTodayBtn) calTodayBtn.innerHTML = `📍 ${t("calToday")}`;
  if (calPrevBtn)  calPrevBtn.innerHTML  = `◀ ${t("calPrev")}`;
  if (calNextBtn)  calNextBtn.innerHTML  = `${t("calNext")} ▶`;

  if (calViewMonth) calViewMonth.innerHTML = `📅 ${t("calMonth")}`;
  if (calViewWeek)  calViewWeek.innerHTML  = `🗓️ ${t("calWeek")}`;
  if (calViewDay)   calViewDay.innerHTML   = `📆 ${t("calDay")}`;
  if (calViewList)  calViewList.innerHTML  = `🧾 ${t("calList")}`;
  if (calViewMulti) calViewMulti.innerHTML = `🗂️ ${t("calMulti")}`;

  _fc.render();
  calTitle.textContent = _fc.view?.title || "";

  // 🔧 Asegura títulos de cada mes en vista multi-mes tras el primer render (punto 2.1)
  fixMultiMonthTitles();
}

  //function ensureWhiteboardIframe() {
  //  if (!whiteboardFrame) return;
  //
  //  const base = `${BASE_URL || ""}/vendor/excalidraw/index.html`;
  //  const params = new URLSearchParams();
  //
  //  // Tema actual de la app
  //  const theme = document.documentElement.dataset.theme || "light";
  //  params.set("theme", theme);
  //
  //  // Si hay un fichero asociado (cuando vienes de “Abrir en el editor”)
  //  if (state.whiteboardFile) {
  //    params.set("file", state.whiteboardFile);
  //  }
  //
  //  whiteboardFrame.src = `${base}?${params.toString()}`;
  //}

// 🔧 Multi-month: usar solo un mes en cabecera y evitar duplicados
function fixMultiMonthTitles() {
  if (!_fc || !calendarHost || !calTitle) return;

  const view = _fc.view;
  if (!view || !view.type || !view.type.startsWith("multiMonth")) return;

  const titles = calendarHost.querySelectorAll(".fc-multimonth-title");
  if (!titles.length) return;

  // Texto del primer bloque, normalmente "febrero de 2025"
  let raw = (titles[0].textContent || "").trim();

  // Quitar año (cualquier 4 dígitos) y la preposición "de" final
  raw = raw
    .replace(/\d{4}/, "")      // quita "2025"
    .replace(/\s+de\s*$/i, "") // quita "de" suelto al final
    .trim();

  if (!raw) {
    raw = (titles[0].textContent || "").trim();
  }

  // Cabecera propia del calendario: solo el mes
  calTitle.textContent = raw;

  // Evitar que se vea dos veces:
  // ocultamos el título del PRIMER mes y dejamos visibles el resto
  titles.forEach((el, idx) => {
    el.style.display = (idx === 0) ? "none" : "";
  });
}


function promptNewEvent(){
  openCalModal({ mode:"create" });
}

function persistEventChange(ev){
  const idx = (state.calendar.events||[]).findIndex(e=>e.id===ev.id);
  const payload = {
    id: ev.id,
    title: ev.title,
    start: ev.startStr || (ev.start?.toISOString()),
    end:   ev.endStr   || (ev.end?.toISOString()) || null,
    allDay: ev.allDay
  };
  if (idx>=0) state.calendar.events[idx] = payload; else state.calendar.events.push(payload);
  saveCalendarEvents();
}

function openCalModal({ mode="create", dateStr=null, allDay=true, eventObj=null }={}){
  _calEditingEvent = (mode === "edit" ? eventObj : null);

  // Título del modal según modo
  calModalTitle.textContent = t(mode === "edit" ? "calNew_edit" : "calNew_title");
  calSave.textContent = t(mode === "edit" ? "calNew_save" : "calNew_create");

  // Prefills
  const todayISO = (new Date()).toISOString().slice(0,10);
  const startISO = (dateStr && dateStr.slice(0,10)) || (_fc?.getDate?.().toISOString().slice(0,10)) || todayISO;
  calInputDate.value = startISO;

  if (_calEditingEvent) {
    calInputTitle.value = _calEditingEvent.title || "";
    // Si el evento no es allDay y tiene hora, precarga hora
    try{
      const evStart = _calEditingEvent.start;
      if (evStart && ! _calEditingEvent.allDay) {
        const h = String(evStart.getHours()).padStart(2,"0");
        const m = String(evStart.getMinutes()).padStart(2,"0");
        calInputTime.value = `${h}:${m}`;
      } else {
        calInputTime.value = "";
      }
    } catch { calInputTime.value = ""; }
  } else {
    calInputTitle.value = "";
    calInputTime.value = "";
  }

  // Mostrar fila de hora SOLO en vista mensual
  const viewType = _fc?.view?.type || "dayGridMonth";
  const showTimeRow = (viewType === "dayGridMonth");
  calTimeRow.style.display = showTimeRow ? "flex" : "none";

  _calDraft = { startDateStr: startISO, allDay: allDay };
  calOverlay.classList.remove("hidden");
  calInputTitle.focus();
}

function closeCalModal(){
  calOverlay.classList.add("hidden");
  _calEditingEvent = null;
  _calDraft = null;
}

function buildEventFromModal(){
  // Seguridad: comprobar que los inputs existen
  if (!calInputTitle || !calInputDate) {
    console.warn("[CAL] buildEventFromModal: inputs no encontrados", {
      calInputTitle,
      calInputDate,
      calInputTime,
      calTimeRow
    });
    return null;
  }

  const title = (calInputTitle.value || "").trim();
  const date  = (calInputDate.value || "").trim();

  // Si la fila de hora está oculta (vista mes), no usamos hora
  const timeVisible = !calTimeRow.classList.contains("hidden");
  const time = timeVisible ? (calInputTime.value || "").trim() : "";

  const viewType = _fc ? _fc.view.type : "(sin _fc)";

  console.log("[CAL] buildEventFromModal → valores leídos:", {
    title,
    date,
    time,
    timeVisible,
    viewType
  });

  // Reglas mínimas: título y fecha obligatorios
  if (!title || !date){
    console.warn("[CAL] buildEventFromModal: título o fecha vacíos → null");
    return null;
  }

  const allDay = !time;
  const startStr = allDay ? `${date}T00:00:00` : `${date}T${time}`;

  const ev = {
    id: _calEditingEvent ? _calEditingEvent.id : `ev-${Date.now()}`,
    title,
    start: startStr,
    allDay
  };

  console.log("[CAL] buildEventFromModal → evento construido:", ev);
  return ev;
}


function handleCalSaveClick(e){
  e.preventDefault();
  e.stopPropagation();

  console.log("[CAL] handleCalSaveClick: click detectado. Editando?", !!_calEditingEvent, {
    _calEditingEvent
  });

  const evObj = buildEventFromModal();
  console.log("[CAL] handleCalSaveClick: resultado buildEventFromModal:", evObj);

  if (!evObj){
    console.warn("[CAL] handleCalSaveClick: evObj es null → probablemente falta título/fecha");
    return;
  }

  if (!_fc){
    console.error("[CAL] handleCalSaveClick: _fc es null → calendario no inicializado");
    return;
  }

  let existing = null;
  if (_calEditingEvent && _calEditingEvent.id){
    existing = _fc.getEventById(_calEditingEvent.id);
  }

  if (existing){
    console.log("[CAL] handleCalSaveClick: actualizando evento existente:", existing.id);
    existing.setProp("title", evObj.title);
    existing.setAllDay(evObj.allDay);
    existing.setStart(evObj.start);
  } else {
    console.log("[CAL] handleCalSaveClick: creando evento nuevo:", evObj);

    // Aseguramos estructura del estado
    state.calendar = state.calendar || {};
    if (!Array.isArray(state.calendar.events)){
      state.calendar.events = [];
    }

    state.calendar.events.push(evObj);
    _fc.addEvent(evObj);
  }

  try {
    if (typeof saveCalendarEvents === "function"){
      console.log("[CAL] handleCalSaveClick: llamando a saveCalendarEvents()");
      saveCalendarEvents();
    } else {
      console.warn("[CAL] handleCalSaveClick: saveCalendarEvents no está definido");
    }
  } catch (err){
    console.error("[CAL] handleCalSaveClick: error en saveCalendarEvents:", err);
  }

  console.log("[CAL] handleCalSaveClick: cerrando modal");
  closeCalModal();
}

// Enter para guardar en el modal
calInputTitle?.addEventListener("keydown", (e)=>{
  if (e.key === "Enter") {
    e.preventDefault();
    const fakeClick = new Event("click", {bubbles:true});
    document.getElementById("calSave")?.dispatchEvent(fakeClick);
  }
});

function genId(){ return "ev_" + Math.random().toString(36).slice(2,10); }


// ============ 🎙️ AUDIO NOTES (frontend) ============

function _formatAudioTime(sec){
  const s = Math.max(0, sec|0);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return String(m).padStart(2, "0") + ":" + String(r).padStart(2, "0");
}

function _resetAudioTimer(){
  state.audioNotes.elapsedSec = 0;
  if (audioRecTimer) {
    audioRecTimer.textContent = "00:00";
  }
}

function _startAudioTimer(){
  _resetAudioTimer();
  if (state.audioNotes.timerId) {
    clearInterval(state.audioNotes.timerId);
  }
  state.audioNotes.timerId = setInterval(() => {
    state.audioNotes.elapsedSec = (state.audioNotes.elapsedSec || 0) + 1;
    if (audioRecTimer) {
      audioRecTimer.textContent = _formatAudioTime(state.audioNotes.elapsedSec);
    }
  }, 1000);
}

function _stopAudioTimer(){
  if (state.audioNotes.timerId) {
    clearInterval(state.audioNotes.timerId);
    state.audioNotes.timerId = null;
  }
}

function slugifyAudioTitle(raw) {
  const s = (raw || "")
    .normalize("NFD")                    // quita acentos
    .replace(/[\u0300-\u036f]/g, "");
  const slug = s
    .replace(/[^a-z0-9_\-]+/gi, "_")     // solo letras/números/guiones
    .replace(/^_+|_+$/g, "")             // recorta guiones bajos al inicio/fin
    .toLowerCase();
  return slug || "nota_audio";
}

function setAudioUiMode(mode){
  // mode: "new" | "readonly"
  state.audioNotes.uiMode = mode;

  const controlsRow = document.querySelector("#audioNotesView .audio-controls");
  const filtersRow  = document.querySelector("#audioNotesView .audio-filters");

  const canRecord = (mode === "new");

  if (controlsRow) {
    controlsRow.style.display = canRecord ? "flex" : "none";
  }
  if (filtersRow) {
    filtersRow.style.display = canRecord ? "flex" : "none";
  }

  if (audioRecBtn) {
    audioRecBtn.disabled = !canRecord;
  }
  if (audioStopBtn) {
    audioStopBtn.disabled = true;
  }
}


function updateAudioRecordingUi(isRecording){
  state.audioNotes.isRecording = !!isRecording;
  if (audioRecBtn)  audioRecBtn.disabled  = isRecording;
  if (audioStopBtn) audioStopBtn.disabled = !isRecording;
  if (!isRecording) {
    _stopAudioTimer();
  }
}

function cleanupAudioStream(){
  try {
    if (state.audioNotes.mediaRecorder) {
      state.audioNotes.mediaRecorder.ondataavailable = null;
      state.audioNotes.mediaRecorder.onstop = null;
    }
  } catch {}
  if (state.audioNotes.stream) {
    state.audioNotes.stream.getTracks().forEach(tr => tr.stop());
  }
  if (state.audioNotes.audioCtx) {
    state.audioNotes.audioCtx.close().catch(()=>{});
  }
  state.audioNotes.stream        = null;
  state.audioNotes.mediaRecorder = null;
  state.audioNotes.recordedChunks = [];
  state.audioNotes.audioCtx      = null;
  state.audioNotes.graphNodes    = null;
  updateAudioRecordingUi(false);
}

async function buildAudioGraph(stream){
  // Crea un AudioContext para aplicar filtros básicos
  if (!window.AudioContext && !window.webkitAudioContext) {
    return stream;
  }
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audioCtx = new AudioCtx();
  state.audioNotes.audioCtx = audioCtx;

  const source = audioCtx.createMediaStreamSource(stream);

  const highpass = audioCtx.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = state.audioNotes.filters.highpass ? 200 : 20;

  const lowpass = audioCtx.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = state.audioNotes.filters.noiseReduction ? 6000 : 20000;

  const compressor = audioCtx.createDynamicsCompressor();
  if (state.audioNotes.filters.normalize) {
    compressor.threshold.value = -24;
    compressor.knee.value      = 30;
    compressor.ratio.value     = 12;
    compressor.attack.value    = 0.003;
    compressor.release.value   = 0.25;
  }

  const dest = audioCtx.createMediaStreamDestination();

  // Conexión: source → highpass → lowpass → compressor → dest
  source.connect(highpass);
  highpass.connect(lowpass);
  lowpass.connect(compressor);
  compressor.connect(dest);

  state.audioNotes.graphNodes = { source, highpass, lowpass, compressor, dest };
  return dest.stream;
}

async function startAudioRecording(){
  // 1) NO permitir grabar sin nombre (igual que ahora)
  const title = (audioTitleInput?.value || "").trim();
  if (!title) {
    const dlgTitle = t("audioNameRequiredTitle") || "Nombre requerido";
    const dlgMsg   = t("audioNameRequiredMsg")   || "Antes de grabar, asigna un nombre a la nota de audio.";

    showConfirmDialog({
      title: dlgTitle,
      message: dlgMsg,
      confirmLabel: "OK",
      cancelLabel: "",
      onConfirm: ()=>{
        if (audioTitleInput) audioTitleInput.focus();
      }
    });

    return;
  }

  // 2) Comprobar si ya hay otra nota con el mismo "slug" de nombre
  const currentId = state.audioNotes.activeId;
  const desiredSlug = slugifyAudioTitle(title);

  const conflict = (state.audioNotes.items || []).find(note => {
    const noteTitle = (note?.title || "").trim();
    if (!noteTitle) return false;
    const noteSlug = slugifyAudioTitle(noteTitle);
    // Conflicto si coincide el slug y NO es la misma nota activa
    return noteSlug === desiredSlug && note.id !== currentId;
  });

  if (conflict) {
    const dlgTitle = t("audioOverwriteConfirmTitle");
    const dlgMsg   = tfmt("audioOverwriteConfirmMsg", { name: title });

    showConfirmDialog({
      title: dlgTitle,
      message: dlgMsg,
      confirmLabel: t("resetYes") || "OK",
      cancelLabel: t("resetNo") || "Cancel",
      onConfirm: () => {
        // Vamos a sobrescribir ESA nota
        state.audioNotes.activeId = conflict.id;
        actuallyStartAudioRecording();
      }
    });

    return;
  }

  // 3) Sin conflicto → grabación normal
  actuallyStartAudioRecording();
}

// 👇 Esta función lleva TODA la parte de MediaRecorder que ya tenías
async function actuallyStartAudioRecording(){
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert(t("audioNoSupport"));
    return;
  }
  if (state.audioNotes.isRecording) return;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.audioNotes.stream = stream;

    // Construimos grafo de audio si hay filtros activados
    const anyFilter = state.audioNotes.filters.normalize ||
                      state.audioNotes.filters.noiseReduction ||
                      state.audioNotes.filters.highpass;

    const recordStream = anyFilter ? await buildAudioGraph(stream) : stream;

    const options = {};
    if (window.MediaRecorder && MediaRecorder.isTypeSupported &&
        MediaRecorder.isTypeSupported("audio/webm")) {
      options.mimeType = "audio/webm";
    }

    const recorder = new MediaRecorder(recordStream, options);
    state.audioNotes.mediaRecorder  = recorder;
    state.audioNotes.recordedChunks = [];

    recorder.ondataavailable = (ev)=>{
      if (ev.data && ev.data.size > 0) {
        state.audioNotes.recordedChunks.push(ev.data);
      }
    };

    recorder.onstop = handleAudioRecordingStop;

    recorder.start();
    _startAudioTimer();
    updateAudioRecordingUi(true);
  } catch (e){
    console.error("[AUDIO] Error iniciando grabación:", e);
    alert(t("audioNoSupport"));
    cleanupAudioStream();
  }
}


function stopAudioRecording(){
  if (!state.audioNotes.mediaRecorder) return;
  try {
    state.audioNotes.mediaRecorder.stop();
  } catch(e){
    console.warn("[AUDIO] Error al parar grabación:", e);
  }
}

async function handleAudioRecordingStop(){
  const chunks = state.audioNotes.recordedChunks || [];
  const blob   = new Blob(chunks, { type: (state.audioNotes.mediaRecorder && state.audioNotes.mediaRecorder.mimeType) || "audio/webm" });

  cleanupAudioStream();

  if (!blob.size) {
    console.warn("[AUDIO] Grabación vacía, no se guarda.");
    return;
  }

  const id = state.audioNotes.activeId || Date.now().toString();
  let title = (audioTitleInput?.value || "").trim();

  if (!title) {
    alert(t("audioNameRequired"));   // añade esta clave a tus traducciones
    if (audioTitleInput) audioTitleInput.focus();
    return;
  }

  const formData = new FormData();
  formData.append("id", id);
  formData.append("title", title);
  formData.append("file", blob, `${id}.webm`);

  try {
    const res = await fetch(`${BASE_URL}/api/audio/note`, {
      method: "POST",
      body: formData
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const saved = await res.json();

    const finalId    = saved.id   || id;
    const finalTitle = saved.title || title;
    const fileRel    = saved.file || `music/Audio Recordings/${finalId}.webm`;

    const existing = state.audioNotes.items.find(n => n.id === finalId);
    if (existing) {
      existing.title = finalTitle;
      existing.file  = fileRel;
    } else {
      state.audioNotes.items.unshift({ id: finalId, title: finalTitle, file: fileRel });
    }

    state.audioNotes.activeId = finalId;
    renderAudioNotesList();
    openAudioNote(finalId);
  } catch (e){
    console.error("[AUDIO] Error guardando nota de audio:", e);
  }
}

async function loadAudioNotes(){
  state.audioNotes = state.audioNotes || {
    items: [],
    activeId: null,
    searchQuery: "",
    isRecording: false,
    recordedChunks: [],
    mediaRecorder: null,
    stream: null,
    audioCtx: null,
    graphNodes: null,
    filters: state.audioNotes?.filters || {
      normalize: true,
      noiseReduction: true,
      highpass: false
    }
  };

  try {
    const res = await fetch(`${BASE_URL}/api/audio/notes`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arr = await res.json();
    state.audioNotes.items = Array.isArray(arr) ? arr : [];
  } catch (e){
    console.warn("[AUDIO] Error listando notas de audio:", e);
    state.audioNotes.items = [];
  }
}

function renderAudioNotesList(){
  if (!audioNotesList) return;
  audioNotesList.innerHTML = "";

  const q = (state.audioNotes.searchQuery || "").toLowerCase();

  const items = (state.audioNotes.items || []).filter(n => {
    if (!q) return true;
    return (n.title || "").toLowerCase().includes(q);
  });

  items.forEach(n => {
    const li = document.createElement("li");
    li.dataset.id = n.id;
    li.textContent = n.title || t("audioUntitled");
    if (n.id === state.audioNotes.activeId) {
      li.classList.add("active");
    }
    li.addEventListener("click", () => openAudioNote(n.id));
    audioNotesList.appendChild(li);
  });
}

function openAudioNote(id){
  state.audioNotes.activeId = id;
  const item = (state.audioNotes.items || []).find(n => n.id === id);
  if (!item) return;

  if (audioTitleInput) {
    audioTitleInput.value = item.title || t("audioUntitled");
  }

  let rel = item.file || `music/Audio Recordings/${item.id}.webm`;
  rel = String(rel || "").replace(/^\.?\//, "");
  let sub = "music";
  if (rel.toLowerCase().startsWith("music/")) {
    rel = rel.slice("music/".length);
  }
  const url = _mediaUrlOf(sub, rel);
  if (audioPlayer) {
    audioPlayer.src = url;
    audioPlayer.load();
  }

  // Nota ya grabada → solo lectura (no se puede volver a grabar encima)
  setAudioUiMode("readonly");

  renderAudioNotesList();
}



function showAudioDeleteConfirm(name){
  const title = t("audioDeleteConfirmTitle");
  const msg   = tfmt("audioDeleteConfirmMsg", { name });

  showConfirmDialog({
    title,
    message: msg,
    confirmLabel: t("audioDelete"),
    cancelLabel: t("resetNo"),
    onConfirm: audioNoteDelete      // ⬅ aquí es donde realmente se borra
  });
}

async function audioNoteDelete(){
  if (!state.audioNotes.activeId) return;

  const id = state.audioNotes.activeId;

  try {
    const res = await fetch(
      `${BASE_URL}/api/audio/note?id=${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e){
    console.error("[AUDIO] Error borrando nota de audio:", e);
    alert("Error deleting audio note");
  }

  // Quitar del estado
  state.audioNotes.items = (state.audioNotes.items || []).filter(n => n.id !== id);
  state.audioNotes.activeId = null;

  // Limpiar UI
  if (audioTitleInput) audioTitleInput.value = "";
  if (audioPlayer) {
    audioPlayer.removeAttribute("src");
    audioPlayer.load();
  }

  // Volver a modo "nueva nota" (muestra controles de grabación)
  if (typeof setAudioUiMode === "function") {
    setAudioUiMode("new");
  }

  renderAudioNotesList();
}
