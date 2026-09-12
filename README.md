# Cloudflare AI-Powered Chat Application

This is a complete implementation fulfilling the application assignment requirements on the **Cloudflare Developer Platform**.

## Architecture Components Implemented:
1. **LLM:** Meta Llama 3.3 (`@cf/meta/llama-3.3-70b-instruct`) executed at the edge via **Cloudflare Workers AI**.
2. **Workflow / Coordination:** Orchestrated via a **Cloudflare Worker** intercepting API traffic and managing request lifecycles.
3. **User Input / Front-end:** A modern, fully responsive chat interface deployed via **Cloudflare Pages**.
4. **Memory / State:** Persistent serverless storage leveraging **Cloudflare KV** to track multi-turn user session context.

## Setup Instructions

1. **Install Wrangler CLI:**
   ```bash
   npm install -g wrangler
   ```

2. **Login to Cloudflare:**
   ```bash
   wrangler login
   ```

3. **Create the KV Namespace for Chat Memory:**
   ```bash
   wrangler kv:namespace create CHAT_HISTORY
   ```
   *Copy the outputted namespace `id` and paste it inside your `wrangler.json` under `kv_namespaces[0].id`.*

4. **Run Locally for Testing:**
   ```bash
   wrangler dev
   ```

5. **Deploy to Production:**
   ```bash
   wrangler deploy
   ```
