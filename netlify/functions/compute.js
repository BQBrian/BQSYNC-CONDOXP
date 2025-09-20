import { supabase, ok, cors } from './_db.js';

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return cors();
  if (event.httpMethod !== 'POST') return ok({ error: 'POST only' }, 405);

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return ok({ error: 'Invalid JSON' }, 400); }

  // 1) Save / update project
  const {
    user_email = null,
    inputs = {},     // Part 1 – user inputs
    spaces = {},     // Part 2 – hidden logic can fill this later
    has_balcony = false,
    project_id = null
  } = payload;

  // create or reuse project row
  let projId = project_id;
  if (!projId) {
    const { data, error } = await supabase
      .from('projects')
      .insert({ user_email, inputs, spaces, has_balcony, status: 'draft' })
      .select('id').single();
    if (error) return ok({ error: error.message }, 500);
    projId = data.id;
  } else {
    const { error } = await supabase
      .from('projects')
      .update({ user_email, inputs, spaces, has_balcony })
      .eq('id', projId);
    if (error) return ok({ error: error.message }, 500);
  }

  // 2) (Hidden) quantity logic placeholder — do your math here.
  // For now, compute a minimal “elemental breakdown” + “by area”.
  const elements = {
    B20: 0, C10: 0, C20: 0, C30: 0, D20: 0, D30: 0, D40: 0, D50: 0, E20: 0, Z: 0
  };
  const area_summary = {
    living_dining: {}, kitchen: {}, bedrooms: {}, toilets_baths: {},
    circulation_utility: {}, stairs: {}, balcony: {}
  };

  // Example: if inputs.gfa is given, paint a tiny demo number
  const gfa = Number(inputs?.gfa || 0);
  if (gfa > 0) {
    elements.C30 = Math.round(gfa * 2.7 * 195);   // totally placeholder
    area_summary.living_dining = { area: inputs?.living_area || null };
  }

  // 3) Save summaries back to project
  const { error: upErr } = await supabase
    .from('projects')
    .update({ elements, area_summary })
    .eq('id', projId);
  if (upErr) return ok({ error: upErr.message }, 500);

  // 4) (Optional ad) fetch one active campaign for the “results_mid” slot
  const { data: ad } = await supabase
    .from('ad_campaigns')
    .select('*')
    .eq('slot_key', 'results_mid')
    .eq('active', true)
    .lte('start_date', new Date().toISOString())
    .gte('end_date', new Date().toISOString())
    .order('priority', { ascending: false })
    .limit(1)
    .maybeSingle();

  return ok({
    project_id: projId,
    elements,
    area_summary,
    ad
  });
}
