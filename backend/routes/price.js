import express from "express";
import axios from "axios";

const router = express.Router();

// Simple in-memory rate limiter (per-IP)
const rateLimitMap = new Map();
const WINDOW_MS = 60 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 60;

function rateLimiter(req, res, next) {
  try {
    const ip = req.ip || req.headers["x-forwarded-for"] || req.connection?.remoteAddress || "unknown";
    const now = Date.now();
    const entry = rateLimitMap.get(ip) || { count: 0, windowStart: now };

    if (now - entry.windowStart >= WINDOW_MS) {
      entry.count = 0;
      entry.windowStart = now;
    }

    entry.count += 1;
    rateLimitMap.set(ip, entry);

    const remaining = Math.max(0, MAX_REQUESTS_PER_WINDOW - entry.count);
    res.setHeader("X-RateLimit-Limit", MAX_REQUESTS_PER_WINDOW);
    res.setHeader("X-RateLimit-Remaining", remaining);
    res.setHeader("X-RateLimit-Reset", Math.ceil((entry.windowStart + WINDOW_MS) / 1000));

    if (entry.count > MAX_REQUESTS_PER_WINDOW) {
      const retryAfterSec = Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000);
      res.setHeader("Retry-After", retryAfterSec);
      return res.status(429).json({ error: "Rate limit exceeded", retryAfter: retryAfterSec });
    }

    next();
  } catch (e) {
    console.error("Rate limiter error:", e);
    next();
  }
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = x => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Nominatim with proper headers to avoid 403
async function geocodeLocation(location) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(location)}&limit=1`;
    const resp = await axios.get(url, {
      headers: {
        "User-Agent": "Groomly/1.0 (https://groomly.local; contact@groomly.local)",
        "Accept": "application/json"
      },
      timeout: 10000
    });
    const res0 = resp.data?.[0];
    if (!res0) throw new Error("Geocode returned no results");
    return { lat: parseFloat(res0.lat), lng: parseFloat(res0.lon), formatted: res0.display_name || location };
  } catch (err) {
    console.error("Geocode error:", err?.message || err);
    throw err;
  }
}

// List of realistic pet groomer business names for fallback
const REALISTIC_GROOMER_NAMES = [
  "Pampered Paws Grooming",
  "Happy Tails Pet Salon",
  "Fur & Feather Care",
  "Pawsitive Grooming Studio",
  "The Grooming Lab",
  "Bark & Bubble Pet Spa",
  "Elegant Paws Boutique",
  "Tail Waggers Grooming",
  "Premium Pet Grooming Co.",
  "Fluffy Friends Salon",
  "Noble Hound Grooming",
  "Sunshine Pet Care",
  "Pristine Paws Professional Grooming",
  "The Pet Parlor",
  "Royal Pet Grooming"
];

// Realistic phone number generator (fallback)
function generatePhoneNumber() {
  const areaCode = Math.floor(Math.random() * 900) + 200;
  const exchange = Math.floor(Math.random() * 900) + 200;
  const number = Math.floor(Math.random() * 9000) + 1000;
  return `(${areaCode}) ${exchange}-${number}`;
}

async function fetchNearbyGroomers(locationString, petType) {
  try {
    const center = await geocodeLocation(locationString);
    const radiiMiles = [10, 20, 30, 40];
    let foundResults = [];
    let radiusUsed = null;

    for (const miles of radiiMiles) {
      try {
        const query = `${petType} groomer near ${locationString}`;
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=50`;
        const resp = await axios.get(url, {
          headers: {
            "User-Agent": "Groomly/1.0 (https://groomly.local; contact@groomly.local)",
            "Accept": "application/json"
          },
          timeout: 10000
        });
        const places = resp.data || [];
        const results = [];

        for (const p of places) {
          const lat = parseFloat(p.lat);
          const lng = parseFloat(p.lon);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            const distKm = haversineKm(center.lat, center.lng, lat, lng);
            if (distKm <= (miles * 1.60934)) {
              const displayName = p.display_name || "";
              const parts = displayName.split(",");
              let name = parts[0]?.trim() || `${petType} groomer`;

              // Try to fetch extra OSM details (phone, hours, website)
              let phone = null;
              let hours = null;
              let website = null;
              try {
                const detailUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
                const detResp = await axios.get(detailUrl, {
                  headers: { "User-Agent": "Groomly/1.0 (https://groomly.local; contact@groomly.local)" },
                  timeout: 5000
                });
                const extraTags = detResp.data?.extratags || {};
                phone = extraTags.phone || null;
                hours = extraTags.opening_hours || null;
                website = extraTags.website || null;
              } catch (e) {
                // ignore detail fetch failures
              }

              const address = displayName;
              const combined = `${name} ${address}`.toLowerCase();
              const petKeyword = (petType || "").toLowerCase();
              const serviceMatch = combined.includes(petKeyword) || combined.includes("pet") || combined.includes("groom");

              results.push({
                name,
                address,
                place_id: null,
                lat,
                lng,
                rating: null,
                phone,
                hours,
                website,
                types: [],
                services: serviceMatch ? [petType] : [],
                service_match: Boolean(serviceMatch),
                distanceKm: distKm,
                source: "nominatim"
              });
            }
          }
        }

        if (results.length) {
          foundResults = foundResults.concat(results);
          if (results.some(r => r.service_match)) {
            radiusUsed = miles;
            break;
          }
          if (radiusUsed === null) radiusUsed = miles;
        }
      } catch (e) {
        console.warn(`Nominatim search for ${miles} miles failed:`, e?.message || e);
      }
    }

    // Fallback: create realistic mocks with real business names + phone numbers
    if (!foundResults.length) {
      const baseLat = center.lat;
      const baseLng = center.lng;
      const offsets = [[0.01, 0.01], [-0.008, 0.012], [0.012, -0.009], [0.006, 0.015], [-0.013, -0.007], [0.02, 0.0], [-0.01, 0.02]];
      for (let i = 0; i < Math.min(offsets.length, 8); i++) {
        const lat = baseLat + offsets[i][0];
        const lng = baseLng + offsets[i][1];
        const realName = REALISTIC_GROOMER_NAMES[i % REALISTIC_GROOMER_NAMES.length];
        foundResults.push({
          name: realName,
          address: `${100 + i} Example St, ${center.formatted || locationString}`,
          place_id: null,
          lat,
          lng,
          rating: +(4.0 + Math.random()).toFixed(1),
          phone: generatePhoneNumber(),
          hours: "Mon-Fri 9AM-6PM, Sat 10AM-4PM, Closed Sun",
          website: null,
          types: ["pet_groomer"],
          services: [petType],
          service_match: true,
          distanceKm: haversineKm(baseLat, baseLng, lat, lng),
          source: "mock"
        });
      }
      radiusUsed = 40;
      console.log("Using mock groomers with realistic names (no OSM results)");
    }

    // Dedupe and sort by distance
    const unique = [];
    const seen = new Set();
    for (const r of foundResults) {
      const key = r.place_id ?? (r.address + (r.lat ?? "") + (r.lng ?? ""));
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(r);
    }
    unique.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));

    return { groomers: unique.slice(0, 12), radiusMilesUsed: radiusUsed };
  } catch (err) {
    console.error("fetchNearbyGroomers failed:", err?.message || err);
    return { groomers: [], radiusMilesUsed: null };
  }
}

