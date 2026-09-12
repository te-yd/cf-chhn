export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      const { message, sessionId } = await request.json();
      if (!message || !sessionId) {
        return new Response("Missing message or sessionId", { status: 400 });
      }

      const historyKey = `session:${sessionId}`;
      let historyRaw = await env.CHAT_HISTORY.get(historyKey);
      let history = historyRaw ? JSON.parse(historyRaw) : [];

      history.push({ role: "user", content: message });
      if (history.length > 10) history = history.slice(-10);

      const messages = [
        { role: "system", content: "Act like 3 year old and reply to the conversation and no more than 15 words per message." },
        ...history
      ];

      const response = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages: messages,
      });

      const botResponse = response.response;

      history.push({ role: "assistant", content: botResponse });
      await env.CHAT_HISTORY.put(historyKey, JSON.stringify(history), {
        expirationTtl: 86400, // 24h
      });

      return new Response(JSON.stringify({ response: botResponse }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });

    } catch (err) {
      console.log(err.message);
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
  },
};