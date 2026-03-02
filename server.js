
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3002;

// The public base URL of this server (set in Render environment variables)
// In dev: http://localhost:3002
// In production: https://your-app.onrender.com
const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;

// HyperReal API keys with fallback support
// Reads: HYPERREAL_API_KEY, HYPERREAL_API_KEY1, HYPERREAL_API_KEY2, ... up to 10
const HYPERREAL_API_BASE = "https://api.hypereal.tech";

function getApiKeys() {
    const keys = [];
    // Check the base key first
    if (process.env.HYPERREAL_API_KEY) {
        keys.push(process.env.HYPERREAL_API_KEY);
    }
    // Then check numbered keys: HYPERREAL_API_KEY1, HYPERREAL_API_KEY2, ...
    for (let i = 1; i <= 10; i++) {
        const key = process.env[`HYPERREAL_API_KEY${i}`];
        if (key) keys.push(key);
    }
    return keys;
}

const HYPERREAL_API_KEYS = getApiKeys();

// Retry-on-failure statuses (expired key, rate limited, forbidden)
const RETRYABLE_STATUSES = [401, 403, 429];

/**
 * Call HyperReal API with automatic key fallback.
 * Tries each key in order; on 401/403/429, switches to the next key.
 */
async function callHyperrealWithFallback(payload, extraApiKey) {
    // Build the key list: prefer the client-provided key first, then server keys
    const keysToTry = extraApiKey
        ? [extraApiKey, ...HYPERREAL_API_KEYS]
        : [...HYPERREAL_API_KEYS];

    if (keysToTry.length === 0) {
        throw new Error("No HyperReal API keys configured. Set HYPERREAL_API_KEY env var.");
    }

    let lastError = null;

    for (let i = 0; i < keysToTry.length; i++) {
        const apiKey = keysToTry[i];
        const keyLabel = `key${i + 1}/${keysToTry.length}`;

        try {
            console.log(`   🔑 Trying ${keyLabel}...`);

            const response = await fetch(`${HYPERREAL_API_BASE}/v1/images/generate`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`,
                },
                body: JSON.stringify(payload),
            });

            if (response.ok) {
                const data = await response.json();
                console.log(`   ✅ Success with ${keyLabel}`);
                return data;
            }

            const errorText = await response.text().catch(() => response.statusText);

            // If it's a retryable error (expired/rate-limited), try next key
            if (RETRYABLE_STATUSES.includes(response.status) && i < keysToTry.length - 1) {
                console.warn(`   ⚠️ ${keyLabel} failed (${response.status}), trying next key...`);
                lastError = new Error(`Key ${i + 1} error: ${response.status} ${errorText}`);
                continue;
            }

            // Non-retryable error or last key — throw
            throw new Error(`HyperReal API error: ${response.status} ${response.statusText} - ${errorText}`);

        } catch (err) {
            // Network error — if we have more keys, try them (different keys might route differently)
            if (i < keysToTry.length - 1 && !err.message?.includes("HyperReal API error")) {
                console.warn(`   ⚠️ ${keyLabel} network error, trying next key...`);
                lastError = err;
                continue;
            }
            throw err;
        }
    }

    throw lastError || new Error("All API keys exhausted");
}

// CORS - allow requests from the frontend
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(",")
        : ["http://localhost:5173", "http://localhost:3000"],
    methods: ["GET", "POST"],
}));

app.use(express.json());

// ==================== In-Memory Image Store ====================

// Store uploaded images in memory (Map: id -> { buffer, mimeType, createdAt })
const imageStore = new Map();

// Auto-cleanup: remove images older than 10 minutes
setInterval(() => {
    const now = Date.now();
    const EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

    for (const [id, data] of imageStore.entries()) {
        if (now - data.createdAt > EXPIRY_MS) {
            imageStore.delete(id);
            console.log(`🧹 Cleaned up expired image: ${id}`);
        }
    }
}, 60 * 1000); // Check every minute

// ==================== Multer Setup ====================

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
    fileFilter: (_req, file, cb) => {
        if (file.mimetype.startsWith("image/")) {
            cb(null, true);
        } else {
            cb(new Error("Only image files are allowed"));
        }
    },
});

// ==================== Routes ====================

// Health check
app.get("/", (_req, res) => {
    res.json({
        status: "ok",
        message: "Image Edit Proxy Server",
        storedImages: imageStore.size,
    });
});

// Serve a temporarily stored image (HyperReal fetches from here)
app.get("/images/:id", (req, res) => {
    const { id } = req.params;
    const imageData = imageStore.get(id);

    if (!imageData) {
        return res.status(404).json({ error: "Image not found or expired" });
    }

    res.set("Content-Type", imageData.mimeType);
    res.set("Cache-Control", "public, max-age=600"); // 10 min cache
    res.send(imageData.buffer);
});

/**
 * POST /api/edit-image
 * 
 * Accepts multipart form data:
 * - image: File (required) - the source image to edit
 * - prompt: string (required) - edit instruction
 * - model: string (optional) - "nano-banana-edit" or "nano-banana-pro-edit"
 * - apiKey: string (optional) - HyperReal API key (overrides server default)
 * 
 * Returns: { success, editedImageUrl, creditsUsed }
 */
app.post("/api/edit-image", upload.single("image"), async (req, res) => {
    try {
        const { prompt, model, apiKey } = req.body;
        const file = req.file;

        if (!file) {
            return res.status(400).json({ error: "No image file uploaded" });
        }

        if (!prompt || prompt.trim().length === 0) {
            return res.status(400).json({ error: "Prompt is required" });
        }

        // Step 1: Store the image temporarily with a unique ID
        const imageId = crypto.randomUUID();
        imageStore.set(imageId, {
            buffer: file.buffer,
            mimeType: file.mimetype || "image/png",
            createdAt: Date.now(),
        });

        const imageUrl = `${SERVER_URL}/images/${imageId}`;
        console.log(`📦 Stored image ${imageId} (${Math.round(file.size / 1024)} KB)`);
        console.log(`🔗 Temporary URL: ${imageUrl}`);

        // Step 2: Call HyperReal API with the temporary URL (auto-fallback across keys)
        const editModel = model || "nano-banana-edit";
        const payload = {
            model: editModel,
            prompt: prompt.trim(),
            images: [imageUrl],
        };

        console.log(`📤 Calling HyperReal edit API (model: ${editModel})...`);

        const data = await callHyperrealWithFallback(payload, apiKey);

        // Clean up the temp image (no longer needed)
        imageStore.delete(imageId);
        console.log(`🧹 Cleaned up temp image: ${imageId}`);

        if (!data.data || data.data.length === 0 || !data.data[0].url) {
            return res.status(500).json({ error: "HyperReal returned no edited image URL" });
        }

        console.log(`✅ Edit complete! Credits used: ${data.creditsUsed}`);
        console.log(`🖼️ Result: ${data.data[0].url}`);

        res.json({
            success: true,
            editedImageUrl: data.data[0].url,
            creditsUsed: data.creditsUsed,
            model: data.data[0].model,
        });

    } catch (err) {
        console.error("❌ Server error:", err);
        res.status(500).json({ error: err.message || "Internal server error" });
    }
});

// ==================== Start Server ====================

app.listen(PORT, () => {
    console.log(`\n🚀 Image Edit Proxy Server running on port ${PORT}`);
    console.log(`   Server URL: ${SERVER_URL}`);
    console.log(`   HyperReal API keys: ${HYPERREAL_API_KEYS.length} configured`);
    console.log(`   Endpoints:`);
    console.log(`     GET  /              - Health check`);
    console.log(`     GET  /images/:id    - Serve temp image`);
    console.log(`     POST /api/edit-image - Upload + edit image\n`);
});

