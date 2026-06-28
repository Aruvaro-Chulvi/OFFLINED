# Inventario de licencias de terceros — Offlined

Mapeo de cada componente distribuido con la app a su licencia y al archivo
con el texto legal en esta carpeta. Los componentes de terceros **no** están
cubiertos por la licencia personalizada de Offlined: conservan sus propias
licencias, que deben respetarse.

## Binarios ejecutados como procesos independientes (GPL — mera agregación)

| Componente | Versión | Licencia | Archivo |
|---|---|---|---|
| kiwix-serve (kiwix-tools) | 3.7.0 | GPL-3.0 | `LICENSE_kiwix-tools_kiwix-serve_GPL-3.0.txt` — fuente: `/kiwix/source/` y `/kiwix/KIWIX-SOURCE.txt` |
| Notepad++ (portable) | 8.8.5 | GPL-3.0 | `LICENSE_Notepad++_GPL-3.0.txt` — fuente incluida en su carpeta `Notepad++ Source/` |
| libpst / readpst (importación de correo `.pst`) | — | GPL-2.0-or-later | `LICENSE_libpst_GPL-2.0.txt` — se invoca como proceso externo (mera agregación). Binario opcional en `/bin/`; incluir este aviso y la fuente solo si se distribuye el ejecutable |

Estos programas se distribuyen junto a Offlined pero se ejecutan como
procesos separados. Cualquiera puede usarlos, modificarlos y
redistribuirlos bajo los términos de su propia licencia GPL.

## Backend (Python)

| Componente | Licencia | Archivo |
|---|---|---|
| FastAPI | MIT | `LICENSE_FastAPI_MIT.txt` |
| Starlette | BSD-3-Clause | `LICENSE_Starlette_BSD-3-Clause.md` |
| Uvicorn | BSD-3-Clause | `LICENSE_Uvicorn_BSD-3-Clause.md` |
| pydantic | MIT | `LICENSE_pydantic_MIT.txt` |
| llama-cpp-python | MIT | `LICENSE_llama-cpp-python_MIT.md` |
| llama.cpp | MIT | `LICENSE_llama.cpp_MIT.txt` |
| stable-diffusion-cpp-python | MIT | `LICENSE_stable-diffusion-cpp-python_MIT.txt` |
| stable-diffusion.cpp | MIT | `LICENSE_stable-diffusion.cpp_MIT.txt` |
| snac | MIT | `LICENSE_snac_MIT.txt` |
| PyTorch (torch, CPU) | BSD-3-Clause | `LICENSE_PyTorch_BSD-3-Clause.txt` |
| psutil | BSD-3-Clause | `LICENSE_psutil_BSD-3-Clause.txt` |
| Requests | Apache-2.0 | `LICENSE-2.0_Requests_Apache-2.0.txt` |
| HTTPX | BSD-3-Clause | `LICENSE_HTTPX_BSD-3-Clause.md` |
| pywebview | BSD-3-Clause | `LICENSE_pywebview_BSD-3-Clause.txt` |
| python-multipart | Apache-2.0 | `LICENSE_python-multipart_Apache-2.0.txt` |
| pystray | LGPL-3.0 | `LICENSE_pystray_LGPL-3.0.txt` — librería sin modificar; ver nota LGPL abajo |
| Pillow | MIT-CMU (HPND) | `LICENSE_Pillow_MIT-CMU.txt` |
| mapbox-vector-tile (genera tiles MVT de las cartas náuticas) | MIT | `LICENSE_mapbox-vector-tile_MIT.txt` |
| protobuf (dep. de mapbox-vector-tile) | BSD-3-Clause | `LICENSE_protobuf_BSD-3-Clause.txt` |
| pyclipper (dep. de mapbox-vector-tile) | MIT | `LICENSE_pyclipper_MIT.txt` — el binding es MIT; incrusta Clipper (Angus Johnson) bajo Boost-1.0 |
| Shapely (dep. de mapbox-vector-tile) | BSD-3-Clause | `LICENSE_Shapely_BSD-3-Clause.txt` — empaqueta GEOS; ver nota LGPL abajo |
| GEOS (librería C empaquetada por Shapely) | LGPL-2.1 | `LICENSE_GEOS_LGPL-2.1.txt` — ver nota LGPL abajo |

**Nota LGPL (pystray, GEOS):** se usan sin modificaciones como librerías
importadas dinámicamente. La LGPL no afecta a la licencia de Offlined,
pero exige incluir su texto (hecho) y no impedir que el usuario sustituya
la librería. GEOS viene incrustada dentro de los wheels de Shapely
(`geos_c-*.dll`) y se usa para generar los tiles MVT de las cartas náuticas
(sección Mares y Océanos, endpoint `/api/maps/seamarks/tiles`).

## Frontend (vendor)

