const MAX_SESSIONS = 20;
const MAX_CHATS_PER_SESSION = 500;

export class SessionManager {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // 1. GET /sessions or /api/sessions: Fetch all sessions (up to 20)
      if (method === "GET" && (path === "/sessions" || path === "/api/sessions")) {
        const sessions = (await this.storage.get("sessions")) || [];
        return new Response(JSON.stringify({ sessions }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // 2. GET /sessions/:id or /api/sessions/:id: Fetch specific session and its messages (up to 500)
      if (method === "GET" && (path.startsWith("/sessions/") || path.startsWith("/api/sessions/"))) {
        const parts = path.split("/").filter(Boolean);
        const targetId = parts[parts.length - 1];
        const sessions = (await this.storage.get("sessions")) || [];
        const session = sessions.find((s) => s.id === targetId);

        if (!session) {
          return new Response(JSON.stringify({ error: "Session not found" }), {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const messages = (await this.storage.get(`messages:${targetId}`)) || [];
        return new Response(JSON.stringify({ session, messages }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // 3. POST /sessions or /api/sessions: Explicitly create/map a new session (max 20)
      if (method === "POST" && (path === "/sessions" || path === "/api/sessions")) {
        const body = await request.json().catch(() => ({}));
        const newSessionId = body.sessionId || body.id || `sess_${Math.random().toString(36).slice(2, 11)}`;
        const title = body.title || "New Chat";

        const session = await this.ensureSession(newSessionId, title);
        return new Response(JSON.stringify({ session }), {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // 4. DELETE /sessions/:id or /api/sessions/:id: Delete session & clean storage
      if (method === "DELETE" && (path.startsWith("/sessions/") || path.startsWith("/api/sessions/"))) {
        const parts = path.split("/").filter(Boolean);
        const targetId = parts[parts.length - 1];

        let sessions = (await this.storage.get("sessions")) || [];
        sessions = sessions.filter((s) => s.id !== targetId);
        await this.storage.put("sessions", sessions);
        await this.storage.delete(`messages:${targetId}`);

        return new Response(JSON.stringify({ success: true, deletedId: targetId }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // 5. POST / or POST /chat or POST /api/chat: Handle chat interaction
      if (method === "POST" && (path === "/" || path === "/chat" || path === "/api/chat")) {
        const { message, sessionId } = await request.json();
        if (!message || !sessionId) {
          return new Response(JSON.stringify({ error: "Missing message or sessionId" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Map & ensure session exists in registry (enforcing max 20 sessions)
        const session = await this.ensureSession(sessionId);

        // Fetch stored messages for this session (up to 500)
        let messages = (await this.storage.get(`messages:${sessionId}`)) || [];

        // Append user prompt
        messages.push({ role: "user", content: message, timestamp: Date.now() });

        // Auto-update session title if it's the initial message
        if (session.title === "New Chat") {
          const autoTitle = message.length > 25 ? message.slice(0, 25) + "..." : message;
          await this.updateSessionTitle(sessionId, autoTitle);
        }

        // LLM prompt context: pass system prompt + last 10 messages to avoid token context overflow
        const contextHistory = messages.slice(-10).map((m) => ({
          role: m.role,
          content: m.content,
        }));

        const systemPrompt = {
          role: "system",
          content: "Act like 3 year old and reply to the conversation and no more than 15 words per message.",
        };

        const aiResponse = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
          messages: [systemPrompt, ...contextHistory],
        });

        const botResponse = aiResponse.response || "";

        // Append assistant response
        messages.push({ role: "assistant", content: botResponse, timestamp: Date.now() });

        // Enforce maximum 500 chats per session limit
        if (messages.length > MAX_CHATS_PER_SESSION) {
          messages = messages.slice(-MAX_CHATS_PER_SESSION);
        }

        // Persist all messages (up to 500) in Durable Object storage
        await this.storage.put(`messages:${sessionId}`, messages);

        // Update session's updatedAt timestamp
        await this.touchSession(sessionId);

        // Keep KV CHAT_HISTORY synchronized if configured
        if (this.env.CHAT_HISTORY) {
          try {
            await this.env.CHAT_HISTORY.put(`session:${sessionId}`, JSON.stringify(messages.slice(-10)), {
              expirationTtl: 86400,
            });
          } catch (kvErr) {
            console.warn("KV sync warning:", kvErr.message);
          }
        }

        return new Response(
          JSON.stringify({
            response: botResponse,
            sessionId: sessionId,
            messageCount: messages.length,
          }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      return new Response("Not Found", { status: 404, headers: corsHeaders });
    } catch (err) {
      console.error("Durable Object error:", err);
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  // Ensures session exists in the registry, pruning oldest session if exceeding MAX_SESSIONS (20)
  async ensureSession(sessionId, title = "New Chat") {
    let sessions = (await this.storage.get("sessions")) || [];
    let session = sessions.find((s) => s.id === sessionId);

    if (!session) {
      session = {
        id: sessionId,
        title: title,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      // Prune oldest session if max reached
      while (sessions.length >= MAX_SESSIONS) {
        const oldest = sessions.pop();
        if (oldest) {
          await this.storage.delete(`messages:${oldest.id}`);
        }
      }

      sessions.unshift(session);
      await this.storage.put("sessions", sessions);
    }

    return session;
  }

  async updateSessionTitle(sessionId, newTitle) {
    let sessions = (await this.storage.get("sessions")) || [];
    const index = sessions.findIndex((s) => s.id === sessionId);
    if (index !== -1) {
      sessions[index].title = newTitle;
      sessions[index].updatedAt = Date.now();
      await this.storage.put("sessions", sessions);
    }
  }

  async touchSession(sessionId) {
    let sessions = (await this.storage.get("sessions")) || [];
    const index = sessions.findIndex((s) => s.id === sessionId);
    if (index !== -1) {
      sessions[index].updatedAt = Date.now();
      await this.storage.put("sessions", sessions);
    }
  }
}

export default {
  async fetch(request, env) {
    // Handle CORS preflight for all endpoints
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // Route to global singleton SessionManager Durable Object if bound
    if (env.SESSION_TRACKER) {
      const id = env.SESSION_TRACKER.idFromName("global");
      const sessionTracker = env.SESSION_TRACKER.get(id);
      return sessionTracker.fetch(request);
    }

    // Fallback if Durable Object is not bound (e.g. lightweight KV dev)
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      const { message, sessionId } = await request.json();
      if (!message || !sessionId) {
        return new Response("Missing message or sessionId", { status: 400 });
      }

      const historyKey = `session:${sessionId}`;
      let historyRaw = env.CHAT_HISTORY ? await env.CHAT_HISTORY.get(historyKey) : null;
      let history = historyRaw ? JSON.parse(historyRaw) : [];

      history.push({ role: "user", content: message });
      if (history.length > 10) history = history.slice(-10);

      const messages = [
        { role: "system", content: "Act like 3 year old and reply to the conversation and no more than 15 words per message." },
        ...history,
      ];

      const response = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages: messages,
      });

      const botResponse = response.response;
      history.push({ role: "assistant", content: botResponse });

      if (env.CHAT_HISTORY) {
        await env.CHAT_HISTORY.put(historyKey, JSON.stringify(history), {
          expirationTtl: 86400,
        });
      }

      return new Response(JSON.stringify({ response: botResponse }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch (err) {
      console.error(err.message);
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