#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Skipster VDP Builder — with CarVector enrichment
//
// Usage:
//   node build.js                      # full build (requires CARVECTOR_API_KEY env var)
//   CARVECTOR_API_KEY=cv_xxx node build.js
//   node build.js --no-api             # build without CarVector calls (offline/test)
//
// Outputs:
//   /inventory/{VIN}.html              — one VDP per vehicle
//   /facebook_catalog.csv             — Facebook catalog feed copy
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');

// ── CONFIG ───────────────────────────────────────────────────────────────────

const API_KEY   = process.env.CARVECTOR_API_KEY || '';
const API_BASE  = 'https://api.carvector.io/v1';
const SKIP_API  = process.argv.includes('--no-api') || !API_KEY;

const DATA_PATH     = path.join(__dirname, 'inventory.csv');
const TEMPLATE_PATH = path.join(__dirname, 'src', 'vdp-template.html');
const OUT_DIR       = path.join(__dirname, 'inventory');

if (SKIP_API) {
  console.log('⚡ Running without CarVector — set CARVECTOR_API_KEY to enable spec enrichment.\n');
} else {
  console.log('🔑 CarVector API key found — specs & recall data will be fetched.\n');
}

// ── CSV PARSER ───────────────────────────────────────────────────────────────
// Handles quoted fields (fields containing commas).

function parseCSV(text) {
  const lines = text.trim().split('\n').filter(l => l.trim());
  const headers = splitCSVRow(lines[0]);
  return lines.slice(1).map(line => {
    const values = splitCSVRow(line);
    const row = {};
    headers.forEach((h, i) => { row[h.trim()] = (values[i] || '').trim(); });
    return row;
  });
}

function splitCSVRow(line) {
  const cols = [];
  let cur = '', inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { cols.push(cur); cur = ''; }
    else { cur += ch; }
  }
  cols.push(cur);
  return cols;
}

// ── MAKE / MODEL EXTRACTION ───────────────────────────────────────────────────
// The CSV's `make` and `model` columns can be malformed (e.g. "Land" / "Rover Defender...").
// We normalise them here and also extract a short model name for the CarVector search.

const MULTI_WORD_MAKES = ['Land Rover', 'Alfa Romeo', 'Aston Martin', 'Rolls-Royce'];

function normaliseMake(row) {
  const rawMake  = row['make']  || '';
  const rawModel = row['model'] || '';

  // Fix split "Land" / "Rover ..." issue
  if (rawMake === 'Land' && rawModel.toLowerCase().startsWith('rover')) {
    return 'Land Rover';
  }
  return rawMake;
}

function normaliseModel(row) {
  const rawMake  = row['make']  || '';
  const rawModel = row['model'] || '';

  if (rawMake === 'Land' && rawModel.toLowerCase().startsWith('rover')) {
    // "Rover Defender 130 X-Dynamic SE" → "Defender"
    return rawModel.replace(/^rover\s+/i, '').split(' ')[0];
  }

  // For most models, take just the base model word(s) before the trim level.
  // e.g. "Corvette Stingray 1LT" → "Corvette"
  //      "Encore GX Preferred"  → "Encore GX"   (2 words because "GX" is the variant)
  //      "Yukon XL Denali"      → "Yukon XL"
  //      "SL-Class SL 55 AMG..."→ "SL-Class"
  return rawModel.split(' ').slice(0, 2).join(' ').replace(/[®™]/g, '');
}

function extractYear(row) {
  const title = row['title'] || '';
  const m = title.match(/^(\d{4})/);
  return m ? parseInt(m[1]) : null;
}

// ── CARVECTOR API ─────────────────────────────────────────────────────────────