| Componente | Licencia | Archivo |
|---|---|---|
| Excalidraw | MIT | `LICENSE_Excalidraw_MIT.txt` |
| React / ReactDOM | MIT | `LICENSE_React_MIT.txt` |
| FullCalendar (core, daygrid, timegrid, list, multimonth, interaction — solo paquetes gratuitos) | MIT | `LICENSE_FullCalendar_MIT.txt` |
| KaTeX | MIT | `LICENSE_katex.txt` |
| Marked | MIT | `LICENSE_Marked_MIT.txt` |
| Quill | BSD-3-Clause | `LICENSE_Quill_BSD-3-Clause.txt` |
| Univer | Apache-2.0 | `LICENSE_Univer_Apache-2.0.txt` |
| Dropzone | MIT | `LICENSE_Dropzone_MIT.txt` |
| Celestial | BSD-2-Clause | `LICENSE_Celestial_BSD-2-Clause.txt` |
| D3 | ISC | `LICENSE_D3_ISC.txt` |
| Chart.js 4.4.4 (+ @kurkle/color, gráficas del gestor de presupuesto) | MIT | `LICENSE_Chart.js_MIT.txt` |
| Lucide (iconos, lucide-static 1.18.0) | ISC | `LICENSE_Lucide_ISC.txt` |
| epub.js + JSZip (reader) | MIT | `LICENSE_epub-js_JSZip_MIT.txt` |
| pdf.js | Apache-2.0 | `LICENSE_pdf.js_Apache-2.0.txt` |
| MapLibre GL JS | BSD-3-Clause | `LICENSE_MapLibre GL JS_BSD-3-Clause.txt` |
| PMTiles | BSD-3-Clause | `LICENSE_PMTiles (JSCLI)_BSD-3-Clause.txt` |
| Protomaps Basemaps (código) | BSD-3-Clause | `LICENSE_Protomaps Basemaps (código)_BSD-3-Clause.md` |
| Tangrams icons | MIT | `LICENSE_MIT_Tangrams_Icons.txt` / `LICENSE_tangramsicons_MIT.md` |

## Modelos de IA distribuidos

| Modelo | Licencia | Archivo / Nota |
|---|---|---|
| Qwen2.5-VL-7B-Instruct (GGUF) | Apache-2.0 | `LICENSE_Qwen2.5-VL_Apache-2.0.txt` — comercial OK |
| OmniVoice (voz) | Apache-2.0 | `LICENSE_OmniVoice_Apache-2.0.txt` — si deriva de Llama 3.2 (Orpheus), añadir aviso "Built with Llama" antes de distribución comercial |
| Phi-4-mini-instruct (Microsoft) | MIT | `LICENSE_Phi-4-mini-instruct (Microsoft)_MIT.txt` — comercial OK |

## Datos y contenidos

| Contenido | Licencia | Archivo / Nota |
|---|---|---|
| Wikipedia (ZIM vía Kiwix) | CC BY-SA 4.0 | `LICENSE_Contenido de Wikipedia_CC BY-SA 4.0_legalcode.txt` — atribución visible en la UI (ver `ATTRIBUTION.md`). Comercial OK |
| Otros ZIMs (wikiHow, iFixit, Khan Academy, TED, Gutenberg…) | CC BY-NC-* / marca PG | ⚠️ **NO precargar en distribución comercial** — solo canal gratuito. Verificar cada ZIM antes de añadirlo |
| OpenStreetMap (datos de mapas, planet.pmtiles) | ODbL 1.0 | `LICENSE_OpenStreetMap data_odbl-10.txt` — atribución "© OpenStreetMap contributors". Comercial OK sin modificar los datos |
| OpenSeaMap (cartas náuticas / seamarks, sección Mares y Océanos) | ODbL 1.0 | datos integrados en OSM; usar `LICENSE_OpenStreetMap data_odbl-10.txt`. Atribución "© OpenSeaMap contributors" (ver `ATTRIBUTION.md`). Comercial OK sin modificar los datos |
| Fuentes tipográficas (glyphs PBF) | OFL 1.1 | `LICENSE_SIL Open Font License 1.1_OFL.txt` |
| GeoNames (listado de ciudades, `frontend/geo/cities.json`) | CC BY 4.0 | `LICENSE_DATA_GeoNames_CC-BY-4.0.txt` — atribución en `ATTRIBUTION.md`. Comercial OK |
| Manuales militares EE.UU. (docs/) | Dominio público (obras del gobierno de EE.UU.) | Comercial OK |
| Libros Project Gutenberg (docs/) | Dominio público; marca "Project Gutenberg" sujeta a sus términos | Distribución gratuita: OK. **Uso comercial: eliminar antes cabeceras/referencias a Project Gutenberg** (también en nombres de carpetas) |

## Licencia propia

| Documento | Archivo |
|---|---|
| EULA de Offlined (usuario final) | `LICENSE_Offlined_EULA.txt` / `/LICENSE` |
| Licencia del repositorio (GitHub) | `/LICENSE.md` |
