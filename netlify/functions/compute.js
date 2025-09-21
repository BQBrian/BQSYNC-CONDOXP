// netlify/functions/compute.js
/* eslint-disable */
const { createClient } = require('@supabase/supabase-js');

// ENV you must set in Netlify:
// SUPABASE_URL, SUPABASE_SERVICE_ROLE (service key, not anon)

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const input = JSON.parse(event.body || '{}');

    // ===== Part 1 — INPUTS from UI =====
    // Expected minimal fields — add more as your form grows.
    // These are examples; the math below assumes they're present.
    const {
      user_email,
      project_id,        // optional (for re-compute), otherwise new
      has_balcony,
      unit: { gia, pu, pe, bedrooms, tb_count } = {}, // GIA=Gross area, Pu open perimeter, Pe enclosed perimeter
      level: { scope_level = 'refresh', market = 'value' } = {}, // 'refresh'|'minor'|'major', 'affordable'|'value'|'premium'|'luxury'
      options = {},      // future toggles
      as_of_date,        // optional pricing date
      sponsor_id = null  // optional sponsor override
    } = input;

    // ---- Supabase client ----
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE,
      { auth: { persistSession: false } }
    );

    // ===== Part 2 — SPACE DISTRIBUTION (Hidden) =====
    // Very simple starter: split GIA into areas. Replace with your logic when ready.
    const spaces = distributeSpaces({ gia, bedrooms, tb_count, has_balcony });

    // ===== Part 4.1 — SHARED GEOMETRY HELPERS =====
    const helpers = {
      wallAreaOpen: () => (pu ?? 0) * 2.70,
      wallAreaEnclosed: () => (pe ?? 0) * 2.70,
      ceiling: (a) => a, // 1:1 for simple rooms
      // ...add more shared helpers as you refine
    };

    // ===== Part 4.2 — ROOM/ITEM QUANTITY LOGIC (Hidden) =====
    // Build quantity lines per element (C10, C30, D50, ...), per room/space
    const quantityRows = buildQuantities({
      scope_level,
      market,
      spaces,
      helpers,
      gia,
      pu,
      pe,
      tb_count,
      has_balcony
    });

    // ===== Pricing lookup (sponsor-aware) =====
    // For each row, fetch effective rates and compute material/labor/total
    const pricedRows = [];
    for (const row of quantityRows) {
      const rate = await fetchRate(supabase, {
        element: row.element,
        item: row.item,
        uom: row.uom,
        market,
        scope: scope_level,
        as_of_date,
        sponsor_id
      });

      const material = (rate?.material_rate ?? 0) * row.qty * (1 + (rate?.loss ?? 0));
      const labor    = (rate?.labor_rate ?? 0)    * row.qty;
      const total    = material + labor;

      pricedRows.push({ ...row, material, labor, total, rate_used: rate || null });
    }

    // ===== Part 3 — VISIBLE SUMMARIES ONLY =====
    const byElement = aggregateByElement(pricedRows);
    const byArea    = aggregateByArea(pricedRows);

    // ===== Persist =====
    // 1) upsert a project row
    const projectPayload = {
      id: project_id || undefined,
      user_email: user_email || null,
      has_balcony: !!has_balcony,
      inputs: input,               // keep raw inputs
      spaces,                      // hidden calc spaces (OK to store)
      elements: byElement,         // summary (visible)
      area_summary: byArea,        // summary (visible)
      status: 'computed'
    };

    const { data: projectSaved, error: projectErr } = await supabase
      .from('projects')
      .upsert(projectPayload)
      .select()
      .single();

    if (projectErr) throw projectErr;

    const pid = projectSaved.id;

    // 2) replace hidden detail rows
    await supabase.from('project_details').delete().eq('project_id', pid);

    const detailRows = pricedRows.map(r => ({
      project_id: pid,
      room: r.room,
      area_group: r.area_group, // living/kitchen/bedroom/...
      element: r.element,
      scope: r.scope,
      item: r.item,
      uom: r.uom,
      qty: r.qty,
      material_rate: r.rate_used?.material_rate ?? null,
      labor_rate: r.rate_used?.labor_rate ?? null,
      loss: r.rate_used?.loss ?? null,
      material_cost: r.material,
      labor_cost: r.labor,
      total_cost: r.total,
      payload: r.payload || {}
    }));

    if (detailRows.length) {
      const { error: insErr } = await supabase.from('project_details').insert(detailRows, { count: 'exact' });
      if (insErr) throw insErr;
    }

    // Return only the visible summaries to the UI.
    return json(200, {
      project_id: pid,
      summary_by_element: byElement,
      summary_by_area: byArea
      // (No detailed rows returned here—those are for /send-details)
    });

  } catch (e) {
    console.error(e);
    return json(500, { error: String(e?.message || e) });
  }
};

/* ------------------ helpers (hidden logic) ------------------ */

// Part 2 — space distribution (placeholder; refine later)
function distributeSpaces({ gia = 0, bedrooms = 1, tb_count = 1, has_balcony = false }) {
  const base = Math.max(gia, 0);
  const alloc = {
    living: base * 0.28,
    kitchen: base * 0.12,
    circulation: base * 0.16,
    bedrooms: base * 0.30,
    tb: base * 0.12,
    balcony: has_balcony ? base * 0.02 : 0
  };
  // Split bedroom area into N rooms
  const bedroomAreas = Array.from({ length: Math.max(1, bedrooms) }, () => alloc.bedrooms / Math.max(1, bedrooms));
  const tbAreas = Array.from({ length: Math.max(1, tb_count) }, () => alloc.tb / Math.max(1, tb_count));
  return { ...alloc, bedroomAreas, tbAreas, gia: base };
}

