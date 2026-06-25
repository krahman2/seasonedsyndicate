import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

// ─── Sources ──────────────────────────────────────────────────────────────
// Each source defines its CSV endpoint and a colMap array.
// colMap[canonicalIndex] = rawColumnIndex (null = column missing in this sheet).
//
// Canonical column order (10 cols):
//   0:item  1:brandCode  2:buy  3:qty  4:totalBuy
//   5:sell  6:totalSell  7:itemProfit  8:totalProfit  9:margin

const SOURCES = [
  {
    id: "tata",
    label: "TATA",
    // TATA: item, cat, buy, qty, totalBuy, sell, totalSell, itemProfit, totalProfit, margin
    csvUrl: "https://docs.google.com/spreadsheets/d/e/2PACX-1vSfn0rpxyj8sx7m2B1tilCYkURcSE3J-fiC-Y8MIiRkM2J07ZLSOzMXBBPNq_1Oh_ymweuRmOic2c-_/pub?gid=1801394538&single=true&output=csv",
    colMap: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  },
  {
    id: "leyland",
    label: "Leyland",
    // LEYLAND: item, cat, buy, qty, totalBuy, sell, [itemProfit at 6], [totalSell at 7], totalProfit, margin
    // → totalSell (canonical 6) comes from raw col 7; itemProfit (canonical 7) from raw col 6
    csvUrl: "https://docs.google.com/spreadsheets/d/e/2PACX-1vRm2Vokc7NLaN2a33G_9Ipdsy0YtQGzGMgBpzCV7HtXC1JjSby8qoZgCf3TmE6fdtnitWmA81OeLsxD/pub?gid=0&single=true&output=csv",
    colMap: [0, 1, 2, 3, 4, 5, 7, 6, 8, 9],
  },
  {
    id: "bedford",
    label: "Bedford",
    // BEDFORD: item, cat, buy, qty, totalBuy, sell, totalSell, totalProfit, margin (no itemProfit)
    // → itemProfit (canonical 7) is null; totalProfit from raw col 7; margin from raw col 8
    csvUrl: "https://docs.google.com/spreadsheets/d/e/2PACX-1vRMUxkjgTJctLnb8JgpkJtpR6ur3ncKseIg7Zm3NHCqcTYrJF2pfftUfoiNM67sgWSH8bcdoYUaOR3m/pub?gid=0&single=true&output=csv",
    colMap: [0, 1, 2, 3, 4, 5, 6, null, 7, 8],
  },
];

const PUBLISHED_URLS = {
  tata: "https://docs.google.com/spreadsheets/d/e/2PACX-1vSfn0rpxyj8sx7m2B1tilCYkURcSE3J-fiC-Y8MIiRkM2J07ZLSOzMXBBPNq_1Oh_ymweuRmOic2c-_/pubhtml",
  leyland: "https://docs.google.com/spreadsheets/d/e/2PACX-1vRm2Vokc7NLaN2a33G_9Ipdsy0YtQGzGMgBpzCV7HtXC1JjSby8qoZgCf3TmE6fdtnitWmA81OeLsxD/pubhtml",
  bedford: "https://docs.google.com/spreadsheets/d/e/2PACX-1vRMUxkjgTJctLnb8JgpkJtpR6ur3ncKseIg7Zm3NHCqcTYrJF2pfftUfoiNM67sgWSH8bcdoYUaOR3m/pubhtml",
};

const COL_LABELS = [
  "Item", "Brand / Code", "Buy", "Qty",
  "Total Buy", "Sell", "Total Sell",
  "Item Profit", "Total Profit", "Margin",
];
const NUMERIC_COLS = new Set([2, 3, 4, 5, 6, 7, 8, 9]);

// ─── localStorage helpers ─────────────────────────────────────────────────

const SEEN_KEY = "tata_seen_v2";   // v2 = source-prefixed keys
const AI_CACHE_KEY = "tata_ai_v1";

// Stable key that includes the source so names from different sheets don't collide
function seenKey(row) {
  return `${row.source}:${row.cells[0] || ""}`;
}

function getSeenItems() {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || "[]")); }
  catch { return new Set(); }
}

