# 🧠 Survival AI – Model Setup

Este proyecto usa modelos de lenguaje en formato **GGUF**, optimizados para funcionar de manera **offline** con [Ollama](https://ollama.ai) o [llama.cpp](https://github.com/ggerganov/llama.cpp).  
⚡ No necesitas almacenar los modelos en este repositorio, se descargan automáticamente desde **Hugging Face**.

---

## 📥 Modelos soportados (licencia libre para uso comercial)

- **Mistral 7B Instruct** – Apache 2.0  
  [Descargar en Hugging Face](https://huggingface.co/TheBloke/Mistral-7B-Instruct-v0.1-GGUF)  
  Archivo recomendado: `mistral-7b-instruct-v0.1.Q4_K_M.gguf` (~4 GB)

- **Phi-3 Mini 4K Instruct** – MIT  
  [Descargar en Hugging Face](https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf)  
  Archivo recomendado: `phi-3-mini-4k-instruct.Q4_K_M.gguf` (~3 GB)

- **Gemma 2B** – Google (licencia abierta, uso comercial permitido)  
  [Descargar en Hugging Face](https://huggingface.co/google/gemma-2b-gguf)  
  Archivo recomendado: `gemma-2b.Q4_K_M.gguf` (~2 GB)

---

## 🚀 Instrucciones de instalación

### 🔹 Linux / Mac
Ejecuta en terminal:

```bash
chmod +x download_models.sh
./download_models.sh
