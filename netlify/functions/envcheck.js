export async function handler() {
  const keys = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_ANON_KEY'
  ];
  const report = Object.fromEntries(
    keys.map(k => [k, !!process.env[k]])
  );
  // also show which compute.js version is live
  report.RUNTIME = 'node';
  report.BUILD_TIME = process.env.VERCEL === '1' ? 'vercel' : 'netlify';
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(report, null, 2)
  };
}
