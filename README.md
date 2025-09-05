# 🧩 Offline Survival AI for Preppers
### 🔹 Offline LLM & Agents · Offline Wikipedia

**Survival AI** is a 100% **offline** app to chat with a **local LLM (GGUF)** or with **agents** (medical, biology, engineering, etc.). It also integrates **offline Wikipedia** via **Kiwix**—no cloud required.

- Backend: **FastAPI + llama-cpp-python**  
- Frontend: static SPA (HTML/CSS/JS)  
- Wikipedia: **kiwix-serve** with local **ZIM** files

> This repo is focused on **Phi models** only.
> Used model: **Phi-3 Mini 4K Instruct (Q4_K_M)**.

---

## ✨ Features

- **Model chat** (LLM-only)  
- **Agents chat** (visual picker; agent cards; suggested cross-referrals)  
- **Offline Wikipedia** tab (starts Kiwix locally and opens articles)  

---

## 📦 Project structure

/project-root
│
├── backend/
│ └── main.py
│
├── frontend/
│ ├── index.html
│ ├── style.css
│ └── script.js
│
├── models/ # place your .gguf here
│
└── kiwix/
├── kiwix-serve(.exe) # platform binary
└── content/ # place your .zim here

**API (summary):** `/api/status`, `/api/categories`, `/api/agents`, `/api/chat`, `/api/wiki`, `/api/wiki/candidates`.

---

# 🪟 Windows — Full Setup (copy/paste friendly)

### 0) Requirements

- **Windows 10/11 x64**
- **Python 3.10+**
- CPU with **AVX2** recommended for good llama.cpp performance

---

### 1) Get the code

```powershell
git clone https://github.com/<your-user>/survival-ai-stick.git
cd survival-ai-stick

