create table if not exists users (
    id text primary key,
    username text not null unique,
    password text not null,
    role text not null check (role in ('admin', 'scorer')),
    status text not null default 'enabled' check (status in ('enabled', 'disabled')),
    mustchangepassword boolean not null default true,
    failedloginattempts integer not null default 0,
    failedloginwindowstart timestamptz,
    lockeduntil timestamptz,
    lastloginat timestamptz,
    createdat timestamptz not null,
    updatedat timestamptz not null
  );

alter table users add column if not exists mustchangepassword boolean not null default true;
alter table users add column if not exists failedloginattempts integer not null default 0;
alter table users add column if not exists failedloginwindowstart timestamptz;
alter table users add column if not exists lockeduntil timestamptz;

create table if not exists user_sessions (
    tokenhash text primary key,
    userid text not null,
    expiresat timestamptz not null,
    createdat timestamptz not null,
    lastseenat timestamptz not null,
    foreign key (userid) references users(id) on delete cascade
  );

create table if not exists import_jobs (
    uploadid text primary key,
    originalfilename text not null,
    totalchunks integer not null,
    protocol text not null default 'chunked',
    uploadlength bigint,
    uploadoffset bigint not null default 0,
    metadata text,
    status text not null check (status in ('queued', 'merging', 'importing', 'awaiting_json', 'completed', 'failed')),
    stage text not null,
    progress integer not null default 0,
    message text,
    resultjson text,
    createdat timestamptz not null,
    updatedat timestamptz not null,
    expiresat timestamptz not null
  );

create table if not exists auth_login_attempts (
    id text primary key,
    username text not null,
    ip text not null,
    succeeded boolean not null default false,
    createdat timestamptz not null
  );

create table if not exists auth_ip_blocks (
    ip text primary key,
    lockeduntil timestamptz not null,
    updatedat timestamptz not null
  );

create table if not exists auth_captcha_challenges (
    id text primary key,
    answerhash text not null,
    expiresat timestamptz not null,
    usedat timestamptz,
    createdat timestamptz not null
  );

alter table import_jobs
    alter column uploadlength type bigint using uploadlength::bigint,
    alter column uploadoffset type bigint using uploadoffset::bigint;
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'import_jobs'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%awaiting_json%'
  ) then
    alter table import_jobs drop constraint if exists import_jobs_status_check;
    alter table import_jobs
      add constraint import_jobs_status_check
      check (status in ('queued', 'merging', 'importing', 'awaiting_json', 'completed', 'failed'));
  end if;
end $$;

create table if not exists schema_meta (
    key text primary key,
    value text not null,
    updatedat timestamptz not null
  );

create table if not exists subjects (
    id text primary key,
    name text not null,
    originalfilename text not null,
    importbatch text not null unique,
    storageroot text,
    sourcezippath text,
    imagecount integer not null default 0,
    categorycount integer not null default 0,
    status text not null default 'importing' check (status in ('importing', 'imported', 'failed')),
    taskstatus text not null default 'task_pending' check (taskstatus in ('task_pending', 'scoring', 'task_completed')),
    deletionrequestedat timestamptz,
    createdat timestamptz not null,
    updatedat timestamptz not null
  );

create table if not exists projects (
    id text primary key,
    name text not null,
    icon text not null default 'archive',
    packageid text not null,
    taskstatus text not null default 'task_pending' check (taskstatus in ('task_pending', 'scoring', 'task_completed')),
    deletionrequestedat timestamptz,
    createdat timestamptz not null,
    updatedat timestamptz not null,
    foreign key (packageid) references subjects(id) on delete restrict
  );

create table if not exists task_generation_jobs (
    jobid text primary key,
    subjectid text not null,
    status text not null check (status in ('queued', 'running', 'completed', 'failed')),
    stage text not null,
    progress integer not null default 0,
    message text,
    requestjson text,
    stageeventsjson text,
    resultjson text,
    createdat timestamptz not null,
    updatedat timestamptz not null,
    expiresat timestamptz not null,
    foreign key (subjectid) references projects(id) on delete cascade
  );

alter table task_generation_jobs
    add column if not exists requestjson text;
alter table task_generation_jobs
    add column if not exists stageeventsjson text;

