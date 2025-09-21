import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // must exist

if (!supabaseUrl) throw new Error('Missing SUPABASE_URL');
if (!serviceRoleKey) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');

export const supabase = createClient(supabaseUrl, serviceRoleKey, {
  db: { schema: 'public' }, // your tables are in public
});

// Helpers
export const ok = (body, status = 200) => ({
  statusCode: status,
  headers: {
    'Content-Type': 'application/json',
    // CORS (handy if you ever open this cross-origin)
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  },
  body: JSON.stringify(body),
});

export const cors = () => ({
  statusCode: 204,
  headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  },
});

// Safe debug (doesn't print secrets)
console.log('SUPABASE_URL set?', !!process.env.SUPABASE_URL);
console.log('SERVICE_ROLE set?', !!process.env.SUPABASE_SERVICE_ROLE_KEY);
console.log('ANON set? (not used in functions)', !!process.env.SUPABASE_ANON_KEY);
