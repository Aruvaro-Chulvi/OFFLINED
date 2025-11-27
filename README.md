<h1 align="center">
  <img src="https://blogger.googleusercontent.com/img/b/R29vZ2xl/AVvXsEi2tbaCGcT2-GCC072UzbCMHJy2ArV0ET7Lnl1fsYfTjvpWUTzlhFYyWwUXhz2fI-b-9LvgM-LhQMfthegRaD9-8C33Ac7E1gVu4tz-ucrRghPKASlT9hLbaUeFxJNo_dvIPsIida7o6ZmamHC-Dm8IcnuKmeEILWGeIwAF-WDCFVQdGyXrJBajS0efWEw/s1600/offlined_favicon_01.jpg"
       width="32"
       style="vertical-align:middle; margin-right:10px;">
  Offlined.org
</h1>
<br>
<p align="center">
  <img src="readme_images/creators_card.png"
     alt="Screenshot UI"
     style="width:max(98%, 400px); height:auto;" />
</p>
<br>
<p align="center">
  <a href="https://github.com/Aruvaro-Chulvi/Offlined/releases">
    <img alt="version" src="https://img.shields.io/badge/version-v1-4285F4?style=flat&labelColor=1a1a1a&v=2">
  </a>
  <a href="https://www.python.org/">
    <img alt="python" src="https://img.shields.io/badge/python-3.11%2B-FBBC05?style=flat&labelColor=1a1a1a&v=2">
  </a>
  <a href="https://github.com/Aruvaro-Chulvi/Offlined/releases/latest">
    <img alt="release latest" src="https://img.shields.io/github/v/release/Aruvaro-Chulvi/Offlined?style=flat&color=34A853&label=latest%20release&labelColor=1a1a1a&v=3">
  </a>
  <a href="https://github.com/Aruvaro-Chulvi/Offlined/stargazers">
    <img alt="stars" src="https://img.shields.io/github/stars/Aruvaro-Chulvi/Offlined?style=flat&color=34A853&labelColor=1a1a1a&v=2">
  </a>
  <br>
  <a href="https://github.com/Aruvaro-Chulvi/Offlined/issues">
    <img alt="issues" src="https://img.shields.io/github/issues/Aruvaro-Chulvi/Offlined?style=flat&color=4285F4&labelColor=1a1a1a&v=2">
  </a>
  <br>
  <a href="https://github.com/Aruvaro-Chulvi/Offlined/blob/main/LICENSE.md">
    <img alt="license" src="https://img.shields.io/badge/license-Custom%20Non--Commercial-DDDDDD?style=flat&labelColor=1a1a1a&v=2">
  </a>
</p>

### 🔹 Offlined (EN,ES,FR,PT)

**OFFLINED** is a fully self-contained, 100% offline desktop-style web application designed to give any user an autonomous digital ecosystem without relying on the internet. It allows you to chat with a local Large Language Model (Phi-4-mini-instruct-Q4_K_M-GGUF) or with specialized expert agents — including medical professionals, biologists, engineers, survival experts, and dozens of other domains — all running entirely on your own device.

But OFFLINED is much more than a chat interface. It integrates a complete knowledge and productivity environment: **offline Wikipedia, offline worldwide maps** with searching, favorites and markers, **a powerful taxonomic Wiki-Trees explorer, a full media center** (images, music, videos, documents), **file management with folders and drag-and-drop, notes, audio notes, calendar, whiteboard**, and a local documents library. Everything runs locally, without any cloud services, telemetry, analytics, or external network calls.

OFFLINED is built as a personal offline “operating system” for knowledge, survival, study, and independence. Whether you want a private AI assistant, a portable encyclopedia, a survival companion, or a resilient digital toolkit for emergencies — OFFLINED works anywhere, anytime, even in total isolation. The entire system is crafted to be lightweight, privacy-first, multilingual, and completely self-sufficient.

When the internet disappears, **your AI, your data, and your knowledge stay with you.**

<br>
<p align="center">
  <img src="readme_images/computer_github.png"
     alt="Screenshot UI"
     style="width:98%; max-width:960px; border-radius:50px; height:auto; display:block; margin:0.6rem auto;" />
</p>

### ✨ Features