do $$
begin
  if to_regclass('task_generation_jobs') is not null and not exists (
    select 1
    from pg_constraint c
    join pg_class rel on rel.oid = c.conrelid
    join pg_class ref on ref.oid = c.confrelid
    where c.conname = 'task_generation_jobs_subjectid_fkey'
      and rel.relname = 'task_generation_jobs'
      and ref.relname = 'projects'
  ) then
    delete from task_generation_jobs
    where not exists (
      select 1 from projects where projects.id = task_generation_jobs.subjectid
    );

    alter table task_generation_jobs
      drop constraint if exists task_generation_jobs_subjectid_fkey;
    alter table task_generation_jobs
      add constraint task_generation_jobs_subjectid_fkey
      foreign key (subjectid) references projects(id) on delete cascade;
  end if;
end $$;

create table if not exists project_packages (
    projectid text not null,
    packageid text not null,
    createdat timestamptz not null,
    primary key (projectid, packageid),
    foreign key (projectid) references projects(id) on delete cascade,
    foreign key (packageid) references subjects(id) on delete restrict
  );

create table if not exists teams (
    id text primary key,
    name text not null unique ,
    status text not null default 'enabled' check (status in ('enabled', 'disabled')),
    createdat timestamptz not null,
    updatedat timestamptz not null
  );

create table if not exists user_teams (
    userid text not null,
    teamid text not null,
    createdat timestamptz not null,
    primary key (userid, teamid),
    foreign key (userid) references users(id) on delete cascade,
    foreign key (teamid) references teams(id) on delete cascade
  );

create table if not exists project_teams (
    projectid text not null,
    teamid text not null,
    createdat timestamptz not null,
    primary key (projectid, teamid),
    foreign key (projectid) references projects(id) on delete cascade,
    foreign key (teamid) references teams(id) on delete restrict
  );

create table if not exists user_projects (
    userid text not null,
    projectid text not null,
    createdat timestamptz not null,
    primary key (userid, projectid),
    foreign key (userid) references users(id) on delete cascade,
    foreign key (projectid) references subjects(id) on delete cascade
  );

create table if not exists images (
    id text primary key,
    subjectid text not null,
    filename text not null,
    originalpath text not null,
    storagepath text not null,
    thumbnailpath text,
    mimetype text,
    category text not null,
    directory text not null default '',
    isinfographic integer not null default 0,
    prompt text,
    catalogdata text,
    importbatch text not null,
    scorer text,
    overall integer,
    creativity integer,
    mood integer,
    composition integer,
    color integer,
    lighting integer,
    realism integer,
    detail integer,
    discomfort integer,
    promptalignment integer,
    promptalignmentstate text not null default 'unrated',
    textcorrectness integer,
    textcorrectnessstate text not null default 'unrated',
    anatomynormality integer,
    anatomynormalitystate text not null default 'unrated',
    informationclarity integer,
    informationclaritystate text not null default 'unrated',
    designquality integer,
    designqualitystate text not null default 'unrated',
    typography integer,
    typographystate text not null default 'unrated',
    comment text,
    ratedat timestamptz,
    createdat timestamptz not null,
    updatedat timestamptz not null,
    foreign key (subjectid) references subjects(id) on delete cascade,
    unique (subjectid, originalpath)
  );

create table if not exists rating_tasks (
    id text primary key,
    subjectid text not null,
    projectid text,
    taskversion text not null,
    round integer not null,
    tasktype text not null,
    status text not null default 'pending' check (status in ('pending', 'assigned', 'completed')),
    scorer text,
    ranking text,
    excludedimageids text,
    correctimageids text,
    rankingrelations text,
    assignmentkey integer not null default 0,
    isbacktest boolean not null default false,
    backtestsourceid text,
    submissionmode text check (submissionmode in ('direct', 'ranked')),
    rankingactioncount integer not null default 0,
    largeimageopened boolean not null default false,
    startedat timestamptz,
    completedat timestamptz,
    durationms integer,
    editedat timestamptz,
    editcount integer not null default 0,
    rollbackcount integer not null default 0,
    lastrolledbackat timestamptz,
    lastrolledbackby text,
    imagekey text not null,
    createdat timestamptz not null,
    updatedat timestamptz not null,
    foreign key (subjectid) references subjects(id) on delete cascade,
    unique (subjectid, taskversion, round, tasktype, imagekey)
  );

alter table rating_tasks
    add column if not exists largeimageopened boolean not null default false;

alter table rating_tasks
    add column if not exists isbacktest boolean not null default false;

alter table rating_tasks
    add column if not exists backtestsourceid text;