async function apiGet(endpoint) {
  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.warn(`    ⚠️  CarVector ${res.status} → ${endpoint}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`    ⚠️  CarVector error: ${err.message}`);
    return null;
  }
}

async function fetchVehicleSpecs(year, make, model) {
  if (SKIP_API || !year || !make || !model) return null;

  // 1. Search for vehicle
  const qs = `year=${year}&make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}`;
  const searchResult = await apiGet(`/vehicles?${qs}`);

  // Normalise response — API may return array or { data: [...] }
  let vehicleId = null;
  if (Array.isArray(searchResult) && searchResult.length > 0) {
    vehicleId = searchResult[0].id;
  } else if (searchResult?.data?.length > 0) {
    vehicleId = searchResult.data[0].id;
  } else if (searchResult?.id) {
    vehicleId = searchResult.id;
  }

  // 1b. If no match, retry with just the first word of model
  if (!vehicleId) {
    const shortModel = model.split(' ')[0];
    if (shortModel !== model) {
      const qs2 = `year=${year}&make=${encodeURIComponent(make)}&model=${encodeURIComponent(shortModel)}`;
      const r2  = await apiGet(`/vehicles?${qs2}`);
      if (Array.isArray(r2) && r2.length > 0) vehicleId = r2[0].id;
      else if (r2?.data?.length > 0)          vehicleId = r2.data[0].id;
      else if (r2?.id)                        vehicleId = r2.id;
    }
  }

  if (!vehicleId) return null;

  // 2. Fetch full detail + recalls in parallel
  const [detail, recallsRes] = await Promise.all([
    apiGet(`/vehicles/${vehicleId}`),
    apiGet(`/vehicles/${vehicleId}/recalls`),
  ]);

  const recalls = Array.isArray(recallsRes)
    ? recallsRes
    : (recallsRes?.data || []);

  return detail ? { ...detail, recalls } : null;
}

// ── HTML GENERATORS ───────────────────────────────────────────────────────────

function buildSpecsCard(specs) {
  if (!specs) {
    return `
      <div class="bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
        <h2 class="heading text-lg mb-2 text-zinc-200">Powertrain &amp; Specs</h2>
        <p class="text-zinc-500 text-sm">Spec data unavailable for this vehicle.</p>
      </div>`;
  }

  const hp           = specs.horsepower    ? `${specs.horsepower} HP`    : '—';
  const displacement = specs.displacement_l ? `${specs.displacement_l}L` : '—';
  const transmission = specs.transmission  || '—';
  const driveType    = formatDriveType(specs.drive_type || '—');
  const body         = specs.body_style || specs.body || '—';

  const rows = [
    ['Engine',       displacement],
    ['Horsepower',   hp],
    ['Transmission', transmission],
    ['Drive Type',   driveType],
    ['Body Style',   body],
  ].filter(([,v]) => v && v !== '—');

  const rowsHTML = rows.map(([label, value]) => `
    <div class="spec-row">
      <span class="text-zinc-400 text-sm">${label}</span>
      <span class="text-sm font-semibold">${value}</span>
    </div>`).join('');

  // Hero stat badges (top of card)
  const badges = [
    displacement !== '—' && `<div class="bg-zinc-800 rounded-xl px-4 py-3 text-center"><div class="heading text-xl">${displacement}</div><div class="text-[10px] uppercase tracking-widest text-zinc-500 mt-0.5">Engine</div></div>`,
    hp !== '—'           && `<div class="bg-zinc-800 rounded-xl px-4 py-3 text-center"><div class="heading text-xl">${hp}</div><div class="text-[10px] uppercase tracking-widest text-zinc-500 mt-0.5">Power</div></div>`,
    driveType !== '—'    && `<div class="bg-zinc-800 rounded-xl px-4 py-3 text-center"><div class="heading text-xl">${driveType}</div><div class="text-[10px] uppercase tracking-widest text-zinc-500 mt-0.5">Drive</div></div>`,
  ].filter(Boolean).join('');

  return `
    <div class="bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
      <div class="flex items-center justify-between mb-5">
        <h2 class="heading text-lg text-zinc-200">Powertrain &amp; Specs</h2>
        <span class="text-[10px] uppercase tracking-widest text-zinc-500 bg-zinc-800 px-2 py-1 rounded-full">CarVector</span>
      </div>
      <div class="grid grid-cols-3 gap-3 mb-5">${badges}</div>
      <div>${rowsHTML}</div>
    </div>`;
}

function buildRecallCard(specs) {
  const count = specs?.recall_count ?? specs?.recalls?.length ?? null;

  if (count === null) {
    // No API data — show neutral placeholder
    return `
      <div class="bg-zinc-900 border border-zinc-800 rounded-2xl p-6">
        <h2 class="heading text-lg mb-2 text-zinc-200">Federal Safety Record</h2>
        <p class="text-zinc-500 text-sm">Recall data unavailable. Run build with CarVector API key to enable.</p>
      </div>`;
  }

  if (count === 0) {
    return `
      <div class="recall-clean rounded-2xl p-6">
        <div class="flex items-center gap-x-3 mb-3">
          <div class="w-10 h-10 bg-emerald-500/20 rounded-full flex items-center justify-center flex-shrink-0">
            <i class="fa-solid fa-shield-check text-emerald-400 text-lg"></i>
          </div>
          <div>
            <div class="heading text-base text-emerald-300">No Open Federal Recalls</div>
            <div class="text-emerald-700 text-xs mt-0.5">NHTSA database · Verified</div>
          </div>
        </div>
        <p class="text-emerald-800 text-xs">
          This vehicle has zero open federal recall campaigns on record.
          Most dealer websites don't surface this — we do.
        </p>
      </div>`;
  }

  // Has recalls
  const recallList = (specs?.recalls || []).map(r => {
    const title   = r.campaign_title || r.title   || 'Federal Recall Campaign';
    const summary = r.description    || r.summary || r.remedy || '';
    const date    = r.date           || r.reported_at || '';
    return `
      <div class="bg-amber-950/40 border border-amber-800/40 rounded-xl p-3 mb-2">
        <div class="text-amber-300 text-sm font-semibold">${title}</div>
        ${date ? `<div class="text-amber-700 text-[10px] mb-1">${date}</div>` : ''}
        ${summary ? `<div class="text-amber-500/80 text-xs">${summary}</div>` : ''}
      </div>`;
  }).join('');

  return `
    <div class="recall-warn rounded-2xl p-6">
      <div class="flex items-center gap-x-3 mb-3">
        <div class="w-10 h-10 bg-amber-500/20 rounded-full flex items-center justify-center flex-shrink-0">
          <i class="fa-solid fa-triangle-exclamation text-amber-400 text-lg"></i>
        </div>
        <div>
          <div class="heading text-base text-amber-300">${count} Federal Recall${count !== 1 ? 's' : ''}</div>
          <div class="text-amber-700 text-xs mt-0.5">NHTSA database · Verify status before purchase</div>
        </div>
      </div>
      ${recallList || '<p class="text-amber-700 text-xs">Check NHTSA.gov for full campaign details.</p>'}
    </div>`;
}

function formatDriveType(raw) {
  const map = {
    '4x2': 'RWD', '4x4': '4WD', 'fwd': 'FWD', 'rwd': 'RWD',
    'awd': 'AWD', '4wd': '4WD', 'awd/4wd': 'AWD'
  };
  return map[raw.toLowerCase()] || raw.toUpperCase();
}

function formatPrice(raw) {
  // raw might be "20237.00 USD" or "20237"
  const num = parseFloat(raw.replace(/[^0-9.]/g, ''));
  return isNaN(num) ? '0' : Math.round(num).toLocaleString('en-US');
}

function encodeForSMS(text) {
  return encodeURIComponent(text);
}

// ── TEMPLATE FILL ─────────────────────────────────────────────────────────────

function fillTemplate(template, row, specs) {
  const year   = String(extractYear(row) || row['year'] || '');
  const price  = formatPrice(row['price'] || '0');
  const miles  = parseInt(row['mileage.value'] || '0').toLocaleString('en-US');
  const vin    = row['vehicle_id'] || row['vin'] || '';
  const title  = row['title']  || '';
  const image  = row['image[0].url'] || `${vin}.jpg`;
  const color  = row['exterior_color'] || '—';
  const stock  = row['stock_number']   || '—';
  const dealer = row['dealer_name']    || '—';

  return template
    .replace(/{{YEAR_MAKE_MODEL}}/g,         title)
    .replace(/{{YEAR_MAKE_MODEL_ENCODED}}/g, encodeForSMS(title))
    .replace(/{{VIN}}/g,                     vin)
    .replace(/{{PRICE}}/g,                   price)
    .replace(/{{MILEAGE}}/g,                 miles)
    .replace(/{{IMAGE_URL}}/g,               image)
    .replace(/{{EXTERIOR_COLOR}}/g,          color)
    .replace(/{{STOCK_NUMBER}}/g,            stock)
    .replace(/{{DEALER_NAME}}/g,             dealer)
    .replace(/{{YEAR}}/g,                    year)
    .replace(/{{SPECS_CARD_HTML}}/g,         buildSpecsCard(specs))
    .replace(/{{RECALL_CARD_HTML}}/g,        buildRecallCard(specs));
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  // Validate inputs
  if (!fs.existsSync(DATA_PATH)) {
    console.error('❌ inventory.csv not found. Exiting.');
    process.exit(1);
  }
  if (!fs.existsSync(TEMPLATE_PATH)) {
    console.error('❌ src/vdp-template.html not found. Exiting.');
    process.exit(1);
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const template = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
  const vehicles = parseCSV(fs.readFileSync(DATA_PATH, 'utf-8'));

  console.log(`📦 Building ${vehicles.length} VDP pages...\n`);

  let built = 0, skipped = 0, apiHits = 0;

  for (const row of vehicles) {
    const vin = (row['vehicle_id'] || row['vin'] || '').trim();
    if (!vin) { skipped++; continue; }

    const year  = extractYear(row);
    const make  = normaliseMake(row);
    const model = normaliseModel(row);

    process.stdout.write(`  → ${vin}  ${row['title'] || ''}...`);

    let specs = null;
    if (!SKIP_API) {
      specs = await fetchVehicleSpecs(year, make, model);
      if (specs) apiHits++;
    }

    const html     = fillTemplate(template, row, specs);
    const outPath  = path.join(OUT_DIR, `${vin}.html`);
    fs.writeFileSync(outPath, html, 'utf-8');

    const recallInfo = specs
      ? (specs.recall_count === 0 ? ' ✅ 0 recalls' : ` ⚠️  ${specs.recall_count} recall(s)`)
      : '';
    console.log(` ✓${recallInfo}`);
    built++;
  }

  // Copy Facebook catalog
  fs.copyFileSync(DATA_PATH, path.join(__dirname, 'facebook_catalog.csv'));

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Build complete
   Pages built : ${built}
   Skipped     : ${skipped}
   CarVector   : ${SKIP_API ? 'skipped (--no-api or no key)' : `${apiHits}/${built} enriched`}
   Output      : ./inventory/
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Next steps:
  1. Commit & push to GitHub
  2. Enable GitHub Pages: Settings → Pages → Branch: main → Save
  3. Your site will be live at:
     https://andrew33712-ai.github.io/south-florida-inventory/
  `);
}

main().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
