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
<h2 align="center">
We depend on the network and rely on the cloud more than we think.<br><br>OFFLINED is what happens when you stop depending on it.<br><br>
</h2>

Concerned about the privacy of digital files, dependence on the cloud, and internet access difficulties in many places, Álvaro and Eric, inspired by the advances in artificial intelligence, decided to create Offlined: an alternative that allows storing and managing information without relying on a constant connection, while also offering study support through AI tools accessible even in environments with limited connectivity.

**"we created this for the two of us, we wanted to get off the cloud and share files the way we used to when we were kids, but as we kept going, we realized it could be useful for so many other people, and that is the reason we decided to release it for everyone."**
<br>
<p align="center">
  <a href="https://github.com/Aruvaro-Chulvi/Offlined/releases/latest">
    <img alt="release latest" src="https://img.shields.io/github/v/release/Aruvaro-Chulvi/Offlined?style=flat&color=34A853&label=latest%20release&labelColor=1a1a1a&v=3">
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

<br>

<p align="center">
  <img src="readme_images/computer_github.png"
     alt="Screenshot UI"
     style="width:98%; max-width:960px; border-radius:50px; height:auto; display:block; margin:0.6rem auto;" />
</p>

### 🔹 OFFLINED V4.0 (EN, ES, FR, PT, DE, IT, ZH, HI, AR, RU)

After first download, all components operate locally, without cloud services, telemetry, analytics, or external network calls.

---

# 📑 Index

- [✅ Requirements](#-requirements)
- [🌍 Who is it for?](#-who-is-offlined-for)
- [🙋 FAQ](#-faq)
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
- **WE RECOMMEND A EXTERNAL SSD DRIVE AS BIG AS YOU WANT, USB 3.2 HIGH SPEED.**
<br><br>

---

## 🌍 Who is OFFLINED for?

**OFFLINED** is designed for individuals and organizations that require reliable access to knowledge and tools without depending on continuous internet connectivity, including:

- **People from Preparedness and outdoor communities** seeking dependable offline information and tools.
- **Students at Schools, libraries, and educational programs** in low-connectivity or high-cost connectivity regions.
- **Researchers, archivists, and educators** who value self-hosted, long-term access to reference material.
- **Privacy-conscious users** who prefer fully local computation, storage, and control over their data.

While these groups represent the core use cases today, OFFLINED is also relevant to anyone who values **resilient access to knowledge**, **digital autonomy**, and **offline-first workflows** in an increasingly cloud-dependent world.

<br><br>

---

## 🙋 FAQ

### Q1. Do I need an internet connection to use OFFLINED?
No. All core components run locally, including the LLM, knowledge agents, maps, Wikipedia, and your document library.  
An internet connection is only required initially to download models, Wikipedia ZIM files, or map data (PMTiles).

---

### Q2. Can I use OFFLINED in portable mode (no installation)?
Yes. OFFLINED is fully portable.  
Simply launch the `.exe` file — the application can run from a local folder, an external drive, or a USB stick.

---

### Q3. Do my data ever leave my computer, external drive, or USB stick?
No. OFFLINED does not transmit user data externally.  
There is no cloud backend, telemetry, analytics, or third-party API usage.  
All processing and storage occur locally on your device.

---

### Q4. Does OFFLINED send my chats to Microsoft, Google, OpenAI, or any other company?
No.  
All inference and data handling occur locally. Conversations are not transmitted to external services.

---

### Q5. How much disk space does OFFLINED require?
Disk usage depends on the components you choose to install:

- Base application → ~200–250 MB  
- One GGUF model → ~12 GB  
- Wikipedia Maxi ZIM files (language-dependent) → ~40–120 GB  
- Global maps (`planet.pmtiles`) → ~120 GB  
- Personal documents and media → user-defined  

You control the size of your offline environment.

---

### Q6. Does the app use CPU resources when idle?
When the language model is not actively processing a request, CPU usage is minimal.  
Resource usage increases only during active inference or media processing.

---

### Q7. How much RAM does OFFLINED need?
The default model, **Phi-4 Mini (Q4_K_M)**, typically runs smoothly with **4–6 GB of available RAM**.  
Larger or higher-precision GGUF models benefit from additional memory.  
The application itself is lightweight; memory demand is driven primarily by the selected model.

---

### Q8. Is offline Wikipedia required?
No. Wikipedia support is optional, but recommended.  
Any supported ZIM dataset (*maxi*, *nopic*, or *mini*) can be placed under:  
`./Offlined/_internal/kiwix/content/`  
To reduce disk usage, starting with the *mini* version is advised.

---

### Q9. Does OFFLINED work on Linux or macOS?
Windows x64 is the primary supported platform today.  
macOS and Linux support are planned and tracked in the project roadmap.

---

### Q10. Can I use my own GGUF models?
Not yet.  
Support for a model manager that detects and allows selection of custom `.gguf` files from `_internal/models/` is planned for a future release.

---

### Q11. How do I add my own PDF documents?
Place your PDF files in:  
`./Offlined/_internal/docs/`  
You may organize them into any folder structure you prefer. Files will appear automatically in the Library view.

---

### Q12. How do I migrate my data to a new version?
User data is stored in:
- `/Offlined/_internal/docs`  
- `/Offlined/_internal/media`  

Copying these folders into a newer OFFLINED version will preserve your documents and media.

---

### Q13. What happens if I delete a file from the Library?
In version **3.0**, deletion is immediate and permanent, with no recovery mechanism.  
A recycle bin feature is planned for **Offlined v4.0** to allow recovery of accidentally deleted files.

<br><br>

---

# ⚖️ License & Usage Summary

**OFFLINED** is *source-available* software and is **not open-source** under OSI definitions.  
This licensing model is intentional: it provides transparency and user trust while preserving safety, coherence, and long-term sustainability.

- **Software (code):**  
  Free to use for **personal and educational purposes**.  
  **Commercial use, modification, or redistribution** require **prior written permission** from the authors.  
  See [`LICENSE.md`](./LICENSE.md) for full terms.

- **Assets (avatars, agent texts, creative content):**  
  Licensed under **Creative Commons CC BY-NC-ND 4.0**.  
  Assets may be shared **unaltered**, with attribution.  
  **Commercial use and derivative works are not permitted**.  
  See [`LICENSE-ASSETS.md`](./LICENSE-ASSETS.md) for details.

For commercial licensing, partnerships, or redistribution rights, please contact the authors.


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
- ☕ Buy Me a Coffee: [offlined](https://buymeacoffee.com/offlined)
<br><br>

---


| Component            | License                                                                            |
|----------------------|------------------------------------------------------------------------------------|
| **Application code** | Custom source-available, non-commercial license (see [`LICENSE.md`](./LICENSE.md)) |
| **Avatars & bios**   | CC BY-NC-ND 4.0 (see [`LICENSE-ASSETS.md`](./LICENSE-ASSETS.md))                   |
| **Third-party code** | Licensed under their respective licenses (see `/licenses`)                         |

<br><br>

---

© 2026 Offlined Project — Created by Álvaro Cuadrado Chulvi & Eric Uguet.  
All rights reserved. Source-available for personal and educational use only.  
“Offlined” is a trademark of the Offlined Project.