create table if not exists rating_task_items (
    taskid text not null,
    imageid text not null,
    position integer not null,
    role text not null default 'target' check (role in ('target', 'filler', 'anchor_low', 'anchor_high', 'boundary')),
    primary key (taskid, imageid),
    foreign key (taskid) references rating_tasks(id) on delete cascade,
    foreign key (imageid) references images(id) on delete cascade
  );

create table if not exists project_task_stats (
    projectid text not null,
    taskversion text not null,
    total integer not null default 0,
    pending integer not null default 0,
    assigned integer not null default 0,
    completed integer not null default 0,
    updatedat timestamptz not null,
    primary key (projectid, taskversion),
    foreign key (projectid) references projects(id) on delete cascade
  );

create table if not exists scorer_task_stats (
    scorer text not null,
    taskversion text not null,
    projectid text not null,
    assigned integer not null default 0,
    completed integer not null default 0,
    updatedat timestamptz not null,
    primary key (scorer, taskversion, projectid)
  );

create table if not exists scorer_scoring_stats (
    scorer text not null,
    taskversion text not null,
    projectid text not null,
    submissionmode text not null check (submissionmode in ('direct', 'ranked', 'untracked')),
    taskcount bigint not null default 0,
    largeimageopenedcount bigint not null default 0,
    durationtotal bigint not null default 0,
    durationcount bigint not null default 0,
    durationmin bigint,
    durationmax bigint,
    rollbackcount bigint not null default 0,
    updatedat timestamptz not null,
    primary key (scorer, taskversion, projectid, submissionmode)
  );

create table if not exists dashboard_completion_hour_stats (
    taskversion text not null,
    hour integer not null check (hour between 0 and 23),
    completedtaskcount bigint not null default 0,
    updatedat timestamptz not null,
    primary key (taskversion, hour)
  );

alter table scorer_scoring_stats
    add column if not exists durationmin bigint;
alter table scorer_scoring_stats
    add column if not exists durationmax bigint;

create table if not exists subject_task_templates (
    id text primary key,
    subjectid text not null,
    sourcetaskid text not null,
    round integer not null,
    criterion text not null,
    imagekey text not null,
    selectionkey integer not null default 0,
    createdat timestamptz not null,
    foreign key (subjectid) references subjects(id) on delete cascade,
    unique (subjectid, sourcetaskid),
    unique (subjectid, round, criterion, imagekey)
  );

create table if not exists subject_task_template_items (
    templateid text not null,
    imageid text not null,
    position integer not null,
    role text not null default 'target' check (role in ('target', 'filler', 'anchor_low', 'anchor_high', 'boundary')),
    primary key (templateid, imageid),
    foreign key (templateid) references subject_task_templates(id) on delete cascade,
    foreign key (imageid) references images(id) on delete cascade
  );

create table if not exists image_pair_edges (
    subjectid text not null,
    imagea text not null,
    imageb text not null,
    count integer not null default 0,
    updatedat timestamptz not null,
    primary key (subjectid, imagea, imageb),
    foreign key (subjectid) references subjects(id) on delete cascade,
    foreign key (imagea) references images(id) on delete cascade,
    foreign key (imageb) references images(id) on delete cascade
  );

create table if not exists feedbacks (
    id text primary key,
    title text not null,
    type text not null check (type in ('platform_bug', 'scoring_rule', 'other')),
    description text not null,
    imagepaths text not null default '[]',
    status text not null default 'pending' check (status in ('pending', 'processing', 'resolved')),
    submitter text not null,
    submittedat timestamptz not null,
    reply text,
    repliedby text,
    repliedat timestamptz,
    updatedat timestamptz not null
  );

create table if not exists feedback_messages (
    id text primary key,
    feedbackid text not null,
    author text not null,
    authorrole text not null check (authorrole in ('admin', 'scorer')),
    content text not null,
    createdat timestamptz not null,
    foreign key (feedbackid) references feedbacks(id) on delete cascade
  );
create index if not exists idx_subjects_createdat on subjects(createdat desc);
create index if not exists idx_projects_createdat on projects(createdat desc);
create index if not exists idx_projects_deleted_created
    on projects(deletionrequestedat, createdat desc, id asc);
create index if not exists idx_projects_packageid on projects(packageid);
create index if not exists idx_project_packages_project_created
    on project_packages(projectid, createdat asc, packageid asc);
create index if not exists idx_project_packages_package_project on project_packages(packageid, projectid);
create index if not exists idx_images_subject_category_created
    on images(subjectid, category, createdat desc);