- **100% offline**: runs locally with GGUF models via `llama-cpp-python` (no cloud, no telemetry).
- **Two chat modes**: **🤖 Model** — direct chat with the selected LLM. **👥 Agents** — visual agent picker (medical, engineering, etc.).
- **LLM answer selecting**: Select text in LLM answers for **wiki search feature**.
- **Offline Worldwide Map**: built-in tab that works with **Protomaps and pmtiles** + **OpenStreetMaps** files.
- **Offline Wikipedia**: built-in tab that works with **Kiwix** + **ZIM** files; can auto-start `kiwix-serve`.
- **Wiki-Trees**: for a friendly and better **"wikipedia exploration"**.
- **3 types of wikipedia available**: "maxi", "no-pic" & "mini".
- **Library Folders**: for **.pdf** files you want to store.
- **Multi-language UI**: EN / ES / FR / PT (including localized agent categories).
- **Clean UI/UX**: light/dark theme toggle. Battery, disk, cpu, ram and temp indicator bars.
 
> This portable zip file **does not ship any model or ZIM files or pmtiles files**. You’ll download them yourself (links and instructions provided below). 
<br>

<p align="center">
⚠️ The following instructions are intended for the windows x64 portable version provided below.<br>🔥 If you want to have a look, project files are included in the source code.<br>👥 This is our first github project, and all the help (and comprehension) would be appreciated.
</p>
<br>

---

# 📑 Index

