-- ======================================================================
-- รันไฟล์นี้ใน Supabase Dashboard -> SQL Editor -> New query -> วางทั้งหมด -> Run
-- (รันครั้งเดียวตอนตั้งโปรเจกต์ใหม่ ปลอดภัยถ้ารันซ้ำ เพราะใช้ IF NOT EXISTS / OR REPLACE)
-- ======================================================================

create table if not exists prizes (
  id text primary key,
  name text not null,
  unit text,
  stock_total int not null,
  stock_remaining int not null
);

create table if not exists employees (
  emp_id text primary key,
  name text not null,
  company text,
  department text,
  division text,
  section text,
  position text,
  drawn boolean not null default false,
  prize_id text references prizes(id),
  badge_token text,
  drawn_at timestamptz
);

create table if not exists badges (
  token text primary key,
  prize_id text not null references prizes(id),
  claimed_by text references employees(emp_id),
  claimed_at timestamptz
);

create table if not exists settings (
  key text primary key,
  value text not null
);

insert into settings (key, value) values ('event_open', '0')
on conflict (key) do nothing;

-- ----------------------------------------------------------------------
-- การยืนยันรับรางวัล ต้องทำเป็น "ธุรกรรมเดียวแบบอะตอมมิก" (atomic) เพื่อกัน
-- การสแกนพร้อมกันหลายคนไม่ให้ของรางวัลชิ้นเดียวถูกแจกซ้ำ 2 คน ฟังก์ชันนี้
-- ทำหน้าที่แทน transaction ที่เคยเป็นโค้ด JS ฝั่ง Node (ตอนใช้ SQLite)
-- ----------------------------------------------------------------------
create or replace function confirm_claim(p_token text, p_emp_id text)
returns jsonb
language plpgsql
as $$
declare
  v_badge badges%rowtype;
  v_emp employees%rowtype;
  v_prize prizes%rowtype;
begin
  -- ล็อกแถวที่เกี่ยวข้องไว้ก่อน กันคนอื่นแก้พร้อมกัน
  select * into v_badge from badges where token = p_token for update;
  if not found then
    return jsonb_build_object('error', 'badge_not_found');
  end if;
  if v_badge.claimed_by is not null and v_badge.claimed_by <> p_emp_id then
    return jsonb_build_object('error', 'badge_already_used');
  end if;

  select * into v_emp from employees where emp_id = p_emp_id for update;
  if not found then
    return jsonb_build_object('error', 'emp_not_found');
  end if;
  if v_emp.drawn and v_emp.badge_token <> p_token then
    select * into v_prize from prizes where id = v_emp.prize_id;
    return jsonb_build_object('error', 'employee_already_drawn', 'prize', to_jsonb(v_prize));
  end if;

  if v_badge.claimed_by is null then
    update badges set claimed_by = p_emp_id, claimed_at = now() where token = p_token;
    update prizes set stock_remaining = stock_remaining - 1
      where id = v_badge.prize_id and stock_remaining > 0;
  end if;

  if not v_emp.drawn then
    update employees set drawn = true, prize_id = v_badge.prize_id, badge_token = p_token, drawn_at = now()
      where emp_id = p_emp_id;
  end if;

  select * into v_prize from prizes where id = v_badge.prize_id;
  return jsonb_build_object('ok', true, 'prize', to_jsonb(v_prize));
end;
$$;

-- แอดมินใช้ "รีเซ็ต" ผลของพนักงานรายคน (คืนสต็อก + ปลดล็อกป้าย)
create or replace function reset_claim(p_emp_id text)
returns boolean
language plpgsql
as $$
declare
  v_emp employees%rowtype;
begin
  select * into v_emp from employees where emp_id = p_emp_id for update;
  if not found or not v_emp.drawn then
    return false;
  end if;
  if v_emp.prize_id is not null then
    update prizes set stock_remaining = stock_remaining + 1 where id = v_emp.prize_id;
  end if;
  if v_emp.badge_token is not null then
    update badges set claimed_by = null, claimed_at = null where token = v_emp.badge_token;
  end if;
  update employees set drawn = false, prize_id = null, badge_token = null, drawn_at = null
    where emp_id = p_emp_id;
  return true;
end;
$$;

-- ----------------------------------------------------------------------
-- Row Level Security: เปิดไว้แต่ไม่เปิด policy ให้ใครเลย เพราะเซิร์ฟเวอร์ Node
-- ใช้ "service_role" key ซึ่งข้าม RLS อยู่แล้วเสมอ การไม่เปิด policy ใดๆ
-- หมายความว่าถ้า anon/public key หลุดไปก็ยังอ่าน/เขียนตารางเหล่านี้ไม่ได้เลย
-- ----------------------------------------------------------------------
alter table employees enable row level security;
alter table prizes enable row level security;
alter table badges enable row level security;
alter table settings enable row level security;
