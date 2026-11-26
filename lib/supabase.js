require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('ขาดค่า SUPABASE_URL หรือ SUPABASE_SERVICE_ROLE_KEY');
  console.error('คัดลอก .env.example เป็น .env แล้วใส่ค่าจาก Supabase Dashboard -> Project Settings -> API');
  process.exit(1);
}

// service_role key bypasses Row Level Security — this file must only ever
// run on the server (seed script / server.js), never be sent to a browser.
const supabase = createClient(url, key, {
  auth: { persistSession: false },
});

module.exports = { supabase };
