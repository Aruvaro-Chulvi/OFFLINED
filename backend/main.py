from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import httpx

app = FastAPI()

OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL = "mistral"

class ChatRequest(BaseModel):
    message: str
    mode: str = "llm"  # "llm" o "agent"
    agent: str | None = None

@app.post("/chat")
async def chat(req: ChatRequest):
    prompt = req.message

    # Si es un agente, aquí le puedes meter la personalidad:
    if req.mode == "agent" and req.agent:
        # Ejemplo de agente fijo, luego cargarás de BD o JSON
        if req.agent == "medic":
            system_prompt = "You are Dr. Survival, a calm medical expert. Always give practical survival medicine advice."
            prompt = f"{system_prompt}\nUser: {req.message}"

    payload = {"model": MODEL, "prompt": prompt, "stream": False}

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(OLLAMA_URL, json=payload)
            r.raise_for_status()
    except httpx.HTTPError as exc:
        status = exc.response.status_code if exc.response else 500
        raise HTTPException(status_code=status, detail=str(exc))

    return {"reply": r.json()["response"]}

