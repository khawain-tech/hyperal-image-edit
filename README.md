# Image Edit Proxy Server

A lightweight Express server that acts as a middleman between the browser and HyperReal's image edit API.

## Why this exists

HyperReal's image edit API requires publicly accessible HTTP URLs in the `images` array. Browser-uploaded files (base64, blob URLs) and private Supabase storage URLs can't be accessed by HyperReal's servers.

This server:
1. Receives the image file upload from the browser
2. Temporarily serves it at a public URL
3. Calls HyperReal API with that URL
4. Returns the edited image URL back to the browser

## Deploy to Render

1. Push this `image-proxy-server/` folder to a GitHub repo (or the same repo)
2. Go to [Render Dashboard](https://dashboard.render.com/) → **New** → **Web Service**
3. Connect the repo and set:
   - **Root Directory**: `image-proxy-server`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. Set environment variables:
   - `HYPERREAL_API_KEY` — your HyperReal API key
   - `SERVER_URL` — the Render URL (e.g., `https://your-app.onrender.com`)
   - `ALLOWED_ORIGINS` — your frontend URL(s), comma-separated (e.g., `https://your-app.vercel.app,http://localhost:5173`)
5. Deploy!

Then in your frontend `.env`, set:
```
VITE_IMAGE_PROXY_URL=https://your-app.onrender.com
```

## Local Development

```bash
cd image-proxy-server
npm install
HYPERREAL_API_KEY=your_key_here node server.js
```

Server runs on `http://localhost:3002`. The frontend already defaults to this URL for local development.
