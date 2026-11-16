import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { once } from "node:events";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

process.env.TASK_GENERATION_WORKER = "1";
process.env.PG_STATEMENT_TIMEOUT_MS ||= "120000";
const BASELINE = process.env.BASELINE;
const OUTPUT_DIR = process.env.OUTPUT_DIR;
const EXPECTED = Number(process.env.EXPECTED_TASK_COUNT || 0);
const END = process.env.END_CUTOFF;
if (!BASELINE || !OUTPUT_DIR || !EXPECTED || !END) throw new Error("BASELINE, OUTPUT_DIR, EXPECTED_TASK_COUNT required");
const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "../src");
const token = crypto.randomUUID();
const tempApp = path.join(appDir, `.new-completed-${token}.mjs`);
const DIMENSIONS = new Set(["anatomyNormality","realism","color","creativity","saturation","highInfoAes","sparse_info","illustration","photography","portrait","poster","lighting"]);
const TYPES = new Set(["GT_GT","GT_GEN","GT_ROLL","ROLL_ROLL","GEN_GEN","GEN_ROLL","UNKNOWN"]);
const FALLBACK = new Map([
 ["V4_GT_RE_1.6","GT_GEN"],["V4_UG_1.6","GEN_ROLL"],["V4_CREATIVITY_1.6","GT_GT"],["V4_COLORS_1.6","GT_GT"],
 ["V4_REALISM_1104","GT_GT"],["V4_LIGHTING_1104","GT_GT"],["V4_INFO_CREATIVITY_GT_1104","GT_GT"],["V4_LIGHTING_GT_1104","GT_GT"],
 ["V4_HUMANREFINER_VS_REPAIRED_1104","GEN_ROLL"],["V4_ROLLOUT_VS_REPAIRED_1104","ROLL_ROLL"],
 ["V4_INFO_CREATIVITY_ORIGINAL_VS_ROLLOUT_1104","GT_ROLL"],["V4_INFO_REALISM_ORIGINAL_VS_ROLLOUT_1104","GT_ROLL"],["V4_INFO_LIGHTING_ORIGINAL_VS_ROLLOUT_1104","GT_ROLL"]
]);
function label(p){const v=String(p||'').toLowerCase();if(!v)return null;if(v.includes('source_images_part')||v.includes('s3_source_images')||/(^|[/_])original([_/.-]|$)/.test(v)||/(^|[/_])gt([_/.-]|$)/.test(v))return 'GT';if(/(^|[/_])(rollout|repaired|improved)([_/.-]|$)/.test(v))return 'ROLL';if(v.includes('cci_images')||v.includes('u15_sft')||v.includes('u16_mt')||v.includes('qwen-image')||v.includes('ideogram')||/(^|[/_])mj([_/.-]|$)/.test(v)||v.includes('gpt-image')||/_seed\d*/.test(v))return 'GEN';return null;}
function pair(a,b){const x=[a,b].sort((u,v)=>['GT','GEN','ROLL'].indexOf(u)-['GT','GEN','ROLL'].indexOf(v));const k=`${x[0]}_${x[1]}`;return TYPES.has(k)?k:null;}
function classify(t){const ls=(t.items||[]).slice(0,2).map(x=>label(x?.image?.originalPath));if(ls.length===2&&ls.every(Boolean)&&pair(ls[0],ls[1]))return [pair(ls[0],ls[1]),'image_path'];const f=FALLBACK.get(t.subjectName);return f?[f,'project_fallback']:['UNKNOWN','unresolved'];}
class W{constructor(d,s){this.d=d;this.s=s;this.n=0;this.name=`${d}__${s}.json.gz`;this.path=path.join(OUTPUT_DIR,this.name);this.g=createGzip({level:6});this.file=createWriteStream(`${this.path}.partial`,{flags:'wx'});this.done=pipeline(this.g,this.file);this.g.write(JSON.stringify({classificationVersion:'v4-source-pair-v1',dimension:d,sourceType:s,BASELINE,source:'new-completed-only'}).slice(0,-1)+',"tasks":[');}async add(t){if(!this.g.write(`${this.n?',':''}${JSON.stringify(t)}`))await once(this.g,'drain');this.n++;}async close(){this.g.end(']}');await this.done;await fs.rename(`${this.path}.partial`,this.path);const st=await fs.stat(this.path);return {dimension:this.d,sourceType:this.s,taskCount:this.n,filename:this.name,compressedBytes:st.size,sha256:await sha(this.path)};}}
async function sha(p){const h=crypto.createHash('sha256');for await(const c of createReadStream(p))h.update(c);return h.digest('hex');}
await fs.mkdir(OUTPUT_DIR,{recursive:false});
const source=await fs.readFile(path.join(appDir,'app.js'),'utf8');
await fs.writeFile(tempApp,`${source}\nexport { hydrateTaskRows };\n`,{flag:'wx'});
let pool;
try{
 const {db,pool:p}=await import(pathToFileURL(path.join(appDir,'postgres.js')));pool=p;
 const app=await import(pathToFileURL(tempApp));
 const c=await pool.connect(); const writers=new Map(); let total=0,backtest=0,lastTime=BASELINE,lastId=''; const rules={},unknown={};
 try{while(true){const q=await c.query(`SELECT t.id,t.subjectid AS "subjectId",t.projectid AS "projectId",t.taskversion AS "taskVersion",t.tasktype AS "taskType",t.status,t.scorer,t.ranking,t.excludedimageids AS "excludedImageIds",t.correctimageids AS "correctImageIds",t.rankingrelations AS "rankingRelations",t.submissionmode AS "submissionMode",t.rankingactioncount AS "rankingActionCount",t.largeimageopened AS "largeImageOpened",t.isbacktest AS "isBacktest",t.backtestsourceid AS "backtestSourceId",t.startedat AS "startedAt",t.completedat AS "completedAt",t.durationms AS "durationMs",t.editedat AS "editedAt",t.editcount AS "editCount",t.rollbackcount AS "rollbackCount",t.lastrolledbackat AS "lastRolledBackAt",t.lastrolledbackby AS "lastRolledBackBy",t.imagekey AS "imageKey",t.createdat AS "createdAt",t.updatedat AS "updatedAt",p.name AS "subjectName" FROM rating_tasks t JOIN projects p ON p.id=t.projectid WHERE t.status='completed' AND t.completedat > $1::timestamptz AND t.completedat <= $4::timestamptz AND (t.completedat,t.id) > ($2::timestamptz,$3::text) AND p.createdat >= (SELECT createdat FROM projects WHERE name='V4_IMAGES_01') ORDER BY t.completedat,t.id LIMIT 5000`,[BASELINE,lastTime,lastId,END]);if(!q.rows.length)break;const hydrated=await app.hydrateTaskRows(q.rows,{includeAdminFields:true});for(const t of hydrated){const [s,rule]=classify(t);const d=t.criterion;if(!DIMENSIONS.has(d)||!TYPES.has(s))throw new Error(`bad class ${d}/${s}`);let w=writers.get(`${d}__${s}`);if(!w){w=new W(d,s);writers.set(`${d}__${s}`,w);}await w.add(t);total++;if(t.isBacktest)backtest++;rules[rule]=(rules[rule]||0)+1;if(s==='UNKNOWN')unknown[t.subjectName]=(unknown[t.subjectName]||0)+1;}const last=q.rows[q.rows.length-1];lastTime=last.completedAt instanceof Date?last.completedAt.toISOString():new Date(last.completedAt).toISOString();lastId=last.id;if(total%10000===0)console.log(JSON.stringify({event:'progress',total,expected:EXPECTED}));}}
 finally{c.release();}
 if(total!==EXPECTED)throw new Error(`count mismatch ${total} != ${EXPECTED}`);const slices=[];for(const w of writers.values())slices.push(await w.close());slices.sort((a,b)=>a.dimension.localeCompare(b.dimension)||a.sourceType.localeCompare(b.sourceType));const manifest={generatedAt:new Date().toISOString(),classificationVersion:'v4-source-pair-v1',BASELINE,END,taskCount:total,backtestCount:backtest,nonEmptySliceCount:slices.length,countsByRule:rules,unknownByProject:unknown,slices};await fs.writeFile(path.join(OUTPUT_DIR,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({event:'completed',...manifest}));
}finally{await fs.unlink(tempApp).catch(()=>{});await pool?.end();}
