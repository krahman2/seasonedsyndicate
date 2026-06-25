// Vercel serverless function — proxies classification requests to Anthropic.
// The API key stays server-side and never reaches the browser.

const KNOWN_CATEGORIES = [
  "Propeller Shaft",
  "Steering & Suspension",
  "Gears",
  "Clutch & Pressure",
  "Clutch Booster",
  "Brake System",
  "Brake Lining",
  "Power Steering",
  "Pipes",
  "Filters",
  "Compressor & Mounting",
  "Bearings",
  "Grease Gun",
  "Washers & Hardware",
  "Finger Kits",
  "Water Pump",
  "Gear Box Parts",
  "Tools & Hardware",
  "Differential Cover",
];

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { itemName, brandCode } = req.body ?? {};
  if (!itemName) return res.status(400).json({ error: "itemName is required" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  const categoriesList = KNOWN_CATEGORIES.join(", ");

  const prompt = `You are an inventory assistant for a commercial truck parts dealer in Bangladesh (sells TATA truck parts). Your job is to categorize a new inventory item and clean up its name.

Existing categories: ${categoriesList}

New item:
- Raw name: "${itemName}"
- Brand/code column: "${brandCode || ""}"

Tasks:
1. Assign this item to the most appropriate category from the list above. If the item is genuinely something new that doesn't fit any existing category, suggest a short new category name (2-4 words, title case).
2. Provide a clean, properly formatted version of the item name: expand abbreviations (hldr→Holder, stg→Steering, brk→Brake, assy→Assembly, frt→Front, rr→Rear, O/M→O/M, TC→TC, N/M→N/M), fix capitalization, keep model numbers as-is.

Respond with a JSON object only — no explanation, no markdown, just the JSON:
{"category": "...", "cleanName": "..."}`;

  try {
    const anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-3-5-haiku-20241022",
        max_tokens: 120,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!anthropicResp.ok) {
      const errText = await anthropicResp.text();
      console.error("Anthropic error:", errText);
      return res.json({ category: "Other", cleanName: itemName });
    }

    const data = await anthropicResp.json();
    const rawText = data.content?.[0]?.text ?? "";

    // Extract JSON even if Claude wraps it in backticks
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");

    const result = JSON.parse(jsonMatch[0]);
    return res.json({
      category: result.category || "Other",
      cleanName: result.cleanName || itemName,
    });
  } catch (err) {
    console.error("classify error:", err.message);
    return res.json({ category: "Other", cleanName: itemName });
  }
};
