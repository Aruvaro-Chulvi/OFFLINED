# ATTRIBUTION

Este archivo reúne las atribuciones obligatorias para datos y contenidos usados en la app **Survival AI Stick for Preppers**.

## OpenStreetMap (mapas base)
© OpenStreetMap contributors — Datos bajo **ODbL 1.0**.  
Más información: https://www.openstreetmap.org/copyright  
Licencia ODbL 1.0 (texto legal): https://opendatacommons.org/licenses/odbl/

Si distribuyes **tiles** derivados (ej. PMTiles) debes mantener esta atribución visible en la interfaz del mapa (control de atribuciones o pie de página).

## OpenSeaMap (cartas náuticas — sección Mares y Océanos)
Las marcas de navegación (seamarks: boyas, balizas, faros…) provienen de **OpenSeaMap**, integradas en los datos de OpenStreetMap.  
© OpenSeaMap contributors — Datos bajo **ODbL 1.0**.  
Más información: https://www.openseamap.org  
Mantén la atribución "© OpenSeaMap contributors" visible cuando se muestre la capa náutica.

## Wikipedia (contenidos offline vía Kiwix)
El contenido reutilizado de Wikipedia está licenciado bajo **CC BY-SA 4.0**.  
Más información: https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use/es  
Licencia CC BY-SA 4.0 (legalcode): https://creativecommons.org/licenses/by-sa/4.0/legalcode

Atribuye el artículo y conserva la licencia (share-alike) cuando corresponda.

## Kiwix-serve (motor de servicio de contenidos offline)
`Offlined Data\Wikis\kiwix-serve.exe` está licenciado bajo **GPL v3**.  
Licencia incluida en: `licenses/LICENSE_kiwix-tools_kiwix-serve_GPL-3.0.txt`  
Código fuente disponible en: https://github.com/kiwix/kiwix-tools  
*(Ejecutable independiente — el copyleft GPL no se extiende al código propietario de la aplicación.)*

## Notepad++ (editor de texto portable)
Incluido en `Offlined Data\Office\portable_apps\` bajo **GPL v3**.  
Licencia incluida en: `licenses/LICENSE_Notepad++_GPL-3.0.txt`  
Código fuente disponible en: https://github.com/notepad-plus-plus/notepad-plus-plus  
*(Ejecutable independiente — el copyleft GPL no se extiende al código propietario de la aplicación.)*

## libpst / readpst (importación de correo .pst — Buzón de Correo)
La importación de archivos `.pst` (Outlook) usa la utilidad **readpst** de **libpst**, invocada como proceso externo.  
Licencia: **GPL-2.0-or-later**.  
Licencia incluida en: `licenses/LICENSE_libpst_GPL-2.0.txt`  
Código fuente disponible en: https://www.five-ten-sg.com/libpst/  
*(Ejecutable independiente — el copyleft GPL no se extiende al código propietario de la aplicación. El binario es opcional; si no está presente en `/bin/`, la app solo importa `.mbox`.)*

## FFmpeg (conversión de audio — Notas y Generador de voz)
`ffmpeg-win-x86_64-v7.1.exe`, incluido vía el paquete Python `imageio_ffmpeg`,
se usa para convertir grabaciones del navegador (WebM/Opus) a MP3/WAV.
Build 7.1-essentials de gyan.dev, compilado con `--enable-gpl --enable-version3`.
Licencia: **GPL v3**.
Licencia incluida en: `licenses/LICENSE_FFmpeg_GPL-3.0.txt`
Código fuente y detalles: `licenses/FFMPEG-SOURCE.txt`
*(Ejecutable independiente, invocado vía `subprocess.run` — el copyleft GPL no se extiende al código propietario de la aplicación.)*

## OmniVoice — dependencias de audio (soxr, libsndfile)
La generación de voz usa `python-soxr` y `libsndfile` (esta última empaquetada
dentro del wheel de `soundfile`) para remuestreo y lectura de audio.
Licencia: **LGPL-2.1** (ambas, sin modificar, importadas dinámicamente).
Licencia incluida en: `licenses/LICENSE_soxr_LGPL-2.1.txt`

## Protomaps Basemap / Assets (sprites, glyphs, estilos)
- Estilos de Protomaps Basemap: **CC0** (cortesía).  
- Sprites/iconos: MIT (tangrams/icons u otros packs incluidos).  
- Fuentes (glyphs PBF): **SIL Open Font License 1.1 (OFL)**.

Consulta documentación: https://docs.protomaps.com/ (sección basemaps & assets).

## Qwen2.5-VL (modelo de análisis de imagen)
Modelo de visión multimodal de **Alibaba Cloud / Qwen Team**, usado para análisis de imágenes,
documentos, diagramas y auto-etiquetado.  
Licencia: **Apache 2.0** (pesos del modelo bajo Qwen License Agreement).  
Licencia incluida en: `licenses/LICENSE_Qwen2.5-VL_Apache-2.0.txt`  
Cuantización GGUF por Unsloth: https://huggingface.co/unsloth/Qwen2.5-VL-7B-Instruct-GGUF  
Código fuente: https://github.com/QwenLM/Qwen2.5-VL

## llama-cpp-python (binding Python para llama.cpp)
Binding Python de llama.cpp usado para inferencia LLM y visión.  
Licencia: **MIT** — Copyright (c) 2023 Andrei Betlen.  
Licencia incluida en: `licenses/LICENSE_llama-cpp-python_MIT.txt`  
Código fuente: https://github.com/abetlen/llama-cpp-python

## OmniVoice / k2-fsa (síntesis de voz)
Motor TTS multiidioma (~600+ idiomas, 0.6B parámetros, 24 kHz) usado para la sección
**Generación de voz**, incluyendo síntesis estándar y clonación de voz.  
Licencia: **Apache 2.0** — Copyright (c) k2-fsa contributors.  
Licencia incluida en: `licenses/LICENSE_OmniVoice_Apache-2.0.txt`  
Modelo: https://huggingface.co/k2-fsa/OmniVoice  
Runtime: https://github.com/k2-fsa/sherpa-onnx

---

## Resumen de atribuciones a mostrar en la UI
- **Mapas**: “© OpenStreetMap contributors — ODbL 1.0”
- **Mares y Océanos**: “© OpenSeaMap contributors — ODbL 1.0”
- **Wikipedia (Kiwix)**: “Content from Wikipedia — CC BY-SA 4.0”

*(Puedes añadir enlaces clicables cuando la app esté en modo online; en modo offline basta con el texto visible.)*

## GeoNames (listado de ciudades para etiquetas de geolocalización)
El archivo `frontend/geo/cities.json` (ciudades del mundo con coordenadas) deriva de **GeoNames** — https://www.geonames.org  
Datos bajo **CC BY 4.0**: https://creativecommons.org/licenses/by/4.0/

Atribución: "Datos de ciudades © GeoNames (geonames.org), CC BY 4.0".
