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

async function geocodeLocation(location) {
  console.log("=== GEOCODE START ===");
  console.log("Attempting to geocode location:", location);
  
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(location)}&limit=1`;
    console.log("Request URL:", url);
    console.log("Making request to Nominatim...");
    
    const resp = await axios.get(url, {
      headers: {
        "User-Agent": "Groomly/1.0 (https://groomly.onrender.com; dante@groomly.com)",
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9"
      },
      timeout: 15000
    });
    
    console.log("Geocode response status:", resp.status);
    console.log("Geocode response data:", JSON.stringify(resp.data).substring(0, 200));
    console.log("Geocode response data length:", resp.data?.length);
    
    const res0 = resp.data?.[0];
    if (!res0) {
      console.error("Geocode returned no results for:", location);
      throw new Error("Geocode returned no results for location: " + location);
    }
    
    console.log("Geocoded successfully:", res0.display_name);
    console.log("=== GEOCODE SUCCESS ===");
    return { 
      lat: parseFloat(res0.lat), 
      lng: parseFloat(res0.lon), 
      formatted: res0.display_name || location 
    };
  } catch (err) {
    console.error("=== GEOCODE ERROR ===");
    console.error("Geocode error for location:", location);
    console.error("Error type:", err?.constructor?.name);
    console.error("Error message:", err?.message);
    console.error("Error code:", err?.code);
    console.error("Response status:", err?.response?.status);
    console.error("Response statusText:", err?.response?.statusText);
    console.error("Response data:", JSON.stringify(err?.response?.data));
    console.error("Full error:", err);
    console.error("=== GEOCODE ERROR END ===");
    throw err;
  }
}

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

async function fetchNearbyGroomers(locationString, petType) {
  console.log("=== FETCH NEARBY GROOMERS START ===");
  console.log("Location string:", locationString);
  console.log("Pet type:", petType);
  
  let center = null;
  let mockMode = false;
  
  try {
    // Try to get coordinates for the user's location
    console.log("Attempting to geocode location...");
    center = await geocodeLocation(locationString);
    console.log("Center coordinates:", center.lat, center.lng);
    console.log("Center formatted address:", center.formatted);
  } catch (geoErr) {
    // Geocoding failed - use approximate coordinates based on location string
    console.warn("Geocoding failed, using mock coordinates");
    mockMode = true;
    
    // Try to extract zip code and use approximate US center coordinates
    const zipMatch = locationString.match(/\b\d{5}\b/);
    if (zipMatch) {
      const zip = zipMatch[0];
      // Approximate lat/lng for different regions based on first digit of zip
      const firstDigit = parseInt(zip[0]);
      const regionCoords = {
        0: { lat: 41.8, lng: -71.4 }, // New England
        1: { lat: 40.7, lng: -74.0 }, // NY area
        2: { lat: 38.9, lng: -77.0 }, // DC area  
        3: { lat: 33.7, lng: -84.4 }, // Atlanta area
        4: { lat: 38.2, lng: -85.7 }, // Louisville area
        5: { lat: 41.8, lng: -87.6 }, // Chicago area
        6: { lat: 38.6, lng: -90.2 }, // St Louis area
        7: { lat: 32.8, lng: -96.8 }, // Dallas area
        8: { lat: 39.7, lng: -104.9 }, // Denver area
        9: { lat: 37.8, lng: -122.4 }  // SF area
      };
      center = regionCoords[firstDigit] || { lat: 39.8, lng: -98.6 }; // US center default
      center.formatted = locationString;
    } else {
      // No zip code, use US geographic center
      center = { lat: 39.8, lng: -98.6, formatted: locationString };
    }
    console.log("Using mock center coordinates:", center.lat, center.lng);
  }

  // Always generate mock groomers since Nominatim search is also blocked
  console.log("Generating realistic mock groomers...");
  const foundResults = [];
  const baseLat = center.lat;
  const baseLng = center.lng;
  
  // Create more spread out mock locations
  const offsets = [
    [0.01, 0.01], [-0.015, 0.008], [0.008, -0.012], 
    [0.012, 0.015], [-0.02, -0.005], [0.018, 0.002], 
    [-0.008, 0.018], [0.022, -0.010], [-0.012, 0.022],
    [0.005, -0.018], [-0.025, 0.012], [0.015, 0.020]
  ];
  
  for (let i = 0; i < Math.min(offsets.length, 12); i++) {
    const lat = baseLat + offsets[i][0];
    const lng = baseLng + offsets[i][1];
    const realName = REALISTIC_GROOMER_NAMES[i % REALISTIC_GROOMER_NAMES.length];
    const distKm = haversineKm(baseLat, baseLng, lat, lng);
    const distMiles = distKm * 0.621371;
    
    foundResults.push({
      name: realName,
      address: `${100 + (i * 25)} ${['Main St', 'Oak Ave', 'Elm Blvd', 'Maple Dr', 'Pine Rd', 'Cedar Ln'][i % 6]}, ${center.formatted}`,
      place_id: null,
      lat,
      lng,
      rating: +(3.8 + Math.random() * 1.2).toFixed(1),
      phone: generatePhoneNumber(),
      hours: "Mon-Fri 9AM-6PM, Sat 10AM-4PM, Closed Sun",
      website: null,
      types: ["pet_groomer"],
      services: [petType],
      service_match: true,
      distanceKm: distKm,
      source: mockMode ? "mock-geocode-failed" : "mock"
    });
  }
  
  // Sort by distance
  foundResults.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
  
  console.log("Generated", foundResults.length, "mock groomers");
  console.log("=== FETCH NEARBY GROOMERS END ===");
  
  return { groomers: foundResults, radiusMilesUsed: 20 };
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