function saveSeenItems(dataRows) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(
      dataRows.map(seenKey).filter((k) => !k.endsWith(":"))
    ));
  } catch { /* ignore */ }
}

function getCachedClassification(name) {
  try {
    const cache = JSON.parse(localStorage.getItem(AI_CACHE_KEY) || "{}");
    return cache[name] ?? null;
  } catch { return null; }
}

function saveCachedClassification(name, result) {
  try {
    const cache = JSON.parse(localStorage.getItem(AI_CACHE_KEY) || "{}");
    cache[name] = result;
    localStorage.setItem(AI_CACHE_KEY, JSON.stringify(cache));
  } catch { /* ignore */ }
}

// ─── AI classification ────────────────────────────────────────────────────

async function callClassifyAPI(itemName, brandCode) {
  const resp = await fetch("/api/classify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ itemName, brandCode }),
  });
  if (!resp.ok) throw new Error(`classify API returned ${resp.status}`);
  return resp.json();
}

async function classifyNewOtherItems(rows) {
  const candidates = rows.filter(
    (r) => r.type === "data" && r.isNew && r.group === "Other" && r.cells[0]
  );
  if (!candidates.length) return rows;

  const resolved = {};
  for (const row of candidates) {
    const name = row.cells[0];
    const cached = getCachedClassification(name);
    if (cached) { resolved[name] = cached; continue; }
    try {
      const result = await callClassifyAPI(name, row.cells[1] ?? "");
      saveCachedClassification(name, result);
      resolved[name] = result;
    } catch { /* leave as Other */ }
  }

  if (!Object.keys(resolved).length) return rows;
  return rows.map((row) => {
    if (row.type !== "data") return row;
    const r = resolved[row.cells[0]];
    if (!r) return row;
    return {
      ...row,
      group: r.category || row.group,
      aiCleanName: r.cleanName && r.cleanName !== row.cells[0] ? r.cleanName : null,
    };
  });
}

// ─── Category navigator ───────────────────────────────────────────────────