- [✅ Requirements](#-requirements)
- [🌍 Who is it for?](#-who-is-it-for)
- [📝 Instructions](#-instructions)
- [🤖 Downloading the Model (Phi-4 Mini.GGUF)](#-downloading-the-model-phi-4-minigguf)
- [📖 Downloading Wikipedia ZIM files](#-downloading-wikipedia-zim-files)
- [📚 Adding more to your library (pdf files)](#-adding-more-to-your-library-pdf-files)
- [🌍 Downloading the planet.pmtiles file](#-downloading-the-planetpmtiles-file)
- [🙋 FAQ](#-faq)
- [🔮 Future Versions](#-future-versions)
  - [🧭 Roadmap](#-roadmap)
- [⚖️ License & Usage Summary](#%EF%B8%8F-license--usage-summary) 
- [🤝 Feedback & Support](#-feedback--support)
- [📜 Licenses](#-licenses)
- [❤️ Special thanks](#%EF%B8%8F-special-thanks)

<br>

---

# ✅ Requirements

This project is designed to run **fully offline** on a modest CPU-only machine. Below are the **technical requirements** for your workstation.

### Hardware (recommended)
- **CPU:** x86_64 with **AVX2** support (for good `llama-cpp-python` performance).
- **RAM:** 8 GB minimum (16 GB recommended for smoother multitasking or larger contexts).
- **Disk:** from 8 to 200 GB depending on the **GGUF** model(s) you keep plus **Wikipedia ZIM** files and **pmtiles** files.
- **GPU:** *Not required* (CPU-only).

### Operating Systems
- **Windows 10/11 x64**
- **macOS** (coming soon)
- **Linux** (coming soon)

### Storage
- **You can run it from a folder on your PC’s drive, from an external hard drive, or even from a USB stick.**
<br><br>

---

# 🌍 Who is it for?

**OFFLINED** is built for:
- **Preppers & outdoors** communities who need reliable tools without internet.
- **Schools & libraries** in low-connectivity regions, looking for offline knowledge.
- **NGOs & emergency response** teams operating in field conditions.
- **Researchers & archivists** who value self-hosted, offline-first workflows.
- **Privacy-conscious users** who prefer fully local processing and storage.

<br><br>

---

# 📝 Instructions

The following instructions are intended for the **Portable windows x64 version** you can find in our website **https://www.offlined.org** or in the following link: [Download Link](https://www.offlined.org)

## 📦 Project Structure for needed files
Download the project zip file and extract in root **C:/** or in the **folder** you prefer on your desktop.

```
/Offlined
├── Offlined.exe
│
├── _internal/
│  │
│  ├── backend/
│  │ ├── main.py
│  │ ├── requirements.txt
│  │
│  ├── docs/
│  │ ├── en/ organize English PDF Files as you like.
│  │ ├── es/ organize Spanish PDF Files as you like.
│  │ └── fr/ organize French PDF Files as you like.
│  │
│  │
│  ├── frontend/
│  │ ├── index.html
│  │ ├── style.css
│  │ ├── script.js
|  | └── assets/
|  |     └── maps/ # Put your .pmtiles files here (planet.pmtiles)
│  │
│  ├── models/ # Put your .gguf files here (e.g., phi-4-mini-instruct-q4_k_m.gguf)
│  │
│  ├── kiwix/
│  │ ├── kiwix-serve(.exe)
│  │ └── content/ # Put Wikipedia .zim files here (ES/EN/FR; maxi/nopic/mini)
│  │
│  ├── agents.json
│  ├── categories.json
│  ├── supporters.json
│  ├── README.md
│  └── LICENSE
```

<br><br>

---

# 🤖 Downloading the Model (Phi-4 Mini.GGUF)

**Licensing & responsibility**

- The file below is hosted by a third-party Hugging Face repo. You are responsible for ensuring the **license is compatible** with your intended use and for keeping any required **attributions**.

<p align="center">
Download page (for information):<br>https://huggingface.co/matrixportalx/Phi-4-mini-instruct-Q4_K_M-GGUF
<br><br>
Download model link (.GGUF file - 2,49 GB):<br>https://huggingface.co/matrixportalx/Phi-4-mini-instruct-Q4_K_M-GGUF/blob/main/phi-4-mini-instruct-q4_k_m.gguf
<br>
</p>

👉 **Do not rename** Place the GGUF file in: ``./Offlined/_internal/models/phi-4-mini-instruct-q4_k_m.gguf``.

<br><br>

---

# 📖 Downloading Wikipedia ZIM files

<p align="center">
  <img src="readme_images/screenshot_02.png"
     alt="Screenshot UI"
     style="width:98%; max-width:960px; border-radius:50px; height:auto; display:block; margin:0.6rem auto;" />
</p>

**Download page (browse & pick, choose this link if you want to see all available zim files and download selecting the preferred one, or use the below links):**  
https://download.kiwix.org/zim/wikipedia/

### 📄 Target filenames.
(filenames your backend expects; select the option you prefer)

**Zim File Types**.<br>
**Which file do I need to select? the one you prefer**😉.

- **all_maxi** — Full articles with images  
- **all_nopic** — Full articles without images  
- **all_mini** — First section only, no images


⚠️⚠️⚠️ Be careful before downloading large files to your computer. ⚠️⚠️⚠️

**EN (7.042.731 articles):**
  - [wikipedia_en_all_maxi_2025-08.zim](https://download.kiwix.org/zim/wikipedia/wikipedia_en_all_maxi_2025-08.zim) - (116 GB)
  - [wikipedia_en_all_nopic_2025-08.zim](https://download.kiwix.org/zim/wikipedia/wikipedia_en_all_nopic_2025-08.zim) - (43 GB)
  - [wikipedia_en_all_mini_2025-06.zim](https://download.kiwix.org/zim/wikipedia/wikipedia_en_all_mini_2025-06.zim) - (14 GB)

**ES (2.052.431 articles):**
  - [wikipedia_es_all_maxi_2025-07.zim](https://download.kiwix.org/zim/wikipedia/wikipedia_es_all_maxi_2025-07.zim) - (38 GB)
  - [wikipedia_es_all_nopic_2025-08.zim](https://download.kiwix.org/zim/wikipedia/wikipedia_es_all_nopic_2025-08.zim) - (9 GB)
  - [wikipedia_es_all_mini_2025-08.zim](https://download.kiwix.org/zim/wikipedia/wikipedia_es_all_mini_2025-08.zim) - (3 GB)

**FR (2.693.000 articles):**
  - [wikipedia_fr_all_maxi_2025-06.zim](https://download.kiwix.org/zim/wikipedia/wikipedia_fr_all_maxi_2025-06.zim) - (54 GB)
  - [wikipedia_fr_all_nopic_2025-08.zim](https://download.kiwix.org/zim/wikipedia/wikipedia_fr_all_nopic_2025-08.zim) - (11 GB)
  - [wikipedia_fr_all_mini_2025-08.zim](https://download.kiwix.org/zim/wikipedia/wikipedia_fr_all_mini_2025-08.zim) - (4 GB)

👉 **Do not rename** the files after download. Put them under: `./Offlined/_internal/kiwix/content/file_name.zim`

<br><br>

---

# 📚 Downloading the library (pdf files)

**Download zip file:**  
https://www.offlined.org
<br>
👉 **Extract docs folder** and place it here: ``./Offlined/_internal/extract here``.

**Adding more files to your library:**  
**Our Recommendation - Project Gutenberg Resource:** is a volunteer-driven digital library that offers over 70,000 free eBooks, including many classics of world literature. All the books are in the public domain, which means they can be freely read, downloaded, and shared without cost. It is one of the oldest and largest online collections of free books, created to make cultural works accessible to everyone, everywhere.
https://www.gutenberg.org/

Remember to transform to .pdf files till more formats available. <br>
👉 Place your **.pdf** files in:<br> `./Offlined/_internal/docs/` and the folders you want inside <br> **Organize as you wish 🤪**.<br><br>

<p align="center">
  <img src="readme_images/screenshot_library.png"
     alt="Screenshot UI"
     style="width:98%; max-width:960px; border-radius:50px; height:auto; display:block; margin:0.6rem auto;" />
</p>

**You can also add your own audio and video files to the library on the "music" and "video" folders.** 



👉 Place your **.mp3**, **.avi**, **.mp4** files in: `./Offlined/_internal/media/` and use the **music** folder for your audio files and the **video** folder for video files. <br> **Organize as you wish 🤪**.<br><br>
<br><br>

---

# 🌍 Downloading the planet.pmtiles file

**Worldwide Maps**

- Download instructions.

<p align="center">
  <img src="readme_images/screenshot_03.png"
     alt="Screenshot UI"
     style="width:98%; max-width:960px; border-radius:50px; height:auto; display:block; margin:0.6rem auto;" />
</p>

**Download page:**  
https://maps.protomaps.com/builds/

⚠️⚠️⚠️ Be careful before downloading large files to your computer. ⚠️⚠️⚠️

[**Download planet.pmtiles full layer link (.pmtiles file - 120 GB):**](https://demo-bucket.protomaps.com/v4.pmtiles)  

👉 Rename and place **planet.pmtiles** file in: `./Offlined/_internal/frontend/assets/maps/planet.pmtiles` **Rename it** to planet.pmtiles, no matter which version you choose, rename always to **planet.pmtiles**.

### 🔐 Local privacy & security
- `kiwix-serve` is launched **bound to `127.0.0.1`** (localhost) only.  
- The app does **not** make external network requests after installation.  
- You can air-gap the device; OFFLINED continues to work fully offline.



<br><br>

---


# 🙋 FAQ

**Q1. Do I need internet to use this?**  
No. Everything runs locally (LLM, agents, maps, Wikipedia, and your PDF library). You only need internet to download models/ZIM/pmtiles the first time.

**Q2. Can I use Offlined in portable mode (no installation)?**  
Yes.  
Simply double-click the `.exe` and the app launches.  
Offlined is fully portable and can run from a folder, external drive, or USB stick.

**Q3. Do my data ever leave my computer, external drive, or USB stick?**  
No. Nothing leaves your devices.  
There is no cloud, no telemetry, no analytics, and no external API calls.  
Everything (AI, Wikipedia, maps, notes, audio, documents) runs 100% offline and locally.

**Q4. Does Offlined send my chats to Microsoft, Google, OpenAI, or any other company?**  
Never.  
All processing happens locally on your machine.  
Your conversations are **never transmitted anywhere**.

**Q5. How much disk space does Offlined require?**  
It depends on what you install:

- Base app → ~200–250 MB  
- One GGUF model → ~3 GB  
- Wikipedia Maxi ZIM (varies by country) → **40–120 GB**  
- Global Maps (planet.pmtiles) → **~120 GB**  
- Your documents/media → unlimited  

You decide the size of your offline ecosystem.

**Q6. Does the app use CPU when I’m not chatting?**  
No.  
When the LLM is not processing a message, it goes completely idle.  
Offlined uses almost **0% CPU** while inactive.

**Q7. How much RAM does Offlined need?**  
The current default model, **Phi-4 Mini (Q4_K_M)**, runs smoothly with **4–6 GB of RAM**.  
Heavier GGUF models benefit from more RAM.  
The app itself is lightweight; only the LLM is demanding.

**Q8. Is Wikipedia required?**  
No. It’s optional, but highly recommended. Place any ZIM flavor (maxi/nopic/mini) under `./Offlined/_internal/kiwix/content/`. 
Tip: start with mini to save disk space.

**Q9. Does it work on Linux or macOS?**  
Windows x64 is the target today. macOS and Linux are planned (see Roadmap).

**Q10. Can I use my own GGUF models?**  
“Not yet. This is on the roadmap; we plan to support a Model Manager that detects .gguf files in _internal/models/ and lets you select one from the UI.

**Q11. How do I add my own PDFs?**  
Drop them into `./Offlined/_internal/docs/` (any subfolders you prefer). They’ll appear in the Library tab.

**Q12. How do I migrate my data to a new version?**  
Your personal data is stored in:
`/Offlined/_internal/doc` & `/Offlined/_internal/media`
Simply replace these folders inside the new version and all your files will migrate instantly.

**Q13. What happens if I delete a file from the Library?**  
Deletion is immediate in version **3.0** — there is **no recycle bin** or recovery mechanism.  
A recycle bin will be introduced in **Offlined v4.0** for restoring accidentally deleted files.

<br><br>

---

# 🔮 Future Versions

## 🧭 Roadmap

- [x] v1 — 💬 Chat Core - Base app (LLM Chat UI)  
- [x] v2 — 🏛️ Wikipedia integration + Text selection search  
- [x] v3 — 🗺️ Documentation & Offline Maps integration & Wiki-trees  
- [ ] v4 — ✨🔭 Sky + 🌍 Global Search  
- [ ] v5 — 🧰 Agent Kit + 📚🔎 RAG (per-agent offline documentation)  
- [ ] v6 — 💻📦 Third-party open source apps (LibreOffice, GIMP, VLC, Audacity…)  
- [ ] v7 — 🌐🚫 No-Internet OS (🐧 Linux-based, app as desktop)  
- [ ] v8 — 🌎📚 Offlined OS Editions (Survival / Education / Rural)

---

The journey of **Offlined.org** has gone through several stages of evolution.  
Early versions focused on building the foundation — the chat interface, model integration, and the first offline tools. The roadmap ahead remains ambitious and full of new features:

- **Version 1 — 💬 Chat Core**  
  First public prototype with a functional chat interface and basic LLM integration.  
  Established the foundation for offline AI communication.

- **Version 2 — 🏛️ Wikipedia Integration**  
  Added offline Wikipedia search through text selection inside chat responses, allowing users to consult articles seamlessly from model outputs.

- **Version 3 — 🗺️ Documentation & Maps & Wiki-trees**  
  Introduced the **offline documentation viewer** and integrated **MapLibre + PMTiles** maps. Added **"Wiki-trees"** feature for wiki exploration.  
  
  From this point, the combined system became known as  
  **“v3 — Base app (LLM, Agents, Wikipedia, Maps, Docs)”**.

---

- **Version 4 — ✨🔭 Sky & 🌍 Global Search**  
  Stellarium will be fully integrated offline, bringing an interactive sky map, constellations, and celestial objects into the app — turning OFFLINED into a pocket planetarium that works without internet.  
  Additionally, a new **Global Search** system will allow you to instantly find anything across all modules — **agents, Wikipedia articles, Wikipedia trees, local documents, and stellar objects** — unifying the entire offline knowledge base into a single, intelligent search bar.

- **Version 5 — 🪪🧰Agent Kit & 📚🔎RAG**  
  Each agent will receive a dedicated **Agent Kit**: predefined prompts to boost its usefulness in survival scenarios.  
  In addition, agents will gain the surprising ability to perform **RAG (Retrieval-Augmented Generation)** on curated offline documentation and available "Wiki-trees". Every profession-linked agent will be able to consult specific PDFs and manuals relevant to their expertise, giving more grounded and specialized guidance.

- **Version 6 — 💻📦Third-party Open Source Software**  
  We will bundle a selection of essential offline open source software: 📄LibreOffice, 🎨GIMP, 🎥VLC, 🎧Audacity, and 🛠️more.  
  The aim is to make OFFLINED not only a survival assistant but also a complete offline productivity and creativity hub.

- **Version 7 — 🌐🚫No-Internet OS (Dream Edition)**  
  With enough community support, we dream of building a **🐧Linux-based “No Internet OS”**.  
  It would boot into our app as its main desktop environment but allow users to install all tools from V6 (LibreOffice, Audacity, GIMP, etc.).  
  This would transform the project into a full-fledged offline operating system for survival, creativity, and autonomy.

- **Version 8 — 🌎📚 Offlined OS Editions (For Survival, Education & Rural Zones)**  
  Once the No-Internet OS is stable, we plan to create **three specialized editions** of the system:  
  - **🏕️ Offlined OS — For Survival:** focused on emergency preparedness, self-reliance, medical knowledge, field engineering and offline survival manuals.  
  - **🎓 Offlined OS — For Education:** designed for schools and students in areas with poor connectivity, including educational agents, encyclopedias and open textbooks.  
  - **🏡 Offlined OS — For Rural Zones:** optimized for low-power hardware and communities with limited or no internet access, offering tools for agriculture, local communication and energy management.  

  Each edition will adapt the agents, documentation and available software to its purpose, creating self-sufficient digital ecosystems that work **completely offline**.

  LLM's are expected to get faster and more reliable with time, and we're hoping this will have a positive impact in the tool. 

<br><br>

---
#  ⚖️ License & Usage Summary

**OFFLINED** is *source-available* software — it is **not open-source** under OSI definitions.

- **Software (code):** Free to use for **personal and educational** purposes.  
  **Commercial use, modification, or redistribution** are **not permitted** without **prior written permission**.  
  Source code is provided for **transparency and personal study** only. See [`LICENSE.md`](./LICENSE.md).

- **Assets (avatars, agent texts, creative content):** Licensed under **CC BY-NC-ND 4.0**.  
  You may share the assets **unaltered** with credit; **no commercial use or derivatives**. See [`LICENSE-ASSETS.md`](./LICENSE-ASSETS.md).

For commercial or redistribution licensing, please contact the authors.

<br><br>

---
# 🤝 Feedback & Support

We welcome **issues** for bug reports, ideas, and translations (EN/ES/FR).  
Because OFFLINED is **source-available and non-commercial**, **pull requests are not accepted** unless you obtain **written approval** from the maintainers **before** submitting.

- Open an [Issue](../../issues) to:
  - Report a bug (include steps, logs, and OS).
  - Suggest a feature or UI copy improvement.
  - Propose translation fixes (EN/ES/FR).
- If you wish to contribute code, please **contact the maintainers first** for written approval.

### Sustainability
If you find OFFLINED valuable:
- ☕ Buy Me a Coffee: **offlined**  
- 💳 PayPal (donations): add your link in `FUNDING.yml` → `custom: ['https://…']`  
- 🟣 Ko-fi (optional): add your handle

> Note: Platforms like **GitHub Sponsors** or **OpenCollective** generally require OSI-approved open-source licenses, which OFFLINED does not use.

<br><br>

---

# 📜 Licenses

| Component         | License                                                                 |
|-------------------|-------------------------------------------------------------------------|
| **Code**          | Custom non-commercial license (see [`LICENSE.md`](./LICENSE.md))        |
| **Avatars & bios**| CC BY-NC-ND 4.0 (see [`LICENSE-ASSETS.md`](./LICENSE-ASSETS.md))        |
| **3rd party**     | Licensed inside folder (/licenses)                                      |

<br><br>

---

# ❤️ Special thanks

**Thanks to all the developers behind these projects for making this possible. I would never have thought, until I met you, that the project I had in mind could be so easy thanks to you.**

<p align="center">
  <img src="readme_images/thanks.png"
     alt="Screenshot UI"
     style="width:98%; max-width:960px; border-radius:50px; height:auto; display:block; margin:0.6rem auto;" />
</p>

<br><br>

---

© 2025 Offlined Project — Created by Álvaro Cuadrado Chulvi & Eric Uguet.
All rights reserved. Source-available for personal and educational use only.
“Offlined” is a trademark of the Offlined Project.
