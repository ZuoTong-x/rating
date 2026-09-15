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
    claimtoken text,
    claimedat timestamptz,
    claimexpiresat timestamptz,
    ranking text,
    excludedimageids text,
    correctimageids text,
    rankingrelations text,
    assignmentkey integer not null default 0,
    isbacktest boolean not null default false,
    backtestsourceid text,
    submissionmode text check (submissionmode in ('direct', 'ranked')),
    rankingactioncount integer not null default 0,
    dragactioncount integer not null default 0,
    orderchanged boolean not null default false,
    largeimageopened boolean not null default false,
    largeimageopencount integer not null default 0,
    startedat timestamptz,
    completedat timestamptz,
    durationms integer,
    firstactionms integer,
    pageblurcount integer not null default 0,
    behaviortracked boolean not null default false,
    riskscore integer not null default 0,
    riskflags text,
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
    add column if not exists dragactioncount integer not null default 0;

alter table rating_tasks
    add column if not exists orderchanged boolean not null default false;

alter table rating_tasks
    add column if not exists largeimageopencount integer not null default 0;

alter table rating_tasks
    add column if not exists firstactionms integer;

alter table rating_tasks
    add column if not exists pageblurcount integer not null default 0;

alter table rating_tasks
    add column if not exists behaviortracked boolean not null default false;

alter table rating_tasks
    add column if not exists riskscore integer not null default 0;

alter table rating_tasks
    add column if not exists riskflags text;

alter table rating_tasks
    add column if not exists isbacktest boolean not null default false;

alter table rating_tasks
    add column if not exists backtestsourceid text;

alter table rating_tasks
    add column if not exists claimtoken text;

alter table rating_tasks
    add column if not exists claimedat timestamptz;

alter table rating_tasks
    add column if not exists claimexpiresat timestamptz;

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
    basetotal integer,
    basepending integer,
    updatedat timestamptz not null,
    primary key (projectid, taskversion),
    foreign key (projectid) references projects(id) on delete cascade
  );

alter table project_task_stats
    add column if not exists basetotal integer;

alter table project_task_stats
    add column if not exists basepending integer;

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
    trackedlargeimageopenedcount bigint not null default 0,
    largeimageopencounttotal bigint not null default 0,
    dragactioncounttotal bigint not null default 0,
    orderchangedcount bigint not null default 0,
    fastsubmitcount bigint not null default 0,
    highriskcount bigint not null default 0,
    behaviortrackedcount bigint not null default 0,
    riskscoretotal bigint not null default 0,
    riskscoremax integer not null default 0,
    pageblurcounttotal bigint not null default 0,
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

create table if not exists task_stats_events (
    id bigserial primary key,
    taskid text,
    projectid text not null,
    taskversion text not null,
    eventtype text not null,
    oldstatus text,
    newstatus text,
    oldscorer text,
    newscorer text,
    oldcompletedat timestamptz,
    newcompletedat timestamptz,
    isbacktest boolean not null default false,
    applyscorertaskstats boolean not null default false,
    oldscoringstats jsonb,
    newscoringstats jsonb,
    createdat timestamptz not null,
    processedat timestamptz
  );

alter table task_stats_events
    add column if not exists oldscorer text;
alter table task_stats_events
    add column if not exists newscorer text;
alter table task_stats_events
    add column if not exists isbacktest boolean not null default false;
alter table task_stats_events
    add column if not exists applyscorertaskstats boolean not null default false;
alter table task_stats_events
    add column if not exists oldscoringstats jsonb;
alter table task_stats_events
    add column if not exists newscoringstats jsonb;

alter table scorer_scoring_stats
    add column if not exists durationmin bigint;
alter table scorer_scoring_stats
    add column if not exists durationmax bigint;
alter table scorer_scoring_stats
    add column if not exists largeimageopencounttotal bigint not null default 0;
alter table scorer_scoring_stats
    add column if not exists trackedlargeimageopenedcount bigint not null default 0;
alter table scorer_scoring_stats
    add column if not exists dragactioncounttotal bigint not null default 0;
alter table scorer_scoring_stats
    add column if not exists orderchangedcount bigint not null default 0;
alter table scorer_scoring_stats
    add column if not exists fastsubmitcount bigint not null default 0;
alter table scorer_scoring_stats
    add column if not exists highriskcount bigint not null default 0;
alter table scorer_scoring_stats
    add column if not exists behaviortrackedcount bigint not null default 0;
alter table scorer_scoring_stats
    add column if not exists riskscoretotal bigint not null default 0;
alter table scorer_scoring_stats
    add column if not exists riskscoremax integer not null default 0;
alter table scorer_scoring_stats
    add column if not exists pageblurcounttotal bigint not null default 0;

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

