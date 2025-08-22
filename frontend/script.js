async function sendMessage(message, mode = "llm", agent = null) {
  const response = await fetch("http://localhost:8000/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, mode, agent })
  });
  const data = await response.json();
  return data.reply;
}
