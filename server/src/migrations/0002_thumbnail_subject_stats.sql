create table if not exists thumbnail_subject_stats (
    subjectid text primary key references subjects(id) on delete cascade,
    pending bigint not null default 0,
    processing bigint not null default 0,
    ready bigint not null default 0,
    failed bigint not null default 0,
    total bigint not null default 0,
    initialized boolean not null default false,
    invalidations bigint not null default 0,
    updatedat timestamptz not null default now()
  );

alter table thumbnail_subject_stats add column if not exists invalidations bigint not null default 0;

create or replace function update_thumbnail_subject_stats() returns trigger as $$
begin
  if tg_op = 'INSERT' then
    insert into thumbnail_subject_stats
      (subjectid, pending, processing, ready, failed, total, updatedat)
    select images.subjectid,
           count(*) filter (where new_rows.status = 'pending'),
           count(*) filter (where new_rows.status = 'processing'),
           count(*) filter (where new_rows.status = 'ready'),
           count(*) filter (where new_rows.status = 'failed'),
           count(*), now()
    from new_rows join images on images.id = new_rows.imageid
    group by images.subjectid
    order by images.subjectid
    on conflict (subjectid) do update set
      pending = thumbnail_subject_stats.pending + excluded.pending,
      processing = thumbnail_subject_stats.processing + excluded.processing,
      ready = thumbnail_subject_stats.ready + excluded.ready,
      failed = thumbnail_subject_stats.failed + excluded.failed,
      total = thumbnail_subject_stats.total + excluded.total,
      updatedat = excluded.updatedat;
  elsif tg_op = 'UPDATE' then
    insert into thumbnail_subject_stats
      (subjectid, pending, processing, ready, failed, total, updatedat)
    select images.subjectid,
           sum((new_rows.status = 'pending')::integer - (old_rows.status = 'pending')::integer),
           sum((new_rows.status = 'processing')::integer - (old_rows.status = 'processing')::integer),
           sum((new_rows.status = 'ready')::integer - (old_rows.status = 'ready')::integer),
           sum((new_rows.status = 'failed')::integer - (old_rows.status = 'failed')::integer),
           0, now()
    from new_rows join old_rows on old_rows.imageid = new_rows.imageid
    join images on images.id = new_rows.imageid
    where new_rows.status is distinct from old_rows.status
    group by images.subjectid
    order by images.subjectid
    on conflict (subjectid) do update set
      pending = thumbnail_subject_stats.pending + excluded.pending,
      processing = thumbnail_subject_stats.processing + excluded.processing,
      ready = thumbnail_subject_stats.ready + excluded.ready,
      failed = thumbnail_subject_stats.failed + excluded.failed,
      updatedat = excluded.updatedat;
  else
    insert into thumbnail_subject_stats
      (subjectid, pending, processing, ready, failed, total, updatedat)
    select images.subjectid,
           -count(*) filter (where old_rows.status = 'pending'),
           -count(*) filter (where old_rows.status = 'processing'),
           -count(*) filter (where old_rows.status = 'ready'),
           -count(*) filter (where old_rows.status = 'failed'),
           -count(*), now()
    from old_rows join images on images.id = old_rows.imageid
    group by images.subjectid
    order by images.subjectid
    on conflict (subjectid) do update set
      pending = thumbnail_subject_stats.pending + excluded.pending,
      processing = thumbnail_subject_stats.processing + excluded.processing,
      ready = thumbnail_subject_stats.ready + excluded.ready,
      failed = thumbnail_subject_stats.failed + excluded.failed,
      total = thumbnail_subject_stats.total + excluded.total,
      updatedat = excluded.updatedat;
  end if;
  return null;
end;
$$ language plpgsql;

do $$ begin
  if exists (select 1 from pg_trigger where tgname = 'thumbnail_jobs_stats_trigger') then
    drop trigger thumbnail_jobs_stats_trigger on thumbnail_jobs;
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'thumbnail_jobs_stats_insert_trigger') then
    create trigger thumbnail_jobs_stats_insert_trigger
    after insert on thumbnail_jobs referencing new table as new_rows
    for each statement execute function update_thumbnail_subject_stats();
    create trigger thumbnail_jobs_stats_update_trigger
    after update on thumbnail_jobs referencing old table as old_rows new table as new_rows
    for each statement execute function update_thumbnail_subject_stats();
    create trigger thumbnail_jobs_stats_delete_trigger
    after delete on thumbnail_jobs referencing old table as old_rows
    for each statement execute function update_thumbnail_subject_stats();
  end if;
end $$;

create or replace function invalidate_thumbnail_subject_stats() returns trigger as $$
begin
  update thumbnail_subject_stats
  set initialized = false, invalidations = invalidations + 1, updatedat = now()
  where subjectid in (select distinct subjectid from old_images);
  return null;
end;
$$ language plpgsql;

do $$ begin
  if exists (select 1 from pg_trigger where tgname = 'images_thumbnail_stats_delete_trigger') then
    drop trigger images_thumbnail_stats_delete_trigger on images;
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'images_thumbnail_stats_delete_statement_trigger') then
    create trigger images_thumbnail_stats_delete_statement_trigger
    after delete on images referencing old table as old_images
    for each statement execute function invalidate_thumbnail_subject_stats();
  end if;
end $$;