create table if not exists subject_task_template_stats (
    subjectid text primary key,
    tasktemplatecount integer not null default 0,
    criterioncount integer not null default 0,
    updatedat timestamptz not null,
    foreign key (subjectid) references subjects(id) on delete cascade
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
create index if not exists idx_rating_tasks_scoring_risk
    on rating_tasks(taskversion, status, riskscore desc, completedat desc nulls last, id)
    where status = 'completed';
create index if not exists idx_rating_tasks_scoring_behavior
    on rating_tasks(taskversion, status, submissionmode, orderchanged, largeimageopened, completedat desc nulls last, id)
    where status = 'completed';
create index if not exists idx_rating_tasks_scoring_stats_lookup
    on rating_tasks(taskversion, coalesce(projectid, ''), scorer, coalesce(submissionmode, 'untracked'))
    where status = 'completed' and scorer is not null;
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
create index if not exists idx_rating_tasks_assigned_claim
    on rating_tasks(taskversion, scorer, status, claimexpiresat, assignmentkey, id)
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
create index if not exists idx_scorer_task_stats_version_scorer_project
    on scorer_task_stats(taskversion, scorer, projectid);
create index if not exists idx_scorer_scoring_stats_version_project
    on scorer_scoring_stats(taskversion, projectid, scorer, submissionmode);
create index if not exists idx_scorer_scoring_stats_version_scorer
    on scorer_scoring_stats(taskversion, scorer, projectid, submissionmode);
create index if not exists idx_dashboard_completion_hour_stats_version
    on dashboard_completion_hour_stats(taskversion, hour);
create index if not exists idx_task_stats_events_pending_project
    on task_stats_events(taskversion, projectid, createdat, id)
    where processedat is null;
create index if not exists idx_task_stats_events_pending_order
    on task_stats_events(taskversion, id)
    where processedat is null;
create index if not exists idx_task_stats_events_processed
    on task_stats_events(processedat)
    where processedat is not null;
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

-- Project, behavior and hourly aggregates are maintained from durable events
-- by the API background worker. Only per-scorer task counts stay synchronous,
-- so a submission never contends on a project-wide or hour-wide hot row.
create or replace function refresh_scorer_scoring_duration(
  target_scorer text,
  target_task_version text,
  target_project_id text,
  target_submission_mode text
) returns void language plpgsql as $$
begin
  update scorer_scoring_stats stats
     set durationmin = duration_values.durationmin,
         durationmax = duration_values.durationmax,
         riskscoremax = coalesce(duration_values.riskscoremax, 0)
    from (
      select min(case when durationms is not null and durationms >= 0 then durationms else null end)::bigint as durationmin,
             max(case when durationms is not null and durationms >= 0 then durationms else null end)::bigint as durationmax,
             max(coalesce(riskscore, 0))::integer as riskscoremax
      from rating_tasks
      where status = 'completed'
        and scorer = target_scorer
        and taskversion = target_task_version
        and coalesce(projectid, '') = target_project_id
        and coalesce(submissionmode, 'untracked') = target_submission_mode
    ) duration_values
   where stats.scorer = target_scorer
     and stats.taskversion = target_task_version
     and stats.projectid = target_project_id
     and stats.submissionmode = target_submission_mode;
end;
$$;

create or replace function sync_rating_task_stats() returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('app.sync_rating_task_stats', true), 'off') <> 'on'
     or coalesce(current_setting('app.skip_rating_task_stats', true), 'off') = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op in ('DELETE', 'UPDATE') and old.scorer is not null and btrim(old.scorer) <> ''
     and old.status in ('assigned', 'completed') then
    update scorer_task_stats
       set assigned = greatest(0, assigned - case when old.status = 'assigned' then 1 else 0 end),
           completed = greatest(0, completed - case when old.status = 'completed' then 1 else 0 end),
           updatedat = coalesce(new.updatedat, old.updatedat)
     where scorer = old.scorer and taskversion = old.taskversion
       and projectid = coalesce(old.projectid, '');
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

  if tg_op in ('DELETE', 'UPDATE') and old.scorer is not null and btrim(old.scorer) <> '' then
    delete from scorer_task_stats
     where scorer = old.scorer and taskversion = old.taskversion
       and projectid = coalesce(old.projectid, '') and assigned = 0 and completed = 0;
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
      largeimageopenedcount, trackedlargeimageopenedcount, largeimageopencounttotal, dragactioncounttotal,
      orderchangedcount, fastsubmitcount, highriskcount, behaviortrackedcount, riskscoretotal, riskscoremax,
      pageblurcounttotal, durationtotal, durationcount, durationmin, durationmax,
      rollbackcount, updatedat
    )
    select scorer,
           taskversion,
           coalesce(projectid, ''),
           coalesce(submissionmode, 'untracked'),
           count(*)::bigint,
           sum(case when coalesce(largeimageopened, false) then 1 else 0 end)::bigint,
           sum(case when coalesce(behaviortracked, false) and coalesce(largeimageopened, false) then 1 else 0 end)::bigint,
           sum(greatest(coalesce(largeimageopencount, 0), 0))::bigint,
           sum(greatest(coalesce(dragactioncount, 0), 0))::bigint,
           sum(case when coalesce(behaviortracked, false) and coalesce(orderchanged, false) then 1 else 0 end)::bigint,
           sum(case when coalesce(behaviortracked, false) and durationms is not null and durationms >= 0 and durationms < 3000 then 1 else 0 end)::bigint,
           sum(case when coalesce(behaviortracked, false) and coalesce(riskscore, 0) >= 60 then 1 else 0 end)::bigint,
           sum(case when coalesce(behaviortracked, false) then 1 else 0 end)::bigint,
           sum(case when coalesce(behaviortracked, false) then greatest(coalesce(riskscore, 0), 0) else 0 end)::bigint,
           max(case when coalesce(behaviortracked, false) then greatest(coalesce(riskscore, 0), 0) else 0 end)::integer,
           sum(case when coalesce(behaviortracked, false) then greatest(coalesce(pageblurcount, 0), 0) else 0 end)::bigint,
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
