-- ============================================================
-- Part 3: QC / micro testing program
-- Run this in the SQL Editor AFTER parts 1 and 2.
-- This backs the new "QC / Micro" tab: pulling a sample (from a
-- batch, an in-process tank sample, or a fixed environmental
-- location), tracking it through incubation, and logging the
-- FastOrange Wild Yeast / B Tube read.
-- ============================================================

-- Fixed list of environmental swab locations (mirrors the locked
-- TTT/SKU list pattern). Seeded with placeholders — rename these
-- to your real locations before use.
create table qc_locations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  active boolean not null default true,
  sort_order int not null default 0
);

insert into qc_locations (name, sort_order) values
  ('Location 1', 1),
  ('Location 2', 2),
  ('Location 3', 3),
  ('Location 4', 4),
  ('Location 5', 5),
  ('Location 6', 6);

-- A pulled sample: either a batch/in-process sample (batch_id set)
-- or an environmental swab (location_id set), never both.
create table qc_samples (
  id uuid primary key default gen_random_uuid(),
  sample_type text not null check (sample_type in ('batch', 'in_process', 'environmental')),
  batch_id uuid references batches(id),
  location_id uuid references qc_locations(id),
  pulled_by uuid not null references profiles(id),
  pulled_date date not null default current_date,
  notes text not null default '',
  created_at timestamptz not null default now(),
  constraint qc_sample_target check (
    (sample_type in ('batch', 'in_process') and batch_id is not null and location_id is null) or
    (sample_type = 'environmental' and location_id is not null and batch_id is null)
  )
);

-- One row per test run against a sample. Logging a sample creates
-- both a wild_yeast and a b_tube row, each due 5 days after
-- pulled_date (the standard FastOrange read window).
create table qc_tests (
  id uuid primary key default gen_random_uuid(),
  sample_id uuid not null references qc_samples(id) on delete cascade,
  test_type text not null check (test_type in ('wild_yeast', 'b_tube')),
  due_date date not null,
  result text not null default 'pending' check (result in ('pending', 'negative', 'positive')),
  read_date date,
  read_by uuid references profiles(id),
  notes text not null default '',
  created_at timestamptz not null default now()
);

alter table qc_locations enable row level security;
alter table qc_samples enable row level security;
alter table qc_tests enable row level security;

create policy "read qc_locations" on qc_locations for select using (auth.role() = 'authenticated');
create policy "write qc_locations if lead" on qc_locations for insert with check (is_lead());
create policy "update qc_locations if lead" on qc_locations for update using (is_lead());
create policy "delete qc_locations if lead" on qc_locations for delete using (is_lead());

create policy "read qc_samples" on qc_samples for select using (auth.role() = 'authenticated');
create policy "write qc_samples if lead" on qc_samples for insert with check (is_lead());
create policy "delete qc_samples if lead" on qc_samples for delete using (is_lead());

create policy "read qc_tests" on qc_tests for select using (auth.role() = 'authenticated');
create policy "write qc_tests if lead" on qc_tests for insert with check (is_lead());
create policy "update qc_tests if lead" on qc_tests for update using (is_lead());
create policy "delete qc_tests if lead" on qc_tests for delete using (is_lead());