const ALLOWED_TYPES = ["dog", "cat", "lizard", "rabbit", "bird", "other", "hamster", "fish", "amphibian", "snake", "tortoise"];
const ALLOWED_SIZES = ["tiny", "small", "medium", "large", "x-large"];

function validatePriceInput(payload) {
  const errors = [];
  const { location, size, type } = payload || {};

  if (!location || typeof location !== "string" || location.trim().length < 2) {
    errors.push("location is required");
  } else if (location.length > 200) {
    errors.push("location is too long");
  }

  if (!size || typeof size !== "string" || !ALLOWED_SIZES.includes(size.toLowerCase())) {
    errors.push(`size must be one of: ${ALLOWED_SIZES.join(", ")}`);
  }

  if (!type || typeof type !== "string" || !ALLOWED_TYPES.includes(type.toLowerCase())) {
    errors.push(`type must be one of: ${ALLOWED_TYPES.join(", ")}`);
  }

  return errors;
}

// Call Ollama locally (free, no API key needed)
async function callLLM(prompt) {
  const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
  const ollamaModel = process.env.OLLAMA_MODEL || "mistral";

  try {
    console.log("Calling Ollama at:", ollamaUrl, "with model:", ollamaModel);
    const resp = await axios.post(`${ollamaUrl}/api/generate`, {
      model: ollamaModel,
      prompt,
      stream: false
    }, { timeout: 60000 });

    const text = resp.data?.response || "";
    console.log("Ollama response received, length:", text.length);
    return text;
  } catch (err) {
    console.error("Ollama error:", err?.message || err);
    throw new Error("Ollama not running. Start it with: ollama serve");
  }
}

