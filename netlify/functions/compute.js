// netlify/functions/compute.js
import { supabase, ok, cors } from './_db.js';

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return cors();
  if (event.httpMethod !== 'POST') return ok({ error: 'POST only' }, 405);

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return ok({ error: 'Invalid JSON' }, 400);
  }

  // === Part 1 — INPUTS ===
  const {
    user_email = null,
    project_id = null,
    has_balcony = false,
    inputs = {}
  } = payload;

  const scope_level = (inputs.scope_level || 'refresh').toLowerCase();
  const segment = (inputs.market_segment || 'value').toLowerCase();
  const as_of = inputs.as_of_date || new Date().toISOString().slice(0, 10);
  const sponsor_id = inputs.sponsor_id || null;
  const region = inputs.region || null;

  // === Step A: create or update project row ===
  let projId = project_id;
  if (!projId) {
    const { data, error } = await supabase
      .from('projects')
      .insert({
        user_email,
        inputs,
        has_balcony,
        status: 'draft'
      })
      .select('id')
      .single();
    if (error) return ok({ error: error.message }, 500);
    projId = data.id;
  } else {
    const { error } = await supabase
      .from('projects')
      .update({ user_email, inputs, has_balcony })
      .eq('id', projId);
    if (error) return ok({ error: error.message }, 500);
  }

  // === Step B: build quantity rows (hidden logic) ===
  const H = 2.70;
  const Pu = Number(inputs?.pu || 0);
  const Pe = Number(inputs?.pe || 0);
  const GIA = Number(inputs?.gfa || inputs?.gia || 0);

  const rows = [];

  // C30 Paint
  rows.push({
    area_group: 'Living/Dining',
    room: 'Living',
    element: 'C30',
    scope: scope_level,
    item: 'paint_walls',
    uom: 'm2',
    qty: Pu * H
  });

  rows.push({
    area_group: 'Circulation & Utility',
    room: 'Circulation',
    element: 'C30',
    scope: scope_level,
    item: 'paint_walls',
    uom: 'm2',
    qty: Pe * H
  });

  // D50 Electrical
  rows.push({
    area_group: 'Electrical',
    room: 'All',
    element: 'D50',
    scope: scope_level,
    item: 'wiring_devices',
    uom: 'pc',
    qty: Math.ceil(GIA / 4)
  });

  rows.push({
    area_group: 'Electrical',
    room: 'All',
    element: 'D50',
    scope: scope_level,
    item: 'light_watt',
    uom: 'watt',
    qty: 10 * GIA
  });

  // D20 T&B fixtures
  if (inputs.tnb_count > 0) {
    rows.push({
      area_group: 'Toilet & Bath(s)',
      room: 'T&B',
      element: 'D20',
      scope: scope_level,
      item: 'fixture_set',
      uom: 'set',
      qty: inputs.tnb_count
    });
  }

  // Balcony
  if (has_balcony) {
    rows.push({
      area_group: 'Balcony',
      room: 'Balcony',
      element: 'B20',
      scope: scope_level,
      item: 'parapet_paint',
      uom: 'm2',
      qty: Pe * 1.2
    });
  }

  // === Step C: helper to fetch rate from RPC ===
  async function getRate(row) {
    const { data, error } = await supabase.rpc('get_cost_rate', {
      _element: row.element,
      _item: row.item,
      _uom: row.uom,
      _market: segment,
      _scope: scope_level,
      _as_of: as_of,
      _sponsor_id: sponsor_id,
      _region: region
    });
    if (error) {
      console.warn('get_cost_rate error', row.element, row.item, error.message);
      return { material: 0, labor: 0, total: 0, material_rate: 0, labor_rate: 0, loss: 0 };
    }
    const matRate = Number(data?.material_rate || 0);
    const labRate = Number(data?.labor_rate || 0);
    const loss = Number(data?.loss || 0);
    const mat = matRate * row.qty * (1 + loss);
    const lab = labRate * row.qty;
    return {
      material_rate: matRate,
      labor_rate: labRate,
      loss,
      material: mat,
      labor: lab,
      total: mat + lab
    };
  }

  // === Step D: price rows ===
  const pricedRows = [];
  for (const r of rows) {
    const rate = await getRate(r);
    pricedRows.push({
      ...r,
      material_rate: rate.material_rate,
      labor_rate: rate.labor_rate,
      loss: rate.loss,
      material_cost: rate.material,
      labor_cost: rate.labor,
      total_cost: rate.total
    });
  }

  // === Step E: summaries for UI ===
  const elements = { B20: 0, C10: 0, C20: 0, C30: 0, D20: 0, D30: 0, D40: 0, D50: 0, E20: 0, Z: 0 };
  for (const r of pricedRows) {
    elements[r.element] = Math.round((elements[r.element] || 0) + r.total_cost);
  }

  const area_summary = {};
  for (const r of pricedRows) {
    area_summary[r.area_group] = Math.round((area_summary[r.area_group] || 0) + r.total_cost);
  }

  // === Step F: save detail rows (hidden) ===
  await supabase.from('project_details').delete().eq('project_id', projId);
  if (pricedRows.length) {
    const detailRows = pricedRows.map(r => ({
      project_id: projId,
      area_group: r.area_group,
      room: r.room,
      element: r.element,
      scope: r.scope,
      item: r.item,
      uom: r.uom,
      qty: r.qty,
      material_rate: r.material_rate,
      labor_rate: r.labor_rate,
      loss: r.loss,
      material_cost: r.material_cost,
      labor_cost: r.labor_cost,
      total_cost: r.total_cost,
      payload: {}
    }));
    const { error: detErr } = await supabase.from('project_details').insert(detailRows);
    if (detErr) return ok({ error: detErr.message }, 500);
  }

  // === Step G: update summaries on project ===
  const { error: upErr } = await supabase
    .from('projects')
    .update({ elements, area_summary })
    .eq('id', projId);
  if (upErr) return ok({ error: upErr.message }, 500);

  // === Step H: return only visible summaries ===
  return ok({
    project_id: projId,
    summary_by_element: elements,
    summary_by_area: area_summary
  });
}
