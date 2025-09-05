# 🧩 Offline Survival AI Stick for Preppers
### 🔹 Offline LLM · Expert Agents · Offline Wikipedia (Kiwix)

**Survival AI** is a 100% **offline** desktop-style web app to chat with a **local LLM (GGUF)** or with **expert agents** (medical, biology, engineering, etc.). It also integrates **offline Wikipedia** via **Kiwix**—no cloud required.

- Backend: **FastAPI + llama-cpp-python**  
- Frontend: static SPA (HTML/CSS/JS)  
- Wikipedia: **kiwix-serve** with local **ZIM** files  
- Default model recommendation: **Phi-3 Mini 4K Instruct (Q4_K_M)**

> This repository **does not ship any model or ZIM files**. You’ll download them yourself (scripts provided below).

---

## Table of Contents

- [Features](#-features)
- [Screens / Modes](#%EF%B8%8F-screens--modes)
- [Requirements](#-requirements)
- [Project Structure](#-project-structure)
- [Windows — Full Setup](#windows--full-setup)
  - [1) Get the code](#1-get-the-code)
  - [2) Create venv & install deps](#2-create-venv--install-deps)
  - [3) Download models (PowerShell script)](#3-download-models-powershell-script)
  - [4) Kiwix (Offline Wikipedia)](#4-kiwix-offline-wikipedia)
  - [5) Configure the model](#5-configure-the-model)
  - [6) Run backend & frontend](#6-run-backend--frontend)
  - [7) Quick test](#7-quick-test)
  - [8) Environment variables (Windows)](#8-environment-variables-windows)
  - [9) Troubleshooting (Windows)](#9-troubleshooting-windows)
- [macOS / Linux — Full Setup](#macos--linux--full-setup)
  - [1) Get the code](#1-get-the-code-1)
  - [2) Create venv & install deps](#2-create-venv--install-deps-1)
  - [3) Download models (Bash script)](#3-download-models-bash-script)
  - [4) Kiwix (Offline Wikipedia)](#4-kiwix-offline-wikipedia-1)
  - [5) Configure the model](#5-configure-the-model-1)
  - [6) Run backend & frontend](#6-run-backend--frontend-1)
  - [7) Quick test](#7-quick-test-1)
  - [8) Environment variables (macOS / Linux)](#8-environment-variables-macos--linux)
  - [9) Troubleshooting (macOS / Linux)](#9-troubleshooting-macos--linux)
- [Switching models (both platforms)](#switching-models-both-platforms)
- [Distribution plan & Roadmap](#distribution-plan--roadmap)
- [Security & Offline Notes](#security--offline-notes)
- [License](#license)
- [Contributing](#contributing)


---

## ✨ Features

- **100% offline**: runs locally with GGUF models via `llama-cpp-python` (no cloud, no telemetry).
- **Two chat modes**:
  - **Model** — direct chat with the selected LLM.
  - **Agents** — visual agent picker (medical, engineering, etc.) with cards and suggested cross-referrals.
- **Offline Wikipedia**: built-in tab that works with **Kiwix** + **ZIM** files; can auto-start `kiwix-serve`.
- **Multi-language UI**: EN / ES / FR (including localized agent categories).
- **Quick model switcher**: load GGUF files from `/models` and change the active model from the UI.
- **Clean UI/UX**: light/dark theme toggle, battery indicator bar, Enter-to-send, and basic Markdown rendering.
- **Simple setup**: copy-paste scripts for Windows (PowerShell) and macOS/Linux (Bash).
- **Cross-platform**: Windows, macOS, and Linux; CPU-only with configurable threads.
 
- Fully **offline** after initial downloads

---

## 🖥️ Screens / Modes

- **Model**: direct chat with the selected LLM.
- **Agents**: pick an expert (avatar + short profile) and chat.
- **Wikipedia**: browse/search **offline Wikipedia** via Kiwix + ZIM.

---

## ✅ Requirements

**Common**
- **Python 3.10+**
- CPU with **AVX2** recommended (for llama.cpp performance)
- ~**6–10 GB** free disk (depending on models + ZIM size)

**Windows**
- **Windows 10/11 x64**

**macOS / Linux**
- Modern x86_64 CPU (Apple Silicon works via Rosetta or native wheels, depending on your Python & llama-cpp build)
- Shell/Terminal with `bash` and `wget` (or `curl`)

---

## 📦 Project Structure