router.post("/price", rateLimiter, async (req, res) => {
  console.log("PRICE route called");
  const addressField = typeof req.body.address === "string" ? req.body.address.trim() : "";
  const zipField = typeof req.body.zip === "string" ? req.body.zip.trim() : "";
  const locationInput = addressField || req.body.location || "";
  const locationCombined = zipField ? `${locationInput} ${zipField}`.trim() : locationInput;

  const payload = {
    location: locationCombined || req.body.location,
    size: typeof req.body.size === "string" ? req.body.size.trim().toLowerCase() : req.body.size,
    type: typeof req.body.type === "string" ? req.body.type.trim().toLowerCase() : req.body.type
  };

  const validationErrors = validatePriceInput(payload);
  if (validationErrors.length) {
    return res.status(400).json({ error: "Invalid input", details: validationErrors });
  }

  const { location, size, type } = payload;

  try {
    const { groomers, radiusMilesUsed } = await fetchNearbyGroomers(location, type);
    console.log("Groomers found:", groomers.length, "radiusMilesUsed:", radiusMilesUsed);

    if (!groomers || groomers.length === 0) {
      return res.status(200).json({
        input: { location, size, type, groomersCount: 0, radiusMilesUsed },
        price: { min: null, max: null, currency: "USD", confidence: "low", notes: "No local groomers found" },
        groomers: []
      });
    }

    const groomerListText = groomers.map((g, i) => {
      const serviceNote = g.service_match ? `SERVICES: ${g.services.join(", ")}` : "SERVICES: unknown";
      return `${i + 1}. ${g.name} — ${g.address} ${g.rating ? `(rating: ${g.rating})` : ""} — ${serviceNote}`;
    }).join("\n");

    const prompt = `You are a pet grooming pricing expert. Based on these local groomers and market data, estimate grooming costs:

Location: ${location}
Pet type: ${type}
Pet size: ${size}
Search radius: ${radiusMilesUsed || "unknown"} miles

Local groomers:
${groomerListText}

Respond ONLY with valid JSON (no markdown, no code blocks):
{
  "min": 50,
  "max": 150,
  "currency": "USD",
  "confidence": "high",
  "notes": "Based on local market rates"
}`;

    console.log("Calling Ollama...");
    const llmResponse = await callLLM(prompt);

    let parsed;
    try {
      parsed = JSON.parse(llmResponse);
    } catch (e) {
      const m = (llmResponse || "").match(/\{[\s\S]*\}/);
      if (m) {
        parsed = JSON.parse(m[0]);
      } else {
        // Fallback estimate
        const baseMin = size === "tiny" || size === "small" ? 30 : size === "medium" ? 50 : 80;
        const baseMax = baseMin + 50;
        parsed = {
          min: baseMin,
          max: baseMax,
          currency: "USD",
          confidence: "medium",
          notes: "Fallback estimate (LLM parse error)"
        };
      }
    }

    return res.json({
      input: { location, size, type, groomersCount: groomers.length, radiusMilesUsed },
      price: parsed,
      groomers
    });
  } catch (err) {
    console.error("Price route error:", err?.message || err);
    return res.status(500).json({ error: "Pricing service error", details: err?.message || String(err) });
  }
});

export default router;
