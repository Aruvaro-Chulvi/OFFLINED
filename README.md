# 🛠️ Offline Survival AI Drive
### 🔹 Offline LLM & Agents & Wikipedia & Maps & Documents (EN,ES,FR)

**Survival AI** is a 100% **offline** desktop-style web app to chat with a **local LLM (GGUF)** or with **expert agents** (medical, biology, engineering, etc.). It also integrates **offline Wikipedia** via **Kiwix**—no internet required. Offline Maps and Survival Documentation.

- AI model (Miscrosoft): **Phi-3 Mini 4K Instruct (Q4_K_M)**
- Maps: **Protomaps OpenStreetMaps** (planet.pmtiles)  
- Wikipedia: **kiwix-serve** with local **ZIM** files 

### ✨ Features

- **100% offline**: runs locally with GGUF models via `llama-cpp-python` (no cloud, no telemetry).
- **Two chat modes**: **Model** — direct chat with the selected LLM. **Agents** — visual agent picker (medical, engineering, etc.).
- **Offline Wikipedia**: built-in tab that works with **Kiwix** + **ZIM** files; can auto-start `kiwix-serve`.
- **3 types of wikipedia available**: "maxi", "no-pic" & "mini".
- **Multi-language UI**: EN / ES / FR (including localized agent categories).
- **Clean UI/UX**: light/dark theme toggle, battery indicator bar.
 
> This repository **does not ship any model or ZIM files or pmtiles files**. You’ll download them yourself (links and instructions provided below).

---

## ✅ Requirements

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

---

## 📦 Project Structure
Download the project zip file and extract in root **C:/**

```
/SurvivalAI-phi4
│
├── backend/
│ ├── main.py
│ ├── requirements.txt
│
├── frontend/
│ ├── index.html
│ ├── style.css
│ └── script.js
│
├── models/ # Put your .gguf files here (e.g., Phi-3-mini-4k-instruct.Q4_K_M.gguf)
│
├── kiwix/
│ ├── kiwix-serve(.exe)
│ └── content/ # Put Wikipedia .zim files here (ES/EN/FR; maxi/nopic/mini)
│
├── agents.json
├── categories.json
├── README.md
└── LICENSE
```


---

## 🤖 Downloading the Model (Phi-4 Mini Instruct Q4_K_M, GGUF)

**Licensing & responsibility**

- Always **read and comply** with the model card/license on the download page before using the model (including any **commercial-use** restrictions).
- The file below is hosted by a third-party Hugging Face repo. You are responsible for ensuring the **license is compatible** with your intended use and for keeping any required **attributions**.
- If the file name changes on Hugging Face, simply **update the commands** below and your `MODEL_FILE` in `backend/main.py`.

**Download page:**  
https://huggingface.co/matrixportalx/Phi-4-mini-instruct-Q4_K_M-GGUF

> Place the GGUF file in: `./models/` (do **not** rename unless you also update `MODEL_FILE` in the backend and `MODELS` in the frontend).

---

## 📖 Downloading Wikipedia ZIM files for Kiwix

Your app looks for **exact filenames** and picks the first available in this priority: **maxi → nopic → mini**.  
👉 **Do not rename** the files after download. Put them under: `./kiwix/content/`

**Download page (browse & pick):**  
https://download.kiwix.org/zim/wikipedia/

### Target filenames (candidates your backend expects)

**Zim File Types**.

all_maxi --> **All articles - Full Articles with Images**.

all_nopic --> **All articles - Full Articles without Images**.

all_mini --> **All articles - First section Articles without Images**. 


**EN:**
  - wikipedia_en_all_maxi_2025-08.zim - (116 GB) (https://download.kiwix.org/zim/wikipedia/wikipedia_en_all_maxi_2025-08.zim)
  - wikipedia_en_all_nopic_2025-08.zim - (43 GB) (https://download.kiwix.org/zim/wikipedia/wikipedia_en_all_nopic_2025-08.zim)
  - wikipedia_en_all_mini_2025-06.zim - (14 GB) (https://download.kiwix.org/zim/wikipedia/wikipedia_en_all_mini_2025-06.zim)

**ES (2.052.431 articles):**
  - wikipedia_es_all_maxi_2025-07.zim - (38 GB) (https://download.kiwix.org/zim/wikipedia/wikipedia_es_all_maxi_2025-07.zim)
  - wikipedia_es_all_nopic_2025-08.zim - (9 GB) (https://download.kiwix.org/zim/wikipedia/wikipedia_es_all_nopic_2025-08.zim)
  - wikipedia_es_all_mini_2025-08.zim - (3 GB) (https://download.kiwix.org/zim/wikipedia/wikipedia_es_all_mini_2025-08.zim)

**FR:**
  - wikipedia_fr_all_maxi_2025-06.zim - (54 GB) (https://download.kiwix.org/zim/wikipedia/wikipedia_fr_all_maxi_2025-06.zim)
  - wikipedia_fr_all_nopic_2025-08.zim - (11 GB) (https://download.kiwix.org/zim/wikipedia/wikipedia_fr_all_nopic_2025-08.zim)
  - wikipedia_fr_all_mini_2025-08.zim - (4 GB) (https://download.kiwix.org/zim/wikipedia/wikipedia_fr_all_mini_2025-08.zim)


---

## 🌍 Downloading the Worldwide Map (planet.pmtiles)

**Licensing & responsibility**

- Always **read and comply** with the model card/license on the download page before using the model (including any **commercial-use** restrictions).
- The file below is hosted by a third-party Hugging Face repo. You are responsible for ensuring the **license is compatible** with your intended use and for keeping any required **attributions**.
- If the file name changes on Hugging Face, simply **update the commands** below and your `MODEL_FILE` in `backend/main.py`.

**Download page:**  
https://maps.protomaps.com/builds/

> Place the PMTILES file in: `./XXXXXX/` (**Rename it** to planet.pmtiles).

---


