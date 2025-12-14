import express from "express";
import axios from "axios";

const router = express.Router();

// Rate limiter
const rateLimitMap = new Map();
const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "3600000", 10);
const MAX_REQUESTS_PER_WINDOW = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "60", 10);

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

// Concurrency limiter for LLM calls
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_LLM_CALLS || "5", 10);
let activeLLMCalls = 0;
const llmQueue = [];

async function acquireLLMSlot() {
  if (activeLLMCalls < MAX_CONCURRENT) {
    activeLLMCalls++;
    return Promise.resolve();
  }
  return new Promise((resolve) => llmQueue.push(resolve));
}

function releaseLLMSlot() {
  activeLLMCalls--;
  if (llmQueue.length > 0) {
    const next = llmQueue.shift();
    activeLLMCalls++;
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

// Realistic groomer names for fallback/mock data
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

function generatePhoneNumber() {
  const areaCode = Math.floor(Math.random() * 900) + 200;
  const exchange = Math.floor(Math.random() * 900) + 200;
  const number = Math.floor(Math.random() * 9000) + 1000;
  return `(${areaCode}) ${exchange}-${number}`;
}

// NEW: Geocode using Geocodio (works on Render, free tier available)
async function geocodeLocation(location) {
  console.log("=== GEOCODE START ===");
  console.log("Attempting to geocode location:", location);
  
  const geocodioKey = process.env.GEOCODIO_API_KEY;
  
  if (!geocodioKey) {
    console.error("GEOCODIO_API_KEY not set in environment");
    throw new Error("Geocoding API key not configured");
  }
  
  try {
    const url = `https://api.geocod.io/v1.7/geocode?q=${encodeURIComponent(location)}&api_key=${geocodioKey}`;
    console.log("Request URL:", url.replace(geocodioKey, 'API_KEY_HIDDEN'));
    
    const resp = await axios.get(url, { timeout: 10000 });
    
    console.log("Geocodio response status:", resp.status);
    console.log("Geocodio results count:", resp.data?.results?.length);
    
    const result = resp.data?.results?.[0];
    if (!result) {
      console.error("Geocodio returned no results for:", location);
      throw new Error("Address not found: " + location);
    }
    
    const lat = result.location.lat;
    const lng = result.location.lng;
    const formatted = result.formatted_address;
    
    console.log("Geocoded successfully:", formatted);
    console.log("Coordinates:", lat, lng);
    console.log("=== GEOCODE SUCCESS ===");
    
    return { lat, lng, formatted };
  } catch (err) {
    console.error("=== GEOCODE ERROR ===");
    console.error("Error type:", err?.constructor?.name);
    console.error("Error message:", err?.message);
    console.error("Response status:", err?.response?.status);
    console.error("Response data:", JSON.stringify(err?.response?.data));
    console.error("=== GEOCODE ERROR END ===");
    throw err;
  }
}

// NEW: Search for real groomers using Google Places API
async function searchRealGroomers(lat, lng, petType, radiusMiles) {
  console.log(`Searching for real groomers within ${radiusMiles} miles of ${lat},${lng}`);
  
  const googleKey = process.env.GOOGLE_PLACES_API_KEY;
  
  if (!googleKey) {
    console.warn("GOOGLE_PLACES_API_KEY not set, skipping real groomer search");
    return [];
  }
  
  try {
    const radiusMeters = radiusMiles * 1609.34; // Convert miles to meters
    const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radiusMeters}&type=pet_store&keyword=pet grooming ${petType}&key=${googleKey}`;
    
    console.log("Google Places API request (radius:", radiusMiles, "miles)");
    
    const resp = await axios.get(url, { timeout: 10000 });
    
    if (resp.data?.status !== "OK" && resp.data?.status !== "ZERO_RESULTS") {
      console.error("Google Places API error:", resp.data?.status, resp.data?.error_message);
      return [];
    }
    
    const places = resp.data?.results || [];
    console.log(`Google Places returned ${places.length} results`);
    
    const groomers = places.map(p => {
      const distKm = haversineKm(lat, lng, p.geometry.location.lat, p.geometry.location.lng);
      return {
        name: p.name,
        address: p.vicinity || p.formatted_address,
        place_id: p.place_id,
        lat: p.geometry.location.lat,
        lng: p.geometry.location.lng,
        rating: p.rating || null,
        phone: null, // Would need Place Details API call
        hours: p.opening_hours?.open_now ? "Open now" : null,
        website: null,
        types: p.types || [],
        services: [petType],
        service_match: true,
        distanceKm: distKm,
        source: "google-places"
      };
    });
    
    return groomers;
  } catch (err) {
    console.error("Google Places API error:", err?.message);
    console.error("Response status:", err?.response?.status);
    console.error("Response data:", JSON.stringify(err?.response?.data));
    return [];
  }
}

async function fetchNearbyGroomers(locationString, petType) {
  console.log("=== FETCH NEARBY GROOMERS START ===");
  console.log("Location string:", locationString);
  console.log("Pet type:", petType);
  
  try {
    // Step 1: Geocode the user's address to get coordinates
    const center = await geocodeLocation(locationString);
    console.log("User location:", center.formatted);
    console.log("Coordinates:", center.lat, center.lng);
    
    // Step 2: Search for real groomers at increasing radii
    const radiiMiles = [10, 20, 30, 40];
    let allGroomers = [];
    let radiusUsed = null;
    
    for (const miles of radiiMiles) {
      const groomers = await searchRealGroomers(center.lat, center.lng, petType, miles);
      
      if (groomers.length > 0) {
        allGroomers = allGroomers.concat(groomers);
        radiusUsed = miles;
        console.log(`Found ${groomers.length} groomers at ${miles} miles`);
        
        // If we have enough results, stop searching
        if (allGroomers.length >= 10) break;
      }
      
      // Add delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Step 3: If no real groomers found, generate realistic mock data
    if (allGroomers.length === 0) {
      console.log("No real groomers found, generating mock data");
      const offsets = [
        [0.01, 0.01], [-0.015, 0.008], [0.008, -0.012], 
        [0.012, 0.015], [-0.02, -0.005], [0.018, 0.002], 
        [-0.008, 0.018], [0.022, -0.010]
      ];
      
      for (let i = 0; i < offsets.length; i++) {
        const lat = center.lat + offsets[i][0];
        const lng = center.lng + offsets[i][1];
        const realName = REALISTIC_GROOMER_NAMES[i % REALISTIC_GROOMER_NAMES.length];
        const distKm = haversineKm(center.lat, center.lng, lat, lng);
        
        allGroomers.push({
          name: realName,
          address: `${100 + (i * 25)} ${['Main St', 'Oak Ave', 'Elm Blvd', 'Maple Dr'][i % 4]}, near ${center.formatted}`,
          place_id: null,
          lat,
          lng,
          rating: +(3.8 + Math.random() * 1.2).toFixed(1),
          phone: generatePhoneNumber(),
          hours: "Mon-Fri 9AM-6PM, Sat 10AM-4PM",
          website: null,
          types: ["pet_groomer"],
          services: [petType],
          service_match: true,
          distanceKm: distKm,
          source: "mock"
        });
      }
      radiusUsed = 20;
    }
    
    // Remove duplicates and sort by distance
    const unique = [];
    const seen = new Set();
    for (const g of allGroomers) {
      const key = g.place_id || `${g.lat},${g.lng}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(g);
    }
    
    unique.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
    
    console.log("Returning", unique.length, "groomers");
    console.log("=== FETCH NEARBY GROOMERS END ===");
    
    return { groomers: unique.slice(0, 12), radiusMilesUsed: radiusUsed };
    
  } catch (err) {
    console.error("fetchNearbyGroomers failed:", err?.message);
    console.error("Stack trace:", err?.stack);
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

async function callLLM(prompt) {
  await acquireLLMSlot();
  try {
    const groqApiKey = process.env.GROQ_API_KEY;
    const groqModel = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

    if (!groqApiKey) {
      throw new Error("GROQ_API_KEY not configured in environment");
    }

    console.log("Calling Groq AI with model:", groqModel, "(worker:", process.pid, "active:", activeLLMCalls, ")");
    
    const resp = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: groqModel,
        messages: [
          {
            role: "system",
            content: "You are a pet grooming pricing expert. Respond ONLY with valid JSON, no markdown formatting."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.7,
        max_tokens: 500
      },
      {
        headers: {
          "Authorization": `Bearer ${groqApiKey}`,
          "Content-Type": "application/json"
        },
        timeout: 30000
      }
    );

    const text = resp.data?.choices?.[0]?.message?.content || "";
    console.log("Groq AI response received, length:", text.length);
    return text;
  } catch (err) {
    console.error("Groq AI error:", err?.response?.data || err?.message || err);
    throw new Error("Groq AI connection failed: " + (err?.response?.data?.error?.message || err?.message));
  } finally {
    releaseLLMSlot();
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