// Part 4.2 — quantity recipes (very simplified starters; replace per your matrix)
function buildQuantities({ scope_level, market, spaces, helpers, gia, pu, pe, tb_count, has_balcony }) {
  const rows = [];

  // Example: C30 Paint for open vs enclosed (circulation/utility uses Pe; living/kitchen uses Pu)
  rows.push({
    area_group: 'Circulation & Utility',
    room: 'Circulation',
    element: 'C30',
    scope: scope_level,
    item: 'paint_walls',
    uom: 'm2',
    qty: helpers.wallAreaEnclosed(), // Pe × 2.70
    payload: { note: 'Use Pe for enclosed rooms.' }
  });

  rows.push({
    area_group: 'Living/Dining',
    room: 'Living/Dining',
    element: 'C30',
    scope: scope_level,
    item: 'paint_walls',
    uom: 'm2',
    qty: helpers.wallAreaOpen(), // Pu × 2.70
    payload: { note: 'Use Pu for open areas.' }
  });

  // Example: D50 baseline outlets + fixtures using simple densities
  const outletDensity = 1 / 4; // 1 outlet per 4 m2
  const lampW = 12;
  const fixtures = Math.ceil((10 * gia) / lampW);

  rows.push({
    area_group: 'Electrical',
    room: 'All',
    element: 'D50',
    scope: scope_level,
    item: 'wiring_devices',
    uom: 'pc',
    qty: Math.ceil(gia * outletDensity),
    payload: { rule: 'A_room/4' }
  });

  rows.push({
    area_group: 'Electrical',
    room: 'All',
    element: 'D50',
    scope: scope_level,
    item: 'light_fixtures',
    uom: 'pc',
    qty: fixtures,
    payload: { rule: '(10 W/m2 × GIA)/lamp_W' }
  });

  // Bathrooms: fixture sets (WC, Lav, Shower) per T&B
  if (tb_count > 0) {
    rows.push({
      area_group: 'Toilet & Bath(s)',
      room: 'T&B',
      element: 'D20',
      scope: scope_level,
      item: 'fixture_set',
      uom: 'set',
      qty: tb_count,
      payload: { set: 'WC+Lav+Shower per T&B' }
    });
  }

  // Balcony paint if any
  if (has_balcony) {
    rows.push({
      area_group: 'Balcony',
      room: 'Balcony',
      element: 'B20',
      scope: scope_level,
      item: 'parapet_paint',
      uom: 'm2',
      qty: (pe ?? 0) * 1.2, // simple proxy
      payload: { note: 'Pe × 1.2' }
    });
  }

  // Add more rows per your long matrix (C10/C20/C30/D20/D30/D50/E20/Z):
  // - Minor/Major branches
  // - New ceilings, partitions, floor finishes, recircuiting, etc.
  // Keep each as {area_group, room, element, scope, item, uom, qty, payload}

  return rows;
}

// Aggregate for visible A. Elemental breakdown
function aggregateByElement(rows) {
  const map = {};
  for (const r of rows) {
    map[r.element] = (map[r.element] || 0) + (r.total || 0);
  }
  // keep only BQ Framework order keys you want to display
  const order = ['B20', 'C10', 'C20', 'C30', 'D20', 'D30', 'D40', 'D50', 'E20', 'Z'];
  const out = [];
  for (const key of order) {
    if (map[key]) out.push({ element: key, total: round2(map[key]) });
  }
  return out;
}

// Aggregate for visible B. By specific area composition
function aggregateByArea(rows) {
  const map = {};
  for (const r of rows) {
    const k = r.area_group || 'Other';
    map[k] = (map[k] || 0) + (r.total || 0);
  }
  const order = [
    'Living/Dining',
    'Kitchen',
    'Bedroom(s)',
    'Toilet & Bath(s)',
    'Circulation & Utility',
    'Stairs',
    'Balcony'
  ];
  // normalize Bedroom(s)/Toilet & Bath(s) labels
  const rename = (k) => {
    if (/bed/i.test(k)) return 'Bedroom(s)';
    if (/toilet|bath|t&b/i.test(k)) return 'Toilet & Bath(s)';
    return k;
    };
  const out = [];
  for (const [k, v] of Object.entries(map)) {
    const label = rename(k);
    // merge if same label
    const existing = out.find(x => x.area === label);
    if (existing) existing.total += v;
    else out.push({ area: label, total: v });
  }
  // reorder
  out.sort((a, b) => order.indexOf(a.area) - order.indexOf(b.area));
  // round
  return out.map(x => ({ ...x, total: round2(x.total) }));
}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

// Sponsor-aware pricing via SQL function public.get_cost_rate
async function fetchRate(supabase, { element, item, uom, market, scope, as_of_date, sponsor_id }) {
  // If you created the SQL helper function, call it; else return nulls for now.
  const { data, error } = await supabase.rpc('get_cost_rate', {
    _element: element,
    _item: item,
    _uom: uom,
    _market: market,
    _scope: scope,
    _as_of: as_of_date || new Date().toISOString().slice(0, 10),
    _sponsor_id: sponsor_id
  });
  if (error) {
    // Fail soft: compute will still return quantities; cost will be zero
    console.warn('get_cost_rate error:', error.message);
    return null;
  }
  return data || null;
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj)
  };
}