function CategoryNav({ groups, current, onChange, itemCount }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onOut(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onOut);
    return () => document.removeEventListener("mousedown", onOut);
  }, []);

  const all = ["all", ...groups];
  const idx = all.indexOf(current);
  function prev() { onChange(all[(idx - 1 + all.length) % all.length]); setOpen(false); }
  function next() { onChange(all[(idx + 1) % all.length]); setOpen(false); }
  const label = current === "all" ? "All Categories" : current;

  return (
    <div className="category-nav" ref={ref}>
      <button className="nav-arrow" onClick={prev} title="Previous">‹</button>
      <div className="nav-center">
        <button className={"nav-label" + (open ? " open" : "")} onClick={() => setOpen((v) => !v)}>
          <span className="nav-label-text">{label}</span>
          <span className="nav-meta">
            <span className="nav-count">{itemCount}</span>
            <span className="nav-chevron">{open ? "▲" : "▼"}</span>
          </span>
        </button>
        {open && (
          <div className="nav-dropdown">
            {all.map((opt) => (
              <button
                key={opt}
                className={"nav-option" + (opt === current ? " active" : "")}
                onClick={() => { onChange(opt); setOpen(false); }}
              >
                {opt === "all" ? "All Categories" : opt}
              </button>
            ))}
          </div>
        )}
      </div>
      <button className="nav-arrow" onClick={next} title="Next">›</button>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────

function App() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [classifying, setClassifying] = useState(false);
  const [error, setError] = useState("");
  const [sourceErrors, setSourceErrors] = useState([]);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("all");
  const [manufacturer, setManufacturer] = useState("all");

  // ── PWA install prompt ─────────────────────────────────────────────────
  const [installPrompt, setInstallPrompt] = useState(null);
  const [installState, setInstallState] = useState("idle"); // idle | done
  const [iosHintOpen, setIosHintOpen] = useState(false);
  const iosHintRef = useRef(null);

  const isIOS = /ipad|iphone|ipod/i.test(navigator.userAgent) && !window.MSStream;
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches
    || window.navigator.standalone === true;

  useEffect(() => {
    if (isStandalone) { setInstallState("done"); return; }

    function onPrompt(e) {
      e.preventDefault();
      setInstallPrompt(e);
    }
    function onInstalled() {
      setInstallState("done");
      setInstallPrompt(null);
    }

    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, [isStandalone]);

  // Close iOS hint on outside click
  useEffect(() => {
    if (!iosHintOpen) return;
    function onOut(e) {
      if (iosHintRef.current && !iosHintRef.current.contains(e.target)) setIosHintOpen(false);
    }
    document.addEventListener("mousedown", onOut);
    return () => document.removeEventListener("mousedown", onOut);
  }, [iosHintOpen]);

  async function handleInstall() {
    if (installPrompt) {
      installPrompt.prompt();
      const { outcome } = await installPrompt.userChoice;
      if (outcome === "accepted") {
        setInstallState("done");
        setInstallPrompt(null);
      }
    } else {
      // iOS or desktop: show the instructions tooltip
      setIosHintOpen((v) => !v);
    }
  }

  // Show install button unless the app is already running as a standalone PWA
  const showInstallBtn = installState !== "done";

  async function load() {
    setLoading(true);
    setError("");
    setSourceErrors([]);
    try {
      // Fetch all three sheets in parallel
      const results = await Promise.allSettled(
        SOURCES.map((src) => fetchAndProcessSource(src))
      );

      const allRows = [];
      const errs = [];
      results.forEach((r, i) => {
        if (r.status === "fulfilled") allRows.push(...r.value);
        else errs.push(`${SOURCES[i].label}: ${r.reason?.message ?? "failed"}`);
      });

      if (errs.length) setSourceErrors(errs);
      if (!allRows.length) throw new Error("No data loaded from any sheet.");

      const seenBefore = getSeenItems();
      const isFirstLoad = seenBefore.size === 0;

      let processed = allRows.map((row) => ({
        ...row,
        isNew: !isFirstLoad && row.type === "data" && !seenBefore.has(seenKey(row)),
      }));

      setRows(processed);
      setLastUpdated(new Date());
      setLoading(false);

      const newOtherCount = processed.filter((r) => r.isNew && r.group === "Other").length;
      if (newOtherCount > 0) {
        setClassifying(true);
        try {
          const classified = await classifyNewOtherItems(processed);
          saveSeenItems(classified.filter((r) => r.type === "data"));
          setRows(classified);
        } catch {
          saveSeenItems(processed.filter((r) => r.type === "data"));
        } finally {
          setClassifying(false);
        }
      } else {
        saveSeenItems(processed.filter((r) => r.type === "data"));
      }
    } catch (err) {
      setError(err.message || "Could not load sheets.");
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const dataRows = useMemo(() => rows.filter((r) => r.type === "data"), [rows]);

  const groups = useMemo(() => {
    const pool = manufacturer === "all"
      ? dataRows
      : dataRows.filter((r) => r.source === manufacturer);
    const seen = new Set();
    pool.forEach((r) => { if (r.group) seen.add(r.group); });
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [dataRows, manufacturer]);

  const newCount = useMemo(() => dataRows.filter((r) => r.isNew).length, [dataRows]);

  const isFiltering = query.trim() !== "" || group !== "all" || manufacturer !== "all";

  // Sections are hidden only when a specific category or search is active.
  // Switching manufacturer alone should still show the section dividers.
  const hideSections = query.trim() !== "" || group !== "all";

  const visible = useMemo(() => {
    const search = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (row.type === "section") return !hideSections;
      const matchMfr = manufacturer === "all" || row.source === manufacturer;
      const matchGroup = group === "all" || row.group === group;
      const matchSearch = !search || row.cells.some((c) => c.toLowerCase().includes(search));
      return matchMfr && matchGroup && matchSearch;
    });
  }, [rows, query, group, manufacturer, isFiltering]);

  const visibleDataRows = useMemo(() => visible.filter((r) => r.type === "data"), [visible]);

  const summary = useMemo(() => computeSummary(visibleDataRows), [visibleDataRows]);
  const tableTotals = useMemo(() => computeTableTotals(visibleDataRows), [visibleDataRows]);

  // Group visible rows into sections. Empty sections are automatically dropped
  // because we only push a group when it has at least one data row.
  const sectionGroups = useMemo(() => {
    if (hideSections) {
      const flat = visible.filter((r) => r.type === "data");
      return flat.length ? [{ label: null, rows: flat }] : [];
    }
    const groups = [];
    let label = null;
    let rows = [];
    for (const row of visible) {
      if (row.type === "section") {
        if (rows.length) { groups.push({ label, rows }); rows = []; }
        label = row.group || row.cells[0];
      } else if (row.type === "data") {
        rows.push(row);
      }
    }
    if (rows.length) groups.push({ label, rows });
    return groups;
  }, [visible, hideSections]);

  // Per-source item counts for the manufacturer tabs
  const sourceCounts = useMemo(() => {
    const c = { all: dataRows.length };
    SOURCES.forEach((s) => { c[s.id] = dataRows.filter((r) => r.source === s.id).length; });
    return c;
  }, [dataRows]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <div>
            <h1>
              {manufacturer === "all"
                ? "Inventory"
                : SOURCES.find((s) => s.id === manufacturer)?.label ?? "Inventory"}
              {newCount > 0 && <span className="new-count-badge">{newCount} new</span>}
            </h1>
            {lastUpdated && (
              <p className="last-updated">
                {classifying
                  ? "Classifying new items…"
                  : `Updated ${lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
              </p>
            )}
          </div>
        </div>
        <div className="topbar-actions">
          {showInstallBtn && (
            <div className="install-wrap" ref={iosHintRef}>
              <button className="btn-install" onClick={handleInstall} title="Add to Home Screen">
                ↓ Install
              </button>
              {iosHintOpen && (
                <div className="install-hint">
                  {isIOS
                    ? <p>Tap <strong>Share</strong> <span className="hint-share-icon">⎋</span> at the bottom of Safari, then <strong>Add to Home Screen</strong>.</p>
                    : <p>In Chrome, tap the <strong>⋮ menu</strong> and choose <strong>Add to Home Screen</strong> or <strong>Install app</strong>.</p>
                  }
                </div>
              )}
            </div>
          )}
          <button className="btn-refresh" onClick={load} disabled={loading || classifying}>
            {loading ? "Loading…" : classifying ? "Classifying…" : "↻ Refresh"}
          </button>
        </div>
      </header>

      {error && (
        <div className="error-bar">
          <span>⚠ {error}</span>
        </div>
      )}
      {sourceErrors.length > 0 && (
        <div className="warn-bar">
          ⚠ Partial load — {sourceErrors.join(" · ")}
        </div>
      )}

      <div className="summary-grid">
        {summary.map((s) => (
          <div className="summary-card" key={s.label}>
            <span className="summary-label">{s.label}</span>
            <strong className="summary-value">{s.value}</strong>
          </div>
        ))}
      </div>

      <div className="controls">
        {/* Manufacturer tabs */}
        <div className="mfr-tabs">
          <button
            className={"mfr-tab" + (manufacturer === "all" ? " active" : "")}
            onClick={() => { setManufacturer("all"); setGroup("all"); }}
          >
            All
            <span className="mfr-count">{sourceCounts.all}</span>
          </button>
          {SOURCES.map((s) => (
            <button
              key={s.id}
              className={"mfr-tab mfr-" + s.id + (manufacturer === s.id ? " active" : "")}
              onClick={() => { setManufacturer(s.id); setGroup("all"); }}
            >
              {s.label}
              <span className="mfr-count">{sourceCounts[s.id] ?? 0}</span>
            </button>
          ))}
        </div>

        {/* Search + category */}
        <div className="search-nav-row">
          <input
            type="search"
            placeholder="Search items…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="input-search"
          />
          <CategoryNav
            groups={groups}
            current={group}
            onChange={setGroup}
            itemCount={visibleDataRows.length}
          />
        </div>
      </div>

      {/* ── Section groups ── */}
      {loading && rows.length === 0 ? (
        <div className="table-wrap">
          <div className="placeholder-state">Loading sheets…</div>
        </div>
      ) : sectionGroups.length === 0 ? (
        <div className="table-wrap">
          <div className="placeholder-state">No items match your filters.</div>
        </div>
      ) : (
        <>
          {sectionGroups.map((grp, gi) => (
            <div key={`${manufacturer}|${group}|${query}|${gi}`} className="section-group">
              {grp.label && (
                <p className="section-group-label">{grp.label}</p>
              )}
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      {COL_LABELS.map((lbl, i) => (
                        <th key={i} className={NUMERIC_COLS.has(i) ? "num" : ""}>{lbl}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {grp.rows.map((row, ri) => (
                      <tr key={ri} className={row.isNew ? "row-new" : ""}>
                        {COL_LABELS.map((_, ci) => (
                          <td key={ci} className={NUMERIC_COLS.has(ci) ? "num" : ""}>
                            {ci === 0 ? (
                              <span className="item-cell">
                                {manufacturer === "all" && (
                                  <span className={`src-chip src-${row.source}`}>{row.source}</span>
                                )}
                                {row.cells[0]}
                                {row.isNew && <span className="new-badge">New</span>}
                                {row.aiCleanName && (
                                  <span className="clean-name-hint" title={`AI suggested: ${row.aiCleanName}`}>
                                    {row.aiCleanName}
                                  </span>
                                )}
                              </span>
                            ) : (
                              row.cells[ci] ?? ""
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          {/* Totals summary card */}
          {visibleDataRows.length > 0 && (
            <div className="totals-card">
              <span className="totals-card-label">
                {manufacturer !== "all"
                  ? SOURCES.find((s) => s.id === manufacturer)?.label
                  : "All"}
                {group !== "all" ? ` · ${group}` : ""}
              </span>
              <div className="totals-values">
                <div className="totals-item">
                  <span>Total Qty</span>
                  <strong>{tableTotals.qty > 0 ? tableTotals.qty.toLocaleString() : "—"}</strong>
                </div>
                <div className="totals-item">
                  <span>Total Buy</span>
                  <strong>{tableTotals.totalBuy > 0 ? fmt(tableTotals.totalBuy) : "—"}</strong>
                </div>
                <div className="totals-item">
                  <span>Total Sell</span>
                  <strong>{tableTotals.revenue > 0 ? fmt(tableTotals.revenue) : "—"}</strong>
                </div>
                <div className="totals-item">
                  <span>Profit</span>
                  <strong>{tableTotals.totalProfit > 0 ? fmt(tableTotals.totalProfit) : "—"}</strong>
                </div>
                {tableTotals.avgMargin !== null && (
                  <div className="totals-item">
                    <span>Avg Margin</span>
                    <strong>{tableTotals.avgMargin.toFixed(1)}%</strong>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}

      <footer className="footer">
        <span>
          {isFiltering
            ? `${visibleDataRows.length} of ${dataRows.length} items`
            : `${dataRows.length} items across ${SOURCES.length} sheets`}
        </span>
        <span className="footer-sep">·</span>
        {SOURCES.map((s, i) => (
          <React.Fragment key={s.id}>
            <a href={PUBLISHED_URLS[s.id]} target="_blank" rel="noreferrer">{s.label}</a>
            {i < SOURCES.length - 1 && <span className="footer-sep">·</span>}
          </React.Fragment>
        ))}
      </footer>
    </div>
  );
}

// ─── Data fetching & parsing ───────────────────────────────────────────────

async function fetchAndProcessSource(source) {
  const resp = await fetch(`${source.csvUrl}&t=${Date.now()}`);
  if (!resp.ok) throw new Error(`returned ${resp.status}`);
  const text = await resp.text();
  return processRecords(parseCsv(text), source);
}

function normalizeRow(rawCells, colMap) {
  return colMap.map((idx) => {
    if (idx === null) return "";
    const v = (rawCells[idx] ?? "").trim();
    return v === "#DIV/0!" || v === "#N/A" || v === "#VALUE!" ? "—" : v;
  });
}

function processRecords(records, source) {
  if (records.length < 2) return [];

  let currentSection = null;
  const result = [];

  for (const record of records.slice(1)) {
    const cells = normalizeRow(record, source.colMap);

    if (cells.every((c) => c === "")) continue;

    const isSection = cells[2] === ""; // buy column is empty → section/header row

    if (isSection) {
      const rawLabel = (cells[0] || cells[1] || "").trim();
      if (!rawLabel) continue;
      const cleanLabel = cleanSectionLabel(rawLabel);
      if (cleanLabel !== null) {
        currentSection = cleanLabel;
        result.push({ type: "section", cells, group: cleanLabel, source: source.id });
      }
    } else {
      const resolvedGroup =
        cleanCategoryLabel(cells[1]) ||
        deriveGroupFromItemName(cells[0]) ||
        currentSection ||
        "Other";
      result.push({ type: "data", cells, group: resolvedGroup, source: source.id });
    }
  }

  return result;
}

// ─── Group resolution ─────────────────────────────────────────────────────

function cleanSectionLabel(raw) {
  const t = raw.toLowerCase().replace(/\s+/g, " ").trim();
  // Marker rows — suppress the separator
  if (/^\d{4}$/.test(t) || t === "china" || t === "target") return null;
  if (t.includes("clutch parts")) return "Clutch & Pressure";
  if (t.includes("propell")) return "Propeller Shaft";
  if (t.includes("power steering") || t.includes("steering pump")) return "Power Steering";
  if (t.includes("steering parts") || t.includes("steering kit")) return "Steering & Suspension";
  if (t.includes("brake lining")) return "Brake Lining";
  if (t.includes("pipe")) return "Pipes";
  if (t.includes("filter")) return "Filters";
  if (t.includes("compressor") || t.includes("mounting")) return "Compressor & Mounting";
  if (t.includes("center bearing") || t.includes("bearing rubber")) return "Bearings";
  if (t === "grease gun" || t.includes("grease gun")) return "Grease Gun";
  if (t.includes("washer") || (t.includes("pin") && t.includes("bolt"))) return "Washers & Hardware";
  if (t.includes("center bolt")) return "Washers & Hardware";
  if (t.includes("finger kit")) return "Finger Kits";
  if (t.includes("gear parts") || t.includes("gear box")) return "Gear Box Parts";
  if (t === "others" || t === "other") return "Other";
  return raw.trim();
}

function cleanCategoryLabel(raw) {
  const t = (raw ?? "").trim().toLowerCase();
  if (!t) return null;
  if (t === "propeller shaft" || t === "propellor shaft") return "Propeller Shaft";
  // Handle both "Steering / Suspension" (TATA) and "Steering/Suspension" (Leyland)
  if ((t.includes("steering") && t.includes("suspension")) || t === "steering") return "Steering & Suspension";
  if (t === "gears") return "Gears";
  if (t === "clutch & pressure") return "Clutch & Pressure";
  if (t === "bearings") return "Bearings";
  if (t === "diff. cover") return "Differential Cover";
  if (t === "water pump") return "Water Pump";
  if (t.includes("tools") || t.includes("spanner") || t.includes("hardware")) return "Tools & Hardware";
  if (t === "pipes") return "Pipes";
  if (t.includes("misc") || t === "others / miscellaneous" || t === "others") return "Other";
  if (t.includes("filter")) return "Filters";
  if (t.includes("rubber items") || t.includes("mounting")) return "Compressor & Mounting";
  if (t.includes("brake") && t.includes("lining")) return "Brake Lining";
  return null;
}

function deriveGroupFromItemName(name) {
  const t = name.toLowerCase();
  if (
    t.includes("cross holder") || t.includes("center flange") ||
    t.includes("gear box flange") || t.includes("half yoke") ||
    t.includes("front teeth") || t.includes("yoke teeth") || t.includes("yoke inter") ||
    t.includes("pinion flange") || t.includes("pinion coupling") ||
    /\bcross\b/.test(t)
  ) return "Propeller Shaft";
  if (t.includes("clutch booster")) return "Clutch Booster";
  if (
    t.includes("brake adjuster") || t.includes("break adjuster") ||
    t.includes("brake chamber") || t.includes("hand brake") ||
    t.includes("brake hose") || t.includes("break hose") ||
    t.includes("protection valve") || t.includes("trailer control") ||
    t.includes("brake punja") || t.includes("diaform")
  ) return "Brake System";
  if (t.includes("brake lining")) return "Brake Lining";
  if (t.includes("fly wheel") || t.includes("flywheel")) return "Gears";
  if (t.includes("bearing") || /^[0-9]{5,6}\s*[=]/.test(t.trim())) return "Bearings";
  if (t.includes("diff cover") || t.includes("diff.")) return "Differential Cover";
  if (t.includes("water pump")) return "Water Pump";
  if (
    t.includes("worm") || t.includes("pitman") || t.includes("tie rod") ||
    t.includes("stg yoke") || t.includes("king pin") || t.includes("gear liver") ||
    t.includes("stg golly") || t.includes("stg cross")
  ) return "Steering & Suspension";
  if (
    t.includes("pressure plate") || t.includes("back plate") ||
    t.includes("withdrawl plate") || t.includes("clutch pad") ||
    t.includes("clutch plate") || t.includes("c/plate")
  ) return "Clutch & Pressure";
  if (t.includes("grease gun")) return "Grease Gun";
  if (t.includes("spanner")) return "Tools & Hardware";
  if (t.includes("belt tensioner") || t.includes("air compressor") || t.includes("compressor kit")) return "Compressor & Mounting";
  if (t.includes("filter")) return "Filters";
  if (t.includes("oil seal") || t.includes("head gasket") || t.includes("gasket kit")) return "Seals & Gaskets";
  if (t.includes("gear") && !t.includes("grease")) return "Gear Box Parts";
  return null;
}

// ─── CSV parser ───────────────────────────────────────────────────────────

function parseCsv(text) {
  const records = [];
  let cell = "", row = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (ch === '"' && next === '"' && inQuotes) { cell += '"'; i++; }
    else if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === "," && !inQuotes) { row.push(cell); cell = ""; }
    else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cell); records.push(row); row = []; cell = "";
    } else { cell += ch; }
  }
  if (cell || row.length) { row.push(cell); records.push(row); }
  return records;
}

// ─── Summary & totals ─────────────────────────────────────────────────────

function computeSummary(rows) {
  const qty      = rows.reduce((s, r) => s + (parseNum(r.cells[3]) ?? 0), 0);
  const totalBuy  = rows.reduce((s, r) => s + (parseNum(r.cells[4]) ?? 0), 0);
  const totalSell = rows.reduce((s, r) => s + (parseNum(r.cells[6]) ?? 0), 0);
  return [
    { label: "Items",      value: rows.length.toLocaleString() },
    { label: "Total Qty",  value: qty.toLocaleString() },
    { label: "Total Buy",  value: fmt(totalBuy) },
    { label: "Total Sell", value: fmt(totalSell) },
  ];
}

function computeTableTotals(rows) {
  const qty         = rows.reduce((s, r) => s + (parseNum(r.cells[3]) ?? 0), 0);
  const totalBuy    = rows.reduce((s, r) => s + (parseNum(r.cells[4]) ?? 0), 0);
  const revenue     = rows.reduce((s, r) => s + (parseNum(r.cells[6]) ?? 0), 0);
  const totalProfit = rows.reduce((s, r) => s + (parseNum(r.cells[8]) ?? 0), 0);

  const validMargins = rows
    .map((r) => parseNum(r.cells[9]))
    .filter((n) => n !== null && n >= 0);
  const avgMargin =
    validMargins.length > 0
      ? validMargins.reduce((s, n) => s + n, 0) / validMargins.length
      : null;

  return { qty, totalBuy, revenue, totalProfit, avgMargin };
}

function parseNum(value) {
  const v = String(value ?? "").trim();
  if (!v || v === "—") return null;
  const cleaned = v.replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function fmt(value) {
  return "৳" + Math.round(value).toLocaleString("en-US");
}

createRoot(document.getElementById("root")).render(<App />);