create index if not exists idx_images_subject_createdat on images(subjectid, createdat desc);
create index if not exists idx_images_subject_scorer_created
    on images(subjectid, scorer, createdat desc);
create index if not exists idx_images_subject_overall_created
    on images(subjectid, overall, createdat desc);
create index if not exists idx_images_created on images(createdat desc);
create index if not exists idx_images_importbatch on images(importbatch);
create index if not exists idx_images_ratedat on images(ratedat);
create index if not exists idx_users_role_username on users(role, username);
create index if not exists idx_users_role_lastloginat on users(role, lastloginat);
create index if not exists idx_user_sessions_expiresat on user_sessions(expiresat);
create index if not exists idx_auth_login_attempts_username_created
    on auth_login_attempts(username, createdat desc);
create index if not exists idx_auth_login_attempts_ip_created
    on auth_login_attempts(ip, createdat desc);
create index if not exists idx_auth_ip_blocks_lockeduntil on auth_ip_blocks(lockeduntil);
create index if not exists idx_auth_captcha_challenges_expiresat
    on auth_captcha_challenges(expiresat);
create index if not exists idx_import_jobs_expiresat on import_jobs(expiresat);
create index if not exists idx_task_generation_jobs_subject_status
    on task_generation_jobs(subjectid, status, updatedat desc);
create index if not exists idx_task_generation_jobs_expiresat on task_generation_jobs(expiresat);
create index if not exists idx_user_projects_project_user on user_projects(projectid, userid);
create index if not exists idx_user_teams_team_user on user_teams(teamid, userid);
create index if not exists idx_project_teams_team_project on project_teams(teamid, projectid);
create index if not exists idx_rating_tasks_subject on rating_tasks(subjectid, round, tasktype);
create index if not exists idx_rating_tasks_subject_version_order
    on rating_tasks(subjectid, taskversion, round, tasktype, createdat, id);
create index if not exists idx_rating_tasks_subject_version_status_order
    on rating_tasks(subjectid, taskversion, status, round, tasktype, createdat, id);
create index if not exists idx_rating_tasks_subject_version_scorer_order
    on rating_tasks(subjectid, taskversion, scorer, round, tasktype, createdat, id);
create index if not exists idx_rating_tasks_subject_version_task_type_order
    on rating_tasks(subjectid, taskversion, tasktype, round, createdat, id);
create index if not exists idx_rating_tasks_project_template
    on rating_tasks(projectid, taskversion, subjectid, round, tasktype, imagekey);
create index if not exists idx_rating_tasks_project
    on rating_tasks(projectid, taskversion, round, tasktype);
create index if not exists idx_rating_tasks_project_order
    on rating_tasks(projectid, taskversion, tasktype, createdat, id);
create index if not exists idx_rating_tasks_project_status_order
    on rating_tasks(projectid, taskversion, status, tasktype, createdat, id);
create index if not exists idx_rating_tasks_project_scorer_order
    on rating_tasks(projectid, taskversion, scorer, tasktype, createdat, id);
create index if not exists idx_rating_tasks_scorer_status on rating_tasks(scorer, status, subjectid);
create index if not exists idx_rating_tasks_export on rating_tasks(taskversion, status, completedat desc nulls last, id);
create index if not exists idx_rating_tasks_export_id
    on rating_tasks(taskversion, status, id);
create index if not exists idx_rating_tasks_export_project_id
    on rating_tasks(taskversion, status, projectid, id);
create index if not exists idx_rating_tasks_export_scorer_id
    on rating_tasks(taskversion, status, scorer, id);
create index if not exists idx_rating_tasks_completed_scorer_time
    on rating_tasks(taskversion, scorer, completedat, id)
    where status = 'completed';
create index if not exists idx_rating_tasks_scorer_version_status on rating_tasks(scorer, taskversion, status, subjectid);
create index if not exists idx_rating_tasks_scorer_version_status_updated
    on rating_tasks(scorer, taskversion, status, updatedat desc, id);
create index if not exists idx_rating_tasks_version_scorer_status_order
    on rating_tasks(taskversion, scorer, status, tasktype, createdat, id);
create index if not exists idx_rating_tasks_assigned_list
    on rating_tasks(taskversion, scorer, status, projectid, createdat, id)
    where status in ('assigned', 'completed');
