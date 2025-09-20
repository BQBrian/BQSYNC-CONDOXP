import { supabase, ok, cors } from './_db.js';
import PDFDocument from 'pdfkit';

async function makePdf(project) {
  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  const buffers = [];
  doc.on('data', b => buffers.push(b));
  const title = 'CondoScope – Detailed Breakdown';

  doc.fontSize(18).text(title);
  doc.moveDown();
  doc.fontSize(10).text(`Project ID: ${project.id}`);
  doc.text(`Email: ${project.user_email || ''}`);
  doc.moveDown();

  doc.fontSize(12).text('Inputs');
  doc.fontSize(9).text(JSON.stringify(project.inputs || {}, null, 2));
  doc.moveDown();

  doc.fontSize(12).text('Elemental Breakdown');
  doc.fontSize(9).text(JSON.stringify(project.elements || {}, null, 2));
  doc.moveDown();

  doc.fontSize(12).text('By Area');
  doc.fontSize(9).text(JSON.stringify(project.area_summary || {}, null, 2));

  doc.end();
  await new Promise(res => doc.on('end', res));
  return Buffer.concat(buffers);
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return cors();
  if (event.httpMethod !== 'POST') return ok({ error: 'POST only' }, 405);

  const { project_id, name, email } = JSON.parse(event.body || '{}');
  if (!project_id) return ok({ error: 'project_id is required' }, 400);

  // 1) Load project
  const { data: project, error } = await supabase
    .from('projects')
    .select('*')
    .eq('id', project_id).single();
  if (error) return ok({ error: error.message }, 500);

  // 2) Create PDF
  const pdf = await makePdf(project);

  // 3) Upload to Supabase Storage (bucket: reports)
  const filename = `project-${project_id}-${Date.now()}.pdf`;
  const { error: upErr } = await supabase
    .storage.from('reports')
    .upload(filename, pdf, {
      contentType: 'application/pdf',
      upsert: true
    });
  if (upErr) return ok({ error: upErr.message }, 500);

  const { data: pub } = supabase.storage.from('reports').getPublicUrl(filename);
  const publicUrl = pub?.publicUrl;

  // 4) Save URL on project
  await supabase.from('projects').update({ download_url: publicUrl }).eq('id', project_id);

  // (Email sending can be added later; return link now)
  return ok({
    project_id,
    name,
    email,
    download_url: publicUrl
  });
}
