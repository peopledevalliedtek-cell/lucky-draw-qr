require('dotenv').config();
const path = require('path');
const express = require('express');
const { supabase } = require('./lib/supabase');

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme123'; // *** เปลี่ยนรหัสผ่านนี้ก่อนใช้งานจริง ***

const app = express();
app.use(express.json());
app.use('/static', express.static(path.join(__dirname, 'public')));

// ---------- Realtime (Server-Sent Events) ----------
// Every connected admin dashboard / live-wall screen keeps one open HTTP
// connection here. Whenever something changes (a prize is confirmed, the
// event is opened/closed) we push a tiny message to every connection, so
// those pages update instantly instead of waiting on a polling interval.
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  sseClients.add(res);
  const keepAlive = setInterval(() => res.write(':ping\n\n'), 20000);
  req.on('close', () => { clearInterval(keepAlive); sseClients.delete(res); });
});

// ---------- Helpers ----------

async function isEventOpen() {
  const { data, error } = await supabase.from('settings').select('value').eq('key', 'event_open').maybeSingle();
  if (error) throw error;
  return !!data && data.value === '1';
}

async function getBadge(token) {
  const { data, error } = await supabase.from('badges').select('*').eq('token', token).maybeSingle();
  if (error) throw error;
  return data;
}

async function getEmployee(empId) {
  const { data, error } = await supabase.from('employees').select('*').eq('emp_id', String(empId).trim()).maybeSingle();
  if (error) throw error;
  return data;
}

async function getPrize(prizeId) {
  if (!prizeId) return null;
  const { data, error } = await supabase.from('prizes').select('*').eq('id', prizeId).maybeSingle();
  if (error) throw error;
  return data;
}

function basicAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
    if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Lucky Draw Admin"');
  return res.status(401).send('Authentication required');
}

function asyncRoute(fn) {
  return (req, res) => fn(req, res).catch(err => {
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  });
}

// ---------- Employee-facing routes ----------

// This is the URL encoded in each badge's QR code.
app.get('/badge/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'badge.html'));
});

// Tells the page whether the event is open yet, and (if this badge is
// already claimed) who by, so a re-scan of the same badge shows the result
// again instead of the entry form.
app.get('/api/badge/:token/status', asyncRoute(async (req, res) => {
  const open = await isEventOpen();
  if (!open) return res.json({ open: false });

  const badge = await getBadge(req.params.token);
  if (!badge) return res.status(404).json({ open: true, error: 'badge_not_found' });

  if (badge.claimed_by) {
    const emp = await getEmployee(badge.claimed_by);
    const prize = await getPrize(badge.prize_id);
    return res.json({
      open: true,
      claimed: true,
      employee: emp ? { name: emp.name, department: emp.department } : null,
      prize: prize ? { name: prize.name, unit: prize.unit } : null,
    });
  }
  res.json({ open: true, claimed: false });
}));

// Step 1: employee types their emp_id. We look them up and show them the
// prize this badge carries WITHOUT committing anything yet, so they can
// back out if they typed the wrong emp_id. (Read-only preview — the actual
// atomic commit happens in the `confirm_claim` database function below.)
app.post('/api/badge/:token/preview', asyncRoute(async (req, res) => {
  if (!(await isEventOpen())) return res.status(409).json({ error: 'not_open' });

  const badge = await getBadge(req.params.token);
  if (!badge) return res.status(404).json({ error: 'badge_not_found' });

  const empId = String(req.body.emp_id || '').trim();
  if (!empId) return res.status(400).json({ error: 'missing_emp_id' });

  const emp = await getEmployee(empId);
  if (!emp) return res.status(404).json({ error: 'emp_not_found' });

  if (badge.claimed_by && badge.claimed_by !== empId) {
    return res.status(409).json({ error: 'badge_already_used' });
  }
  if (emp.drawn && emp.badge_token !== badge.token) {
    const prevPrize = await getPrize(emp.prize_id);
    return res.status(409).json({
      error: 'employee_already_drawn',
      prize: prevPrize ? { name: prevPrize.name, unit: prevPrize.unit } : null,
    });
  }

  const prize = await getPrize(badge.prize_id);
  res.json({
    ok: true,
    employee: { emp_id: emp.emp_id, name: emp.name, department: emp.department, company: emp.company },
    prize: { name: prize.name, unit: prize.unit },
    alreadyConfirmed: !!badge.claimed_by,
  });
}));

// Step 2: employee confirms. This calls the `confirm_claim` Postgres
// function (scripts/schema.sql), which does the whole check-and-commit
// atomically in the database — the thing a JS transaction did before.
app.post('/api/badge/:token/confirm', asyncRoute(async (req, res) => {
  if (!(await isEventOpen())) return res.status(409).json({ error: 'not_open' });
  const empId = String(req.body.emp_id || '').trim();
  if (!empId) return res.status(400).json({ error: 'missing_emp_id' });

  const { data, error } = await supabase.rpc('confirm_claim', { p_token: req.params.token, p_emp_id: empId });
  if (error) { console.error(error); return res.status(500).json({ error: 'server_error' }); }
  if (data.error) return res.status(409).json(data);

  const emp = await getEmployee(empId);
  broadcast('claim', {
    emp_id: empId,
    name: emp ? emp.name : empId,
    department: emp ? emp.department : '',
    company: emp ? emp.company : '',
    prize: { name: data.prize.name, unit: data.prize.unit },
    at: new Date().toISOString(),
  });

  res.json({ ok: true, prize: { name: data.prize.name, unit: data.prize.unit } });
}));

