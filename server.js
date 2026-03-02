/**
 * Image Edit Proxy Server
 * 
 * This server acts as a middleman between the browser and HyperReal's image edit API.
 * 
 * Problem: HyperReal requires publicly accessible HTTP URLs in the `images` array,
 * but browser-uploaded files (base64, blob) and Supabase private URLs can't be accessed
 * by HyperReal's servers.
 * 
 * Solution: This server:
 * 1. Receives the image file upload from the browser
 * 2. Temporarily serves it at a public URL on this server
 * 3. Calls HyperReal API with that URL (which HyperReal CAN access)
 * 4. Returns the edited image URL to the browser
 * 5. Auto-cleans up temp files after 10 minutes
 */

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

// HyperReal API key (set in Render environment variables)
const HYPERREAL_API_KEY = process.env.HYPERREAL_API_KEY || "";
const HYPERREAL_API_BASE = "https://api.hypereal.tech";

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

        // Use provided API key or fall back to server's default
        const activeApiKey = apiKey || HYPERREAL_API_KEY;
        if (!activeApiKey) {
            return res.status(400).json({ error: "No HyperReal API key configured. Set HYPERREAL_API_KEY env var or pass apiKey in request." });
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

        // Step 2: Call HyperReal API with the temporary URL
        const editModel = model || "nano-banana-edit";
        const payload = {
            model: editModel,
            prompt: prompt.trim(),
            images: [imageUrl],
        };

        console.log(`📤 Calling HyperReal edit API (model: ${editModel})...`);

        const hyperrealResponse = await fetch(`${HYPERREAL_API_BASE}/v1/images/generate`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${activeApiKey}`,
            },
            body: JSON.stringify(payload),
        });

        if (!hyperrealResponse.ok) {
            const errorText = await hyperrealResponse.text().catch(() => hyperrealResponse.statusText);
            console.error(`❌ HyperReal error: ${hyperrealResponse.status} ${errorText}`);

            // Clean up the temp image
            imageStore.delete(imageId);

            return res.status(hyperrealResponse.status).json({
                error: `HyperReal API error: ${hyperrealResponse.status}`,
                details: errorText,
            });
        }

        const data = await hyperrealResponse.json();

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
    console.log(`   HyperReal API key: ${HYPERREAL_API_KEY ? "✅ configured" : "❌ not set"}`);
    console.log(`   Endpoints:`);
    console.log(`     GET  /              - Health check`);
    console.log(`     GET  /images/:id    - Serve temp image`);
    console.log(`     POST /api/edit-image - Upload + edit image\n`);
});