create index if not exists idx_rating_tasks_assigned_assignment_list
    on rating_tasks(taskversion, scorer, status, assignmentkey, id)
    where status in ('assigned', 'completed');
create index if not exists idx_rating_tasks_next_assigned
    on rating_tasks(taskversion, scorer, projectid, createdat, id)
    where status = 'assigned';
create index if not exists idx_rating_task_items_image on rating_task_items(imageid);
create index if not exists idx_rating_task_items_task_position
    on rating_task_items(taskid, position, imageid);
create index if not exists idx_subject_task_templates_subject_order
    on subject_task_templates(subjectid, round, criterion, sourcetaskid);
create index if not exists idx_subject_task_template_items_image
    on subject_task_template_items(imageid);
create index if not exists idx_image_pair_edges_subject on image_pair_edges(subjectid);
create index if not exists idx_feedbacks_submitter_status_created on feedbacks(submitter, status, submittedat desc);
create index if not exists idx_feedbacks_status_created on feedbacks(status, submittedat desc);
create index if not exists idx_feedback_messages_feedback_created on feedback_messages(feedbackid, createdat asc, id asc);
create index if not exists idx_scorer_task_stats_project_version
    on scorer_task_stats(projectid, taskversion);
create index if not exists idx_scorer_scoring_stats_version_project
    on scorer_scoring_stats(taskversion, projectid, scorer, submissionmode);
create index if not exists idx_scorer_scoring_stats_version_scorer
    on scorer_scoring_stats(taskversion, scorer, projectid, submissionmode);
create index if not exists idx_dashboard_completion_hour_stats_version
    on dashboard_completion_hour_stats(taskversion, hour);
create index if not exists idx_users_role_status on users(role, status, username);
create index if not exists idx_teams_status_name on teams(status, name);
create index if not exists idx_project_packages_project_package on project_packages(projectid, packageid);
create index if not exists idx_rating_tasks_project_assignment on rating_tasks(projectid, taskversion, status, assignmentkey, id);
create index if not exists idx_rating_tasks_project_scorer_assignment on rating_tasks(projectid, taskversion, status, scorer, assignmentkey, id);
create index if not exists idx_rating_tasks_project_backtest on rating_tasks(projectid, taskversion, isbacktest);
create index if not exists idx_subject_task_templates_selection on subject_task_templates(subjectid, selectionkey, id);
create index if not exists idx_images_thumbnail_path on images(thumbnailpath);
create unique index if not exists idx_teams_name_ci on teams(lower(name));
create unique index if not exists idx_projects_active_name_ci on projects(lower(trim(name))) where deletionrequestedat is null;

-- Keep the denormalized dashboard counters in sync with rating_tasks.
create or replace function refresh_scorer_scoring_duration(
  target_scorer text,
  target_task_version text,
  target_project_id text,
  target_submission_mode text
) returns void language plpgsql as $$
begin
  update scorer_scoring_stats stats
     set durationmin = duration_values.durationmin,
         durationmax = duration_values.durationmax
    from (
      select min(durationms)::bigint as durationmin,
             max(durationms)::bigint as durationmax
      from rating_tasks
      where status = 'completed'
        and scorer = target_scorer
        and taskversion = target_task_version
        and coalesce(projectid, '') = target_project_id
        and coalesce(submissionmode, 'untracked') = target_submission_mode
        and durationms is not null
        and durationms >= 0
    ) duration_values
   where stats.scorer = target_scorer
     and stats.taskversion = target_task_version
     and stats.projectid = target_project_id
     and stats.submissionmode = target_submission_mode;
end;
$$;

