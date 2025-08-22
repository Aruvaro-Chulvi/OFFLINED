from fastapi import FastAPI
from pydantic import BaseModel
import requests
import os

app = FastAPI()

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434/api/generate")
MODEL = os.getenv("MODEL", "mistral")

class ChatRequest(BaseModel):
    message: str
    mode: str = "llm"  # "llm" o "agent"
    agent: str | None = None

@app.post("/chat")
def chat(req: ChatRequest):
    prompt = req.message

    # Si es un agente, aquí le puedes meter la personalidad:
    if req.mode == "agent" and req.agent:
        # Ejemplo de agente fijo, luego cargarás de BD o JSON
        if req.agent == "medic":
            system_prompt = "You are Dr. Survival, a calm medical expert. Always give practical survival medicine advice."
            prompt = f"{system_prompt}\nUser: {req.message}"

    payload = {"model": MODEL, "prompt": prompt, "stream": False}
    r = requests.post(OLLAMA_URL, json=payload)

    if r.status_code == 200:
        return {"reply": r.json()["response"]}
    else:
        return {"reply": "⚠️ Error contacting Ollama"}

