# 🧩 Offline Survival AI Stick for Preppers
### 🔹 Offline LLM & Agents & Wikipedia & More

Este proyecto permite interactuar con un **modelo LLM offline** o con **agentes especializados** (médicos, biólogos, ingenieros, etc.), usando modelos en formato **GGUF** ejecutados con [Ollama](https://ollama.ai) o [llama.cpp](https://github.com/ggerganov/llama.cpp).  

Todo funciona **offline**, sin depender de servidores externos.

---

## 📂 Modelos recomendados

Todos con **licencia libre para uso comercial**:

- **Mistral 7B Instruct (Q4_K_M)** → Modelo principal (~4.1 GB)  
  🔗 [Descargar](https://huggingface.co/TheBloke/Mistral-7B-Instruct-v0.1-GGUF)  

- **Phi-3 Mini 4K Instruct (Q4_K_M)** → Más ligero (~2.2 GB)  
  🔗 [Descargar](https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf)  

- **Gemma 2B (Q4_K_M)** → Muy rápido (~1.8 GB)  
  🔗 [Descargar](https://huggingface.co/google/gemma-2b-gguf)  

📌 Todos los modelos se almacenan en la carpeta:
/models

---

## ⚙️ Instalación de modelos

### 🔹 Linux / Mac

1. Abre una terminal en la raíz del proyecto.  
2. Crea el archivo `download_models.sh` con este contenido:

```bash
#!/bin/bash
mkdir -p models

echo "⬇️ Descargando Mistral 7B Instruct..."
wget -O models/mistral-7b-instruct.Q4_K_M.gguf https://huggingface.co/TheBloke/Mistral-7B-Instruct-v0.1-GGUF/resolve/main/mistral-7b-instruct-v0.1.Q4_K_M.gguf

echo "⬇️ Descargando Phi-3 Mini..."
wget -O models/phi-3-mini-4k-instruct.Q4_K_M.gguf https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf/resolve/main/Phi-3-mini-4k-instruct.Q4_K_M.gguf

echo "⬇️ Descargando Gemma 2B..."
wget -O models/gemma-2b.Q4_K_M.gguf https://huggingface.co/google/gemma-2b-gguf/resolve/main/gemma-2b.Q4_K_M.gguf

echo "✅ Descargas completadas. Modelos guardados en ./models"