create or replace function sync_rating_task_stats() returns trigger language plpgsql as $$
begin
  -- Bulk task jobs rebuild the counters once after their write batches. Keep
  -- the trigger enabled for normal scoring requests and other task updates.
  if coalesce(current_setting('app.skip_rating_task_stats', true), 'off') = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op in ('DELETE', 'UPDATE') and old.projectid is not null then
    update project_task_stats
       set total = greatest(0, total - 1),
           pending = greatest(0, pending - case when old.status = 'pending' then 1 else 0 end),
           assigned = greatest(0, assigned - case when old.status = 'assigned' then 1 else 0 end),
           completed = greatest(0, completed - case when old.status = 'completed' then 1 else 0 end),
           updatedat = coalesce(new.updatedat, old.updatedat)
     where projectid = old.projectid and taskversion = old.taskversion;
  end if;

  if tg_op in ('DELETE', 'UPDATE') and old.scorer is not null and btrim(old.scorer) <> ''
     and old.status in ('assigned', 'completed') then
    update scorer_task_stats
       set assigned = greatest(0, assigned - case when old.status = 'assigned' then 1 else 0 end),
           completed = greatest(0, completed - case when old.status = 'completed' then 1 else 0 end),
           updatedat = coalesce(new.updatedat, old.updatedat)
     where scorer = old.scorer and taskversion = old.taskversion
       and projectid = coalesce(old.projectid, '');
    delete from scorer_task_stats
     where scorer = old.scorer and taskversion = old.taskversion
       and projectid = coalesce(old.projectid, '') and assigned = 0 and completed = 0;
  end if;

  if tg_op in ('INSERT', 'UPDATE') and new.projectid is not null then
    insert into project_task_stats(projectid, taskversion, total, pending, assigned, completed, updatedat)
    values (new.projectid, new.taskversion, 1,
            case when new.status = 'pending' then 1 else 0 end,
            case when new.status = 'assigned' then 1 else 0 end,
            case when new.status = 'completed' then 1 else 0 end, new.updatedat)
    on conflict (projectid, taskversion) do update set
      total = project_task_stats.total + 1,
      pending = project_task_stats.pending + excluded.pending,
      assigned = project_task_stats.assigned + excluded.assigned,
      completed = project_task_stats.completed + excluded.completed,
      updatedat = excluded.updatedat;
  end if;

  if tg_op in ('INSERT', 'UPDATE') and new.scorer is not null and btrim(new.scorer) <> ''
     and new.status in ('assigned', 'completed') then
    insert into scorer_task_stats(scorer, taskversion, projectid, assigned, completed, updatedat)
    values (new.scorer, new.taskversion, coalesce(new.projectid, ''),
            case when new.status = 'assigned' then 1 else 0 end,
            case when new.status = 'completed' then 1 else 0 end, new.updatedat)
    on conflict (scorer, taskversion, projectid) do update set
      assigned = scorer_task_stats.assigned + excluded.assigned,
      completed = scorer_task_stats.completed + excluded.completed,
      updatedat = excluded.updatedat;
  end if;

  if tg_op in ('DELETE', 'UPDATE')
     and old.scorer is not null and btrim(old.scorer) <> ''
     and old.status = 'completed' then
    update scorer_scoring_stats
       set taskcount = greatest(0, taskcount - 1),
           largeimageopenedcount = greatest(
             0,
             largeimageopenedcount - case when coalesce(old.largeimageopened, false) then 1 else 0 end
           ),
           durationtotal = greatest(
             0,
             durationtotal - case when old.durationms is not null and old.durationms >= 0 then old.durationms else 0 end
           ),
           durationcount = greatest(
             0,
             durationcount - case when old.durationms is not null and old.durationms >= 0 then 1 else 0 end
           ),
           rollbackcount = greatest(0, rollbackcount - coalesce(old.rollbackcount, 0)),
           updatedat = coalesce(new.updatedat, old.updatedat)
     where scorer = old.scorer
       and taskversion = old.taskversion
       and projectid = coalesce(old.projectid, '')
       and submissionmode = coalesce(old.submissionmode, 'untracked');

    delete from scorer_scoring_stats
     where scorer = old.scorer
       and taskversion = old.taskversion
       and projectid = coalesce(old.projectid, '')
       and submissionmode = coalesce(old.submissionmode, 'untracked')
       and taskcount = 0;
  end if;

  if tg_op in ('INSERT', 'UPDATE')
     and new.scorer is not null and btrim(new.scorer) <> ''
     and new.status = 'completed' then
    insert into scorer_scoring_stats(
      scorer, taskversion, projectid, submissionmode, taskcount,
      largeimageopenedcount, durationtotal, durationcount, durationmin, durationmax,
      rollbackcount, updatedat
    )
    values (
      new.scorer,
      new.taskversion,
      coalesce(new.projectid, ''),
      coalesce(new.submissionmode, 'untracked'),
      1,
      case when coalesce(new.largeimageopened, false) then 1 else 0 end,
      case when new.durationms is not null and new.durationms >= 0 then new.durationms else 0 end,
      case when new.durationms is not null and new.durationms >= 0 then 1 else 0 end,
      case when new.durationms is not null and new.durationms >= 0 then new.durationms else null end,
      case when new.durationms is not null and new.durationms >= 0 then new.durationms else null end,
      coalesce(new.rollbackcount, 0),
      new.updatedat
    )
    on conflict (scorer, taskversion, projectid, submissionmode) do update set
      taskcount = scorer_scoring_stats.taskcount + excluded.taskcount,
      largeimageopenedcount = scorer_scoring_stats.largeimageopenedcount + excluded.largeimageopenedcount,
      durationtotal = scorer_scoring_stats.durationtotal + excluded.durationtotal,
      durationcount = scorer_scoring_stats.durationcount + excluded.durationcount,
      durationmin = case
        when excluded.durationmin is null then scorer_scoring_stats.durationmin
        when scorer_scoring_stats.durationmin is null then excluded.durationmin
        else least(scorer_scoring_stats.durationmin, excluded.durationmin)
      end,
      durationmax = case
        when excluded.durationmax is null then scorer_scoring_stats.durationmax
        when scorer_scoring_stats.durationmax is null then excluded.durationmax
        else greatest(scorer_scoring_stats.durationmax, excluded.durationmax)
      end,
      rollbackcount = scorer_scoring_stats.rollbackcount + excluded.rollbackcount,
      updatedat = excluded.updatedat;
  end if;

  if tg_op in ('DELETE', 'UPDATE')
     and old.scorer is not null and btrim(old.scorer) <> ''
     and old.status = 'completed' then
    perform refresh_scorer_scoring_duration(
      old.scorer,
      old.taskversion,
      coalesce(old.projectid, ''),
      coalesce(old.submissionmode, 'untracked')
    );
  end if;

  if tg_op = 'UPDATE'
     and new.scorer is not null and btrim(new.scorer) <> ''
     and new.status = 'completed' then
    perform refresh_scorer_scoring_duration(
      new.scorer,
      new.taskversion,
      coalesce(new.projectid, ''),
      coalesce(new.submissionmode, 'untracked')
    );
  end if;

  if tg_op in ('DELETE', 'UPDATE')
     and old.status = 'completed'
     and old.completedat is not null then
    update dashboard_completion_hour_stats
       set completedtaskcount = greatest(
             0,
             completedtaskcount
             - case
                 when old.taskversion is not null then 1
                 else 0
               end
           ),
           updatedat = coalesce(new.updatedat, old.updatedat)
     where taskversion = old.taskversion
       and hour = extract(hour from old.completedat at time zone 'Asia/Shanghai')::integer;
  end if;

  if tg_op in ('INSERT', 'UPDATE')
     and new.status = 'completed'
     and new.completedat is not null then
    insert into dashboard_completion_hour_stats(
      taskversion, hour, completedtaskcount, updatedat
    )
    values (
      new.taskversion,
      extract(hour from new.completedat at time zone 'Asia/Shanghai')::integer,
      1,
      new.updatedat
    )
    on conflict (taskversion, hour) do update set
      completedtaskcount = dashboard_completion_hour_stats.completedtaskcount + 1,
      updatedat = excluded.updatedat;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists trg_rating_tasks_stats on rating_tasks;
