-- ============================================================
-- Part 2: sheet_batches table
-- Run this in the SQL Editor AFTER the first schema file.
-- This is where "Refresh batch list" in the app stores the pasted
-- Batch Log data, so it's available for building panels.
-- ============================================================

create table sheet_batches (
  batch_number text primary key,
  sku_name text not null,
  date_brewed date,
  packaged_date date,
  updated_at timestamptz not null default now()
);

alter table sheet_batches enable row level security;

create policy "read sheet_batches" on sheet_batches for select using (auth.role() = 'authenticated');
create policy "write sheet_batches if lead" on sheet_batches for insert with check (is_lead());
create policy "delete sheet_batches if lead" on sheet_batches for delete using (is_lead());
