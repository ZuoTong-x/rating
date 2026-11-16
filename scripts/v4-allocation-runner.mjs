/** Operational runner. Deploy beside v4-allocation-plan.json in /app/server/operations.
 * Ledger/logs live on the persistent upload volume, never under a public image path.
 * Usage: node operations/v4-allocation-runner.mjs init|repair-check|repair|run|sync
 *        node operations/v4-allocation-runner.mjs add-project PROJECT_NAME
 *        node operations/v4-allocation-runner.mjs create-project NAME PACKAGE_NAME...
 *        node operations/v4-allocation-runner.mjs set-quotas QUOTA_REVISION_JSON
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function allocateUnits(remaining, taskCount) {
  assert(Number.isInteger(taskCount) && taskCount >= 0 && taskCount % 20 === 0);
  assert(remaining.every(n => Number.isInteger(n) && n >= 0 && n % 20 === 0));
  const units = taskCount / 20;
  const capacities = remaining.map(n => n / 20);
  const total = capacities.reduce((a,b) => a+b, 0);
  assert(units <= total, 'Requested quantity exceeds remaining quotas');
  if (!units) return remaining.map(() => 0);
  const numerators = capacities.map(n => n * units);
  const result = numerators.map(n => Math.floor(n / total));
  const order = result.map((_, i) => i).sort((a,b) =>
    (numerators[b] % total) - (numerators[a] % total) || a-b);
  const extra = units - result.reduce((a,b) => a+b, 0);
  for (const i of order.slice(0, extra)) result[i]++;
  assert(result.every((n,i) => n <= capacities[i]));
  return result.map(n => n*20);
}

export function allocatePriorityUnits(roster, taskCount, priorityRoster = []) {
  const remaining = roster.map(r => r.remaining);
  const indices = new Map(roster.map((r,i) => [r.scorer,i]));
  const priorityRemaining = priorityRoster.map(r => {
    const i = indices.get(r.scorer);
    assert(i !== undefined, `Priority scorer is missing: ${r.scorer}`);
    const count = Math.max(0,r.quota-(roster[i].occupied||0));
    assert(count <= remaining[i], `Priority quota exceeds current quota: ${r.scorer}`);
    return count;
  });
  const priorityCount = Math.min(taskCount,priorityRemaining.reduce((a,b)=>a+b,0));
  const first = allocateUnits(priorityRemaining,priorityCount);
  const result = roster.map(()=>0);
  priorityRoster.forEach((r,i)=>{result[indices.get(r.scorer)]=first[i];});
  const second = allocateUnits(remaining.map((n,i)=>n-result[i]),taskCount-priorityCount);
  return result.map((n,i)=>n+second[i]);
}

async function main() {
  // Must precede importing postgres/app: prevents schema/startup jobs in this process.
  process.env.TASK_GENERATION_WORKER = '1';
  process.env.PG_LOCK_TIMEOUT_MS = '30000';
  process.env.TASK_WRITE_BATCH_SIZE ||= '100';
  process.env.TASK_WRITE_TRANSACTION_SIZE ||= '100';
  process.env.TASK_ASSIGN_BATCH_SIZE ||= '100';
  const here = path.dirname(fileURLToPath(import.meta.url));
  const appDir = path.resolve(here, '../src');
  const config = JSON.parse(await fs.readFile(path.join(here, 'v4-allocation-plan.json'), 'utf8'));
  const uploadDir = path.resolve(process.env.UPLOAD_DIR || 'uploads');
  const stateDir = path.join(uploadDir, '_allocation-plans', config.planId);
  const ledgerPath = path.join(stateDir, 'ledger.json');
  const command = process.argv[2] || 'sync';
  const mutating = !['repair-check', 'status'].includes(command);
  if (mutating) await fs.mkdir(stateDir, {recursive:true});
  if(command==='queue-project') {
    assert(process.argv[3],'Project name is required');
    const request={projectName:process.argv[3],requestedAt:new Date().toISOString(),status:'requested'};
    await fs.appendFile(path.join(stateDir,'project-requests.jsonl'),JSON.stringify(request)+'\n');
    console.log(JSON.stringify({event:'project_queued',...request}));
    return;
  }

  const {db, pool, runWithDatabaseContext} = await import(pathToFileURL(path.join(appDir, 'postgres.js')));
  // Export existing private helpers only in a disposable operations module.
  // The running application and its public exports remain unchanged.
  const temporaryModule = path.join(appDir, `.allocation-ops-${crypto.randomUUID()}.mjs`);
  const names = [
    'openZip64Archive','buildTaskTemplateRecords','assertTaskManifestValid',
    'bulkInsertSubjectTaskTemplates','bulkInsertSubjectTaskTemplateItems',
    'refreshSubjectTaskTemplateStats','bulkInsertImageRecords','bulkInsertThumbnailJobs',
    'parseTaskGenerationAssignees','prepareTaskGeneration','taskGenerationRequestSummary',
    'persistTaskGenerationJob','recordTaskGenerationStage','getProjectOrThrow',
    'projectPackageIds','createProject',
  ];
  await fs.writeFile(temporaryModule,
    await fs.readFile(path.join(appDir,'app.js'),'utf8') + `\nexport {${names.join(',')}};\n`,
    {flag:'wx'});
  let api;
  try { api = await import(pathToFileURL(temporaryModule)); }
  finally { await fs.unlink(temporaryModule); }
  let lockClient;
  try {
    lockClient = await pool.connect();
    if(mutating) {
      const lock = await lockClient.query('SELECT pg_try_advisory_lock(2026110301) AS locked');
      assert(lock.rows[0].locked, 'Another allocation operation is running');
    }
    const log = async (event, data = {}) => {
      const record = {at:new Date().toISOString(), event, ...data};
      console.log(JSON.stringify(record));
      if (mutating) await fs.appendFile(path.join(stateDir,'events.jsonl'), JSON.stringify(record)+'\n');
    };
    const atomicJson = async (target, value) => {
      const tmp = `${target}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(value,null,2)+'\n');
      await fs.rename(tmp,target);
    };
    const readLedger = async () => JSON.parse(await fs.readFile(ledgerPath,'utf8'));
    const saveLedger = async ledger => {
      ledger.updatedAt = new Date().toISOString();
      await atomicJson(ledgerPath,ledger);
      const priority = new Map((ledger.priorityRoster||[]).map(r=>[r.scorer,r.quota]));
      const columns = ['姓名','总配额',...ledger.projects.flatMap(p=>[`${p.name}基础`,`${p.name}回测`]),'已占用合计','剩余配额',
        ...(ledger.priorityRoster?['原计划待分配','新增额度待分配']:[])];
      const csv = [columns, ...ledger.roster.map(r=>[r.scorer,r.quota,
        ...ledger.projects.flatMap(p=>[p.actual?.[r.scorer]?.base||0,p.actual?.[r.scorer]?.backtest||0]),
        r.occupied||0,r.remaining??r.quota,
        ...(ledger.priorityRoster?[Math.max(0,(priority.get(r.scorer)||0)-(r.occupied||0)),
          r.remaining-Math.max(0,(priority.get(r.scorer)||0)-(r.occupied||0))]:[])])]
        .map(row=>row.map(v=>`"${String(v).replaceAll('"','""')}"`).join(',')).join('\n');
      await fs.writeFile(path.join(stateDir,'ledger.csv'),'\ufeff'+csv+'\n');
    };
    const assertIdle = async () => {
      const rows = await db.prepare("SELECT jobId, subjectId, status FROM task_generation_jobs WHERE status IN ('queued','running')").all();
      assert.equal(rows.length,0,`An application generation job is active: ${JSON.stringify(rows)}`);
    };
    const reconcile = async ledger => {
      const allowed = new Set(ledger.roster.map(r=>r.scorer));
      for (const project of ledger.projects) {
        const rows = await db.prepare(`SELECT scorer, status, isBacktest, COUNT(*)::integer AS count
          FROM rating_tasks WHERE projectId = ? AND taskVersion = 'v3'
          GROUP BY scorer,status,isBacktest`).all(project.id);
        project.actual = {};
        project.pending = 0;
        for (const row of rows) {
          if (row.status === 'pending') { project.pending += row.count; continue; }
          assert(allowed.has(row.scorer), `Unexpected scorer in ${project.name}: ${row.scorer}`);
          const item = project.actual[row.scorer] ||= {base:0,backtest:0,assigned:0,completed:0,total:0};
          item[row.isBacktest ? 'backtest':'base'] += row.count;
          item[row.status] += row.count;
          item.total += row.count;
        }
      }
      for (const row of ledger.roster) {
        row.occupied = ledger.projects.reduce((n,p)=>n+(p.actual[row.scorer]?.total||0),0);
        row.remaining = row.quota-row.occupied;
        assert(row.remaining>=0, `Quota exceeded for ${row.scorer}`);
      }
      ledger.summary = {
        quota:ledger.roster.reduce((n,r)=>n+r.quota,0),
        occupied:ledger.roster.reduce((n,r)=>n+r.occupied,0),
        remaining:ledger.roster.reduce((n,r)=>n+r.remaining,0),
        base:ledger.projects.reduce((n,p)=>n+Object.values(p.actual).reduce((a,r)=>a+r.base,0),0),
        backtest:ledger.projects.reduce((n,p)=>n+Object.values(p.actual).reduce((a,r)=>a+r.backtest,0),0),
      };
      if(ledger.priorityRoster) {
        const occupied = new Map(ledger.roster.map(r=>[r.scorer,r.occupied]));
        ledger.summary.priorityQuota=ledger.priorityRoster.reduce((n,r)=>n+r.quota,0);
        ledger.summary.priorityRemaining=ledger.priorityRoster.reduce((n,r)=>n+Math.max(0,r.quota-(occupied.get(r.scorer)||0)),0);
        ledger.summary.expansionRemaining=ledger.summary.remaining-ledger.summary.priorityRemaining;
      }
      return ledger;
    };
    const checkProject = project => {
      assert.equal(project.pending,0, `${project.name} still has pending materialized tasks`);
      for (const allocation of project.allocations) {
        const item = project.actual[allocation.scorer] || {total:0,base:0,backtest:0};
        assert.equal(item.total, allocation.taskCount, `${project.name}/${allocation.scorer} total mismatch`);
        assert.equal(item.backtest, allocation.taskCount/20, `${project.name}/${allocation.scorer} backtest mismatch`);
        assert.equal(item.base, allocation.taskCount*19/20, `${project.name}/${allocation.scorer} base mismatch`);
      }
    };

    async function initialize() {
      try { const ledger = await readLedger(); assert.equal(ledger.sourceSha256,config.sourceSha256); return ledger; }
      catch(error) { if (error.code !== 'ENOENT') throw error; }
      await assertIdle();
      const roster = config.roster.map(([scorer,quota])=>({scorer,quota}));
      assert.equal(new Set(roster.map(r=>r.scorer)).size,64);
      assert.equal(roster.reduce((n,r)=>n+r.quota,0),208000);
      let remaining = roster.map(r=>r.quota);
      const projects = [];
      for (const p of config.projects) {
        const current = await api.getProjectOrThrow(p.id);
        assert.equal(current.name,p.name);
        const row = await db.prepare("SELECT COUNT(*)::integer AS count FROM rating_tasks WHERE projectId=?").get(p.id);
        assert.equal(row.count,0,`Existing tasks in ${p.name}; inspect before initializing`);
        const counts = allocateUnits(remaining,p.taskCount);
        remaining = remaining.map((n,i)=>n-counts[i]);
        projects.push({...p,status:'planned',allocations:roster.map((r,i)=>({scorer:r.scorer,taskCount:counts[i]}))});
      }
      const ledger = {version:1,planId:config.planId,sourceFile:config.sourceFile,sourceSha256:config.sourceSha256,
        createdAt:new Date().toISOString(),backtestRatio:5,taskVersion:'v3',roster,projects,
        excludedProjects:['V4_REAL_1.6'],futurePolicy:'Add only projects/packages explicitly supplied by the user. Reconcile live tasks before allocating remaining quotas.'};
      await reconcile(ledger); await saveLedger(ledger);
      await log('initialized', {summary:ledger.summary,projects:projects.map(p=>({name:p.name,taskCount:p.taskCount}))});
      return ledger;
    }

    async function repairGt(write, projectId = config.repairProjectId) {
      const project = await api.getProjectOrThrow(projectId);
      const packageIds = await api.projectPackageIds(project);
      if(projectId===config.repairProjectId)assert.equal(packageIds.length,6);
      const sharp = (await import('sharp')).default;
      const {createThumbnail,thumbnailStoragePath} = await import(pathToFileURL(path.join(appDir,'image-assets.js')));
      let totalTemplates = 0;
      for (const packageId of packageIds) {
        const subject = await db.prepare('SELECT id,name,storageRoot,sourceZipPath,importBatch FROM subjects WHERE id=?').get(packageId);
        const zip = await api.openZip64Archive(path.join(uploadDir,subject.sourceZipPath));
        try {
          const taskEntries = zip.files.filter(e=>/(^|\/)tasks\.json$/i.test(e.path));
          assert.equal(taskEntries.length,1,`Expected one tasks.json in ${subject.name}`);
          const taskEntry = taskEntries[0];
          const taskManifest = JSON.parse((await taskEntry.buffer()).toString('utf8'));
          const prefix = path.posix.dirname(taskEntry.path);
          const images = await db.prepare('SELECT id,filename,originalPath,storagePath FROM images WHERE subjectId=?').all(packageId);
          const originalPaths = new Set(images.map(r=>r.originalPath));
          const additions=[];
          for (const task of taskManifest.tasks) for (const item of task.images) {
            const originalPath = path.posix.join(prefix,item.src_rel_path);
            item.src_rel_path=originalPath;
            if (originalPaths.has(originalPath)) continue;
            assert(originalPath.toLowerCase().endsWith('.avif'), `Unexpected missing image: ${originalPath}`);
            const entry=zip.files.find(e=>e.path===originalPath);
            assert(entry,'AVIF entry is absent');
            const source=await entry.buffer();
            const raw=await sharp(source).raw().toBuffer();
            const webp=await sharp(source).webp({lossless:true}).toBuffer();
            assert(raw.equals(await sharp(webp).raw().toBuffer()),'Lossless conversion did not preserve pixels');
            const id='restored-'+crypto.createHash('sha256').update(packageId+'|'+originalPath).digest('hex').slice(0,32);
            const storagePath=path.posix.join(subject.storageRoot,'_recovered',`${id}.webp`);
            const thumbnailPath=thumbnailStoragePath(storagePath);
            const now=new Date().toISOString();
            const record={id,subjectId:packageId,filename:path.posix.basename(originalPath),originalPath,storagePath,thumbnailPath,
              mimeType:'image/webp',category:'未分类',directory:'',isInfographic:0,prompt:'',catalogData:null,
              importBatch:subject.importBatch,createdAt:now,updatedAt:now};
            additions.push({record,webp}); images.push(record); originalPaths.add(originalPath);
          }
          const built=api.buildTaskTemplateRecords(packageId,taskManifest,images,new Date().toISOString());
          api.assertTaskManifestValid(built.failedTasks);
          const existing=await db.prepare('SELECT id,sourceTaskId,imageKey,criterion,round FROM subject_task_templates WHERE subjectId=?').all(packageId);
          const bySource=new Map(existing.map(r=>[r.sourceTaskId,r]));
          const existingItems=existing.length ? await db.prepare(`SELECT i.templateId,i.imageId,i.position,i.role
            FROM subject_task_template_items i JOIN subject_task_templates t ON t.id=i.templateId
            WHERE t.subjectId=? ORDER BY i.templateId,i.position`).all(packageId) : [];
          const byTemplate=new Map();
          for(const {templateId,...item} of existingItems) {
            if(!byTemplate.has(templateId))byTemplate.set(templateId,[]);
            byTemplate.get(templateId).push(item);
          }
          assert(existing.length<=built.taskTemplates.length,'Unexpected extra templates');
          const missing=[];
          for (const t of built.taskTemplates) {
            const old=bySource.get(t.sourceTaskId);
            if(!old) {missing.push(t);continue;}
            assert.equal(old.imageKey,t.imageKey); assert.equal(old.criterion,t.criterion); assert.equal(old.round,t.round);
            assert.deepEqual(byTemplate.get(old.id)||[],t.items);
          }
          totalTemplates+=built.taskTemplates.length;
          await log(write?'repair_package':'repair_check',{package:subject.name,templates:built.taskTemplates.length,existing:existing.length,missing:missing.length,imagesToRestore:additions.length});
          if(!write)continue;
          for(const {record,webp} of additions) {
            const target=path.join(uploadDir,record.storagePath);
            await fs.mkdir(path.dirname(target),{recursive:true});
            try {await fs.writeFile(target,webp,{flag:'wx'});}
            catch(e){if(e.code!=='EEXIST')throw e;assert(webp.equals(await fs.readFile(target)));}
            await createThumbnail(target,path.join(uploadDir,record.thumbnailPath));
          }
          await runWithDatabaseContext(async()=>{
            await db.exec('BEGIN');
            try {
              await db.prepare('SELECT id FROM subjects WHERE id=? FOR UPDATE').get(packageId);
              if(additions.length) await api.bulkInsertImageRecords(additions.map(a=>a.record));
              // Small batches within one per-package transaction.
              for(let start=0;start<missing.length;start+=100) {
                const batch=missing.slice(start,start+100);
                await api.bulkInsertSubjectTaskTemplates(batch);
                await api.bulkInsertSubjectTaskTemplateItems(batch);
              }
              await api.refreshSubjectTaskTemplateStats(packageId);
              await db.prepare('UPDATE subjects SET imageCount=(SELECT COUNT(*) FROM images WHERE subjectId=?), updatedAt=? WHERE id=?')
                .run(packageId,new Date().toISOString(),packageId);
              await db.exec('COMMIT');
            }catch(e){await db.exec('ROLLBACK');throw e;}
          });
        }finally{zip.close();}
      }
      if(projectId===config.repairProjectId)assert.equal(totalTemplates,config.expectedRepairTemplates);
      await log(write?'repair_completed':'repair_check_completed',{totalTemplates});
    }

    async function registerProject(name, packageNames) {
      const ledger=await readLedger();
      await assertIdle(); await reconcile(ledger);
      assert(ledger.projects.every(p=>p.status==='completed'),'Finish or reconcile current batch first');
      const waitingKey=JSON.stringify([name,[...packageNames].sort()]);
      const defer=async reason=>{
        ledger.waitingInputs ||= [];
        ledger.waitingInputs=ledger.waitingInputs.filter(r=>r.key!==waitingKey);
        ledger.waitingInputs.push({key:waitingKey,name,packageNames,status:'waiting',reason,updatedAt:new Date().toISOString()});
        await saveLedger(ledger);await log('project_waiting',{project:name,packageNames,reason});
      };
      let project=await db.prepare('SELECT id,name FROM projects WHERE LOWER(name)=LOWER(?) AND deletionRequestedAt IS NULL').get(name);
      if(packageNames.length) {
        const ids=[];
        for(const packageName of packageNames) {
          const s=await db.prepare('SELECT id,status FROM subjects WHERE name=? AND deletionRequestedAt IS NULL').get(packageName);
          if(!s || s.status!=='imported')return defer(`Package not fully imported: ${packageName}`);
          ids.push(s.id);
        }
        if(project) {
          const current=await api.getProjectOrThrow(project.id);
          assert.deepEqual((await api.projectPackageIds(current)).sort(),[...new Set(ids)].sort(),'Existing project package conflict');
        } else {
          const created=await runWithDatabaseContext(()=>api.createProject({name,packageIds:ids}));
          project=await db.prepare('SELECT id,name FROM projects WHERE name=? AND deletionRequestedAt IS NULL').get(name);
          assert(project,`Project was not created: ${JSON.stringify(created)}`);
        }
      }
      if(!project)return defer(`Project not found yet: ${name}`);
      assert(!ledger.projects.some(p=>p.id===project.id),'Project is already in the ledger');
      let current;
      try {current=await api.getProjectOrThrow(project.id);}
      catch(e){if(e.status===409 || e.statusCode===409)return defer(e.message);throw e;}
      const ids=await api.projectPackageIds(current);
      const templates=await db.prepare(`SELECT COUNT(*)::integer AS count FROM subject_task_templates
        WHERE subjectId IN (${ids.map(()=>'?').join(',')})`).get(...ids);
      if(!templates.count)return defer('Imported images have no valid task templates; recover definitions before allocation');
      const capacity=await api.prepareTaskGeneration(project.id,{allocations:[{scorer:ledger.roster[0].scorer,taskCount:20}],backtestRatio:5},current);
      const occupied=await db.prepare("SELECT COUNT(*)::integer AS count FROM rating_tasks WHERE projectId=? AND status IN ('assigned','completed')").get(project.id);
      assert.equal(occupied.count,0,'Unregistered occupied project requires explicit reconciliation');
      const count=Math.min(Math.floor(capacity.availableTaskCount/19)*20,ledger.summary.remaining);
      assert(count>0,'No allocatable capacity or remaining quota');
      const allocations=allocatePriorityUnits(ledger.roster,count,ledger.priorityRoster);
      ledger.waitingInputs=(ledger.waitingInputs||[]).filter(r=>r.key!==waitingKey);
      ledger.projects.push({...project,status:'planned',taskCount:count,allocations:ledger.roster.map((r,i)=>({scorer:r.scorer,taskCount:allocations[i]}))});
      await reconcile(ledger); await saveLedger(ledger); await log('project_registered',{project:name,taskCount:count});
    }

    async function setQuotas(filename) {
      assert(filename,'Quota revision JSON is required');
      const text=await fs.readFile(path.resolve(filename),'utf8');
      const revision=JSON.parse(text);
      assert(/^[A-Za-z0-9_-]+$/.test(revision.revisionId),'Invalid revision ID');
      assert.equal(revision.policy,'finish_previous_quotas_first');
      assert.equal(revision.backtestRatio,5);
      const hash=crypto.createHash('sha256').update(text).digest('hex');
      const ledger=await readLedger();
      await assertIdle();await reconcile(ledger);
      const previous=(ledger.quotaRevisions||[]).find(r=>r.revisionId===revision.revisionId);
      if(previous) {
        assert.equal(previous.sha256,hash,'Revision ID was reused with different contents');
        await saveLedger(ledger);await log('quotas_already_updated',{revisionId:revision.revisionId,summary:ledger.summary});
        return;
      }
      assert(ledger.projects.every(p=>p.status==='completed'),'Complete or reconcile existing assignments before revising quotas');
      for(const p of ledger.projects)checkProject(p);
      const roster=revision.roster.map(([scorer,quota])=>({scorer,quota}));
      assert(roster.length>0);
      assert.equal(new Set(roster.map(r=>r.scorer)).size,roster.length,'Duplicate names in revision');
      assert(roster.every(r=>typeof r.scorer==='string'&&r.scorer.trim()===r.scorer&&r.scorer&&Number.isInteger(r.quota)&&r.quota>=0&&r.quota%20===0),'Quotas must be nonnegative whole-20 counts');
      const revised=new Map(roster.map(r=>[r.scorer,r.quota]));
      for(const r of ledger.roster)assert(revised.has(r.scorer)&&revised.get(r.scorer)>=r.quota,`Existing quota was removed or reduced: ${r.scorer}`);
      const users=await db.prepare(`SELECT username,role,status FROM users WHERE username IN (${roster.map(()=>'?').join(',')})`).all(...roster.map(r=>r.scorer));
      for(const r of roster)assert(users.some(u=>u.username===r.scorer&&u.role==='scorer'&&u.status==='enabled'),`Scorer is missing or unavailable: ${r.scorer}`);
      const backupPath=path.join(stateDir,`ledger.before-${revision.revisionId}.json`);
      try{await fs.writeFile(backupPath,JSON.stringify(ledger,null,2)+'\n',{flag:'wx'});}
      catch(e){if(e.code!=='EEXIST')throw e;}
      const priorQuota=ledger.summary.quota;
      ledger.priorityRoster=ledger.roster.map(({scorer,quota})=>({scorer,quota}));
      ledger.roster=roster;
      ledger.quotaRevisions||=[];
      ledger.quotaRevisions.push({revisionId:revision.revisionId,sha256:hash,appliedAt:new Date().toISOString(),
        policy:revision.policy,priorQuota,totalQuota:roster.reduce((n,r)=>n+r.quota,0),source:revision.source});
      ledger.version=2;
      ledger.activeQuotaRevision=revision.revisionId;
      ledger.allocationPolicy='Fill each priorityRoster quota first, in its original row order; only then allocate the expanded quotas in the current roster order. Both phases use remaining-quota proportions and whole-20 units including 5% backtests.';
      await atomicJson(path.join(stateDir,`${revision.revisionId}.json`),revision);
      await reconcile(ledger);await saveLedger(ledger);
      await log('quotas_updated',{revisionId:revision.revisionId,rosterCount:roster.length,summary:ledger.summary});
    }

    async function runAllocation() {
      let ledger=await readLedger();
      await assertIdle(); await reconcile(ledger); await saveLedger(ledger);
      for (const project of ledger.projects) {
        if(project.status==='completed'){checkProject(project);continue;}
        assert.equal(project.status,'planned',`Inspect interrupted project before resuming: ${project.name}`);
        assert.equal(Object.values(project.actual).reduce((n,r)=>n+r.total,0),0,`Unexpected occupied tasks in ${project.name}`);
        assert.deepEqual(project.allocations.map(a=>a.taskCount),allocatePriorityUnits(ledger.roster,project.taskCount,ledger.priorityRoster),
          `Remaining quotas or priority changed after registering ${project.name}; reconcile the plan first`);
        await assertIdle();
        const teamRows=await db.prepare(`SELECT DISTINCT teams.id FROM teams JOIN user_teams ON teams.id=user_teams.teamId
          JOIN users ON users.id=user_teams.userId WHERE users.username IN (${ledger.roster.map(()=>'?').join(',')}) AND teams.status='enabled'`).all(...ledger.roster.map(r=>r.scorer));
        const assignment=await api.parseTaskGenerationAssignees({teamIds:teamRows.map(r=>r.id),teamMatchMode:'any',
          backtestRatio:5,allocations:project.allocations.filter(a=>a.taskCount>0)});
        for(const a of assignment.allocations) assert(a.taskCount<=ledger.roster.find(r=>r.scorer===a.scorer).remaining);
        const current=await api.getProjectOrThrow(project.id);
        const prepared=await api.prepareTaskGeneration(project.id,assignment,current);
        const now=new Date().toISOString();
        const job={jobId:crypto.randomUUID(),subjectId:project.id,status:'running',stage:'按持久配额计划分配',progress:0,
          message:null,request:api.taskGenerationRequestSummary(assignment,prepared),stageEvents:[],result:null,
          createdAt:now,updatedAt:now,expiresAt:new Date(Date.now()+7*86400000).toISOString()};
        project.status='running'; project.jobId=job.jobId; project.startedAt=now;
        await runWithDatabaseContext(()=>api.persistTaskGenerationJob(job));
        await saveLedger(ledger); await log('project_started',{project:project.name,jobId:job.jobId,request:job.request});
        let writes=Promise.resolve(),lastPersist=0,lastStage='';
        const progress=patch=>{
          if(patch.stage===lastStage && Date.now()-lastPersist<5000)return;
          lastPersist=Date.now(); lastStage=patch.stage;
          writes=writes.then(async()=>{
            job.stage=patch.stage;job.progress=patch.progress;
            api.recordTaskGenerationStage(job,job.stage,job.progress);
            await runWithDatabaseContext(()=>api.persistTaskGenerationJob(job));
            await log('progress',{project:project.name,...patch});
          }).catch(async e=>{await log('progress_persist_error',{project:project.name,message:e.message});});
        };
        try {
          const result=await runWithDatabaseContext(()=>api.generateSubjectTasks(project.id,assignment,progress));
          await writes;
          job.status='completed';job.stage='配额计划分配完成';job.progress=100;job.result=result;
          api.recordTaskGenerationStage(job,job.stage,100,true);
          await runWithDatabaseContext(()=>api.persistTaskGenerationJob(job));
          await reconcile(ledger);checkProject(project);
          project.status='completed';project.completedAt=new Date().toISOString();
          await saveLedger(ledger);await log('project_completed',{project:project.name,result,summary:ledger.summary});
        }catch(e){
          await writes;
          project.status='needs_reconciliation';project.error=e.message;
          job.status='failed';job.stage='需要核对实际任务及回滚结果';job.message=e.message;
          await runWithDatabaseContext(()=>api.persistTaskGenerationJob(job));
          await reconcile(ledger);await saveLedger(ledger);await log('allocation_failed',{project:project.name,message:e.message,summary:ledger.summary});
          throw e;
        }
      }
      await reconcile(ledger);await saveLedger(ledger);
      await log('batch_completed',{summary:ledger.summary});
    }

    if(command==='init') await initialize();
    else if(command==='repair-check'||command==='repair') await repairGt(command==='repair',process.argv[3]||config.repairProjectId);
    else if(command==='run') await runAllocation();
    else if(command==='set-quotas') await setQuotas(process.argv[3]);
    else if(command==='sync'||command==='status') {
      const ledger=await reconcile(await readLedger());
      if(command==='sync')await saveLedger(ledger);
      await log('status',{summary:ledger.summary,projects:ledger.projects.map(p=>({name:p.name,status:p.status,pending:p.pending,actual:Object.values(p.actual).reduce((n,r)=>n+r.total,0)}))});
    }else if(command==='add-project'||command==='create-project') {
      assert(process.argv[3],'Project name is required');
      await registerProject(process.argv[3],command==='create-project'?process.argv.slice(4):[]);
    }else throw new Error(`Unknown command: ${command}`);
  }finally{
    if(lockClient){await lockClient.query('SELECT pg_advisory_unlock(2026110301)');lockClient.release();}
    await pool.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().catch(error=>{console.error(error);process.exitCode=1;});
}