create trigger trg_rating_tasks_stats after insert or update or delete on rating_tasks
for each row execute function sync_rating_task_stats();

do $$
begin
  if not exists (select 1 from scorer_scoring_stats limit 1) then
    insert into scorer_scoring_stats(
      scorer, taskversion, projectid, submissionmode, taskcount,
      largeimageopenedcount, durationtotal, durationcount, durationmin, durationmax, rollbackcount, updatedat
    )
    select scorer,
           taskversion,
           coalesce(projectid, ''),
           coalesce(submissionmode, 'untracked'),
           count(*)::bigint,
           sum(case when coalesce(largeimageopened, false) then 1 else 0 end)::bigint,
           sum(case when durationms is not null and durationms >= 0 then durationms else 0 end)::bigint,
           sum(case when durationms is not null and durationms >= 0 then 1 else 0 end)::bigint,
           min(case when durationms is not null and durationms >= 0 then durationms else null end)::bigint,
           max(case when durationms is not null and durationms >= 0 then durationms else null end)::bigint,
           sum(coalesce(rollbackcount, 0))::bigint,
           coalesce(max(updatedat), current_timestamp)
    from rating_tasks
    where status = 'completed'
      and scorer is not null
      and btrim(scorer) <> ''
    group by scorer, taskversion, coalesce(projectid, ''), coalesce(submissionmode, 'untracked');
  end if;
end $$;
