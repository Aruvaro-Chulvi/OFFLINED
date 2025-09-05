# 🧩 Offline Survival AI Stick for Preppers
### 🔹 Offline LLM · Expert Agents · Offline Wikipedia (Kiwix)

**Survival AI** is a 100% **offline** desktop-style web app to chat with a **local LLM (GGUF)** or with **expert agents** (medical, biology, engineering, etc.). It also integrates **offline Wikipedia** via **Kiwix**—no cloud required.

- Backend: **FastAPI + llama-cpp-python**  
- Frontend: static SPA (HTML/CSS/JS)  
- Wikipedia: **kiwix-serve** with local **ZIM** files  
- Default model recommendation: **Phi-3 Mini 4K Instruct (Q4_K_M)**

> This repository **does not ship any model or ZIM files**. You’ll download them yourself (scripts provided below).

---

## ✨ Features

- **100% offline**: runs locally with GGUF models via `llama-cpp-python` (no cloud, no telemetry).
- **Two chat modes**:
  - **Model** — direct chat with the selected LLM.
  - **Agents** — visual agent picker (medical, engineering, etc.) with cards and suggested cross-referrals.
- **Offline Wikipedia**: built-in tab that works with **Kiwix** + **ZIM** files; can auto-start `kiwix-serve`.
- **3 types of wikipedia available**: "maxi", "no-pic" & "mini".
- **Multi-language UI**: EN / ES / FR (including localized agent categories).
- **Clean UI/UX**: light/dark theme toggle, battery indicator bar.
- **Simple setup**: copy-paste scripts for Windows (PowerShell) and macOS/Linux (Bash).
- **Cross-platform**: Windows, macOS, and Linux; CPU-only with configurable threads.
 
- Fully **offline** after initial downloads

---

## 🖥️ Modes

- **Model**: direct chat with the selected LLM.
- **Agents**: pick an expert (avatar + short profile) and chat.
- **Wikipedia**: browse/search **offline Wikipedia** via Kiwix + ZIM.

---

## ✅ Requirements

This project is designed to run **fully offline** on a modest CPU-only machine. Below are the **technical requirements** for your workstation and the **Python dependencies** (from `requirements.txt`) with install commands.

### Hardware (recommended)
- **CPU:** x86_64 with **AVX2** support (for good `llama-cpp-python` performance).
- **RAM:** 8 GB minimum (16 GB recommended for smoother multitasking or larger contexts).
- **Disk:** ~16 to 200 GB depending on the **GGUF** model(s) you keep plus **Wikipedia ZIM** files.
- **GPU:** *Not required* (CPU-only).

### Operating Systems
- **Windows 10/11 x64**
- **macOS** (Intel or Apple Silicon; Apple Silicon can work via Rosetta or native wheels depending on your Python/wheels)
- **Linux** (modern x86_64 distros)

### Runtimes / Tools
- **Python 3.10+.**
- **Kiwix**: the **`kiwix-serve`** binary under `./kiwix/` and at least one **Wikipedia `.zim`** under `./kiwix/content/` (used by the offline Wikipedia tab).

### Python dependencies (`requirements.txt`)
These are the exact packages pinned/declared by the project:

```
fastapi==0.115.0
uvicorn[standard]==0.30.6
llama-cpp-python>=0.3.10
psutil==6.0.0
requests==2.32.3
```

---

## 📦 Project Structure

```
/project-root
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
├── agents.json # Agent directory (name, role, avatar, greeting)
├── categories.json # Agent categories (labels + emoji; EN/ES/FR)
├── README.md # Project documentation
└── LICENSE # (Optional) your chosen license
```


---

## 📦 Download the project

To download