// ---------- Admin routes ----------

app.get('/admin', basicAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// TEMPORARY: redirect to one unclaimed badge, for previewing the live UI
// design without needing direct Supabase access. Remove after use.
app.get('/api/admin/preview-badge-once', basicAuth, asyncRoute(async (req, res) => {
  const { data, error } = await supabase
    .from('badges').select('token').is('claimed_by', null).limit(1).maybeSingle();
  if (error) throw error;
  if (!data) { res.status(404).send('ไม่พบป้ายที่ยังไม่ถูกใช้'); return; }
  res.redirect(`/badge/${data.token}`);
}));

app.get('/api/admin/summary', basicAuth, asyncRoute(async (req, res) => {
  const [{ count: totalEmployees }, { count: drawnCount }, { count: totalBadges }, { count: claimedBadges }] = await Promise.all([
    supabase.from('employees').select('*', { count: 'exact', head: true }),
    supabase.from('employees').select('*', { count: 'exact', head: true }).eq('drawn', true),
    supabase.from('badges').select('*', { count: 'exact', head: true }),
    supabase.from('badges').select('*', { count: 'exact', head: true }).not('claimed_by', 'is', null),
  ]);

  const { data: prizes, error: prizesErr } = await supabase.from('prizes').select('*').order('id');
  if (prizesErr) throw prizesErr;

  const { data: results, error: resultsErr } = await supabase
    .from('employees')
    .select('emp_id,name,company,department,drawn_at,prizes(name,unit)')
    .eq('drawn', true)
    .order('drawn_at', { ascending: false });
  if (resultsErr) throw resultsErr;

  res.json({
    eventOpen: await isEventOpen(),
    totalEmployees, drawnCount, totalBadges, claimedBadges,
    prizes,
    results: results.map(r => ({
      emp_id: r.emp_id, name: r.name, company: r.company, department: r.department,
      drawn_at: r.drawn_at, prize_name: r.prizes?.name, unit: r.prizes?.unit,
    })),
  });
}));

app.post('/api/admin/event', basicAuth, asyncRoute(async (req, res) => {
  const open = !!req.body.open;
  const { error } = await supabase.from('settings').update({ value: open ? '1' : '0' }).eq('key', 'event_open');
  if (error) throw error;
  broadcast('event_state', { open });
  res.json({ ok: true, open });
}));

app.get('/api/admin/export.csv', basicAuth, asyncRoute(async (req, res) => {
  const { data: rows, error } = await supabase
    .from('employees')
    .select('emp_id,name,company,department,division,section,position,badge_token,drawn_at,prizes(name,unit)')
    .order('emp_id');
  if (error) throw error;

  const header = ['emp_id','name','company','department','division','section','position','prize_name','unit','badge_token','drawn_at'];
  const flat = rows.map(r => ({
    emp_id: r.emp_id, name: r.name, company: r.company, department: r.department,
    division: r.division, section: r.section, position: r.position,
    prize_name: r.prizes?.name, unit: r.prizes?.unit, badge_token: r.badge_token, drawn_at: r.drawn_at,
  }));
  const csv = [header.join(',')].concat(
    flat.map(r => header.map(h => `"${(r[h] ?? '').toString().replace(/"/g, '""')}"`).join(','))
  ).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="lucky_draw_results.csv"');
  res.send('﻿' + csv); // BOM so Thai text opens correctly in Excel
}));

// Admin-only: undo one employee's claim (mis-scan / wrong emp_id typed in),
// restoring stock and freeing the badge so it can be reused. Calls the
// `reset_claim` Postgres function so it's atomic too.
app.post('/api/admin/reset/:emp_id', basicAuth, asyncRoute(async (req, res) => {
  const { data: ok, error } = await supabase.rpc('reset_claim', { p_emp_id: req.params.emp_id });
  if (error) throw error;
  if (ok) broadcast('reset', { emp_id: req.params.emp_id });
  res.json({ ok });
}));

// Public "big screen" live wall — meant to be projected at the venue.
// No admin auth: it only ever shows names/prizes that are already
// announced out loud at the event, same info the badge page itself shows.
app.get('/live', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'live.html'));
});

app.get('/api/live/recent', asyncRoute(async (req, res) => {
  const { data: results, error } = await supabase
    .from('employees')
    .select('emp_id,name,company,department,drawn_at,prizes(name,unit)')
    .eq('drawn', true)
    .order('drawn_at', { ascending: false })
    .limit(30);
  if (error) throw error;

  res.json({
    eventOpen: await isEventOpen(),
    results: results.map(r => ({
      emp_id: r.emp_id, name: r.name, company: r.company, department: r.department,
      drawn_at: r.drawn_at, prize_name: r.prizes?.name, unit: r.prizes?.unit,
    })),
  });
}));

app.listen(PORT, () => {
  console.log(`Lucky draw server running at http://localhost:${PORT}`);
  console.log(`Admin dashboard: http://localhost:${PORT}/admin  (user: ${ADMIN_USER})`);
});
