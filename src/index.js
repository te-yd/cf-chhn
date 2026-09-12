export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
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

      // 1. Retrieve history from Cloudflare KV
      const historyKey = `session:${sessionId}`;
      let historyRaw = await env.CHAT_HISTORY.get(historyKey);
      let history = historyRaw ? JSON.parse(historyRaw) : [];

      // Append user's new message
      history.push({ role: "user", content: message });

      // Keep history lean (last 10 messages for context)
      if (history.length > 10) history = history.slice(-10);

      // System instructions to guide the model
      const messages = [
        { role: "system", content: "You are a helpful and polite AI assistant powered by Cloudflare Workers." },
        ...history
      ];

      // 2. Call Cloudflare Workers AI with Llama 3.3
      const response = await env.AI.run("@cf/meta/llama-3.3-70b-instruct", {
        messages: messages,
      });

      const botResponse = response.response;

      // Append assistant's response to history and save back to KV
      history.push({ role: "assistant", content: botResponse });
      await env.CHAT_HISTORY.put(historyKey, JSON.stringify(history), {
        expirationTtl: 86400, // Expire session after 24 hours
      });

      // 3. Return response with CORS headers
      return new Response(JSON.stringify({ response: botResponse }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });

    } catch (err) {
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