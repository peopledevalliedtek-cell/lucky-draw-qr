// Seeds Supabase from data/employees.json and data/prizes.json.
//
// Prerequisite: run scripts/schema.sql in the Supabase SQL Editor FIRST
// (once) so the tables/functions exist.
//
// Safe to re-run for employees/prizes (upserts, won't wipe draw results).
// Badges are only generated once: if the `badges` table already has rows,
// re-running leaves them untouched so already-printed QR codes keep working.
//
// Model recap:
//   - `badges`: ONE ROW PER PHYSICAL BADGE (one per prize unit — 205 rows
//     for 205 prize units). Each gets its own random token -> QR code.
//     Badges are generated in prize order, then shuffled: printing them in
//     shuffled order and letting employees grab any badge IS the draw.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { supabase } = require('../lib/supabase');

const employees = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'employees.json'), 'utf8'));
const prizes = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'prizes.json'), 'utf8'));

function genToken() {
  return crypto.randomBytes(7).toString('base64url');
}

async function main() {
  // --- employees (upsert) ---
  const empRows = employees.map(e => ({
    emp_id: e.emp_id, name: e.name, company: e.company, department: e.department,
    division: e.division, section: e.section, position: e.position,
  }));
  for (let i = 0; i < empRows.length; i += 500) {
    const chunk = empRows.slice(i, i + 500);
    const { error } = await supabase.from('employees').upsert(chunk, { onConflict: 'emp_id' });
    if (error) throw error;
  }
  console.log(`Upserted ${empRows.length} employees.`);

  // --- prizes (upsert; keep stock_total in sync, but never touch stock_remaining here
  //     so re-running seed doesn't undo already-claimed badges' stock decrements) ---
  for (const p of prizes) {
    const { data: existing } = await supabase.from('prizes').select('id').eq('id', p.id).maybeSingle();
    if (existing) {
      const { error } = await supabase.from('prizes').update({ name: p.name, unit: p.unit, stock_total: p.stock }).eq('id', p.id);
      if (error) throw error;
    } else {
      const { error } = await supabase.from('prizes').insert({
        id: p.id, name: p.name, unit: p.unit, stock_total: p.stock, stock_remaining: p.stock,
      });
      if (error) throw error;
    }
  }
  console.log(`Upserted ${prizes.length} prizes.`);

  // --- settings ---
  const { data: existingSetting } = await supabase.from('settings').select('key').eq('key', 'event_open').maybeSingle();
  if (!existingSetting) {
    const { error } = await supabase.from('settings').insert({ key: 'event_open', value: '0' });
    if (error) throw error;
  }

  // --- badges: generate once only ---
  const { count: badgeCount, error: countErr } = await supabase
    .from('badges').select('*', { count: 'exact', head: true });
  if (countErr) throw countErr;

  if (badgeCount === 0) {
    const rows = [];
    for (const p of prizes) {
      for (let i = 0; i < p.stock; i++) rows.push(p.id);
    }
    for (let i = rows.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rows[i], rows[j]] = [rows[j], rows[i]];
    }
    const tokens = new Set();
    const badgeRows = rows.map(prizeId => {
      let t = genToken();
      while (tokens.has(t)) t = genToken();
      tokens.add(t);
      return { token: t, prize_id: prizeId };
    });
    for (let i = 0; i < badgeRows.length; i += 500) {
      const chunk = badgeRows.slice(i, i + 500);
      const { error } = await supabase.from('badges').insert(chunk);
      if (error) throw error;
    }
    console.log(`Generated ${badgeRows.length} badges (one per prize unit), shuffled.`);
  } else {
    console.log(`Badges already exist (${badgeCount} rows) — left untouched.`);
  }

  console.log('Seed complete.');
}

main().catch(err => {
  console.error('Seed failed:', err.message || err);
  process.exit(1);
});
