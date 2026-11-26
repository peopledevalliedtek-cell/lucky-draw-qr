// Generates the printable name-tag badges.
//
// IMPORTANT: badges are tied to PRIZES, not to employees (the whole point
// is "ดวงใครดวงมัน" — employees grab a badge at check-in themselves, write
// their own name on it, and the QR on it secretly already carries one
// specific prize, assigned and shuffled by `npm run seed`). So:
//   - Each badge shows a blank line for the employee to handwrite their
//     name, plus their QR code. It never prints which prize that badge
//     carries — that's the whole surprise.
//   - Run `npm run seed` FIRST so the `badges` table in Supabase exists.
//     This script just reads it and renders each row as a printable card;
//     it does not pick or shuffle prizes itself.
//   - A private manifest (badge token -> prize) is also written to
//     output/admin_manifest.csv for the event organizers' own records —
//     do NOT print or share that file with employees.
//
// Usage:
//   BASE_URL=https://your-domain.example node scripts/generate_badges.js

const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { supabase } = require('../lib/supabase');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function main() {
  const { data: badges, error } = await supabase
    .from('badges')
    .select('token, prizes(name, unit)')
    .order('token');
  if (error) throw error;
  if (!badges || badges.length === 0) {
    console.error('ไม่พบป้ายในฐานข้อมูล กรุณารัน "npm run seed" ก่อน');
    process.exit(1);
  }

  const outDir = path.join(__dirname, '..', 'output');
  fs.mkdirSync(outDir, { recursive: true });

  const badgeCells = [];
  const manifestRows = [['badge_token', 'prize_name', 'unit']];

  for (const b of badges) {
    const url = `${BASE_URL}/badge/${b.token}`;
    const dataUrl = await QRCode.toDataURL(url, { width: 220, margin: 1 });
    manifestRows.push([b.token, b.prizes?.name || '', b.prizes?.unit || '']);
    // NOTE: no prize info rendered here on purpose — it's a surprise.
    badgeCells.push(`
      <div class="badge">
        <div class="nameline">ชื่อ: ________________________</div>
        <img src="${dataUrl}" width="110" height="110" />
        <div class="hint">สแกนตอนเย็นเพื่อลุ้นของรางวัล</div>
      </div>`);
  }

  const html = `<!DOCTYPE html>
<html lang="th"><head><meta charset="UTF-8"><title>ป้ายชื่อ QR Code (เปล่า - ให้พนักงานเขียนชื่อเอง)</title>
<style>
  @page { size: A4; margin: 10mm; }
  body { font-family: 'Tahoma', sans-serif; margin:0; }
  .grid { display:grid; grid-template-columns: repeat(3, 1fr); gap:6mm; }
  .badge {
    border:1px dashed #999; border-radius:8px; padding:10px 8px; text-align:center;
    page-break-inside: avoid;
  }
  .nameline{ font-size:11px; color:#555; margin-bottom:8px; }
  .hint{ font-size:9px; color:#888; margin-top:4px; }
  img{ display:block; margin:0 auto; }
</style></head>
<body>
  <div class="grid">
    ${badgeCells.join('\n')}
  </div>
</body></html>`;

  fs.writeFileSync(path.join(outDir, 'badges.html'), html, 'utf8');

  const manifestCsv = manifestRows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  fs.writeFileSync(path.join(outDir, 'admin_manifest.csv'), '﻿' + manifestCsv, 'utf8');

  console.log(`Generated ${badges.length} badge QR codes.`);
  console.log('Printable sheet (give to employees, no prize info shown): output/badges.html');
  console.log('Private manifest (organizers ONLY, do not share): output/admin_manifest.csv');
  console.log(`QR codes point to: ${BASE_URL}/badge/<token>`);
}

main().catch(err => {
  console.error('Failed:', err.message || err);
  process.exit(1);
});
