import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { createGunzip, createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

const SOURCE_PATH = process.env.SOURCE_PATH;
const OUTPUT_DIR = process.env.OUTPUT_DIR;
const EXPECTED_TASK_COUNT = Number(process.env.EXPECTED_TASK_COUNT || 0);
const SOURCE_SHA256 = process.env.SOURCE_SHA256 || null;
const CLASSIFICATION_VERSION = "v4-source-pair-v1";

if (!SOURCE_PATH || !OUTPUT_DIR || !EXPECTED_TASK_COUNT) {
  throw new Error("SOURCE_PATH, OUTPUT_DIR and EXPECTED_TASK_COUNT are required");
}

const DIMENSIONS = new Set([
  "anatomyNormality",
  "realism",
  "color",
  "creativity",
  "saturation",
  "highInfoAes",
  "sparse_info",
  "illustration",
  "photography",
  "portrait",
  "poster",
  "lighting",
]);
const SOURCE_TYPES = new Set([
  "GT_GT",
  "GT_GEN",
  "GT_ROLL",
  "ROLL_ROLL",
  "GEN_GEN",
  "GEN_ROLL",
  "UNKNOWN",
]);

const PROJECT_FALLBACK = new Map([
  ["V4_GT_RE_1.6", "GT_GEN"],
  ["V4_UG_1.6", "GEN_ROLL"],
  ["V4_CREATIVITY_1.6", "GT_GT"],
  ["V4_COLORS_1.6", "GT_GT"],
  ["V4_REALISM_1104", "GT_GT"],
  ["V4_LIGHTING_1104", "GT_GT"],
  ["V4_INFO_CREATIVITY_GT_1104", "GT_GT"],
  ["V4_LIGHTING_GT_1104", "GT_GT"],
  ["V4_HUMANREFINER_VS_REPAIRED_1104", "GEN_ROLL"],
  ["V4_ROLLOUT_VS_REPAIRED_1104", "ROLL_ROLL"],
  ["V4_INFO_CREATIVITY_ORIGINAL_VS_ROLLOUT_1104", "GT_ROLL"],
  ["V4_INFO_REALISM_ORIGINAL_VS_ROLLOUT_1104", "GT_ROLL"],
  ["V4_INFO_LIGHTING_ORIGINAL_VS_ROLLOUT_1104", "GT_ROLL"],
]);

function sourceLabel(originalPath) {
  const value = String(originalPath || "").toLowerCase();
  if (!value) return null;
  if (
    value.includes("source_images_part") ||
    value.includes("s3_source_images") ||
    /(^|[/_])original([_/.-]|$)/.test(value)
  ) return "GT";
  if (/(^|[/_])(rollout|repaired|improved)([_/.-]|$)/.test(value)) return "ROLL";
  if (/(^|[/_])gt([_/.-]|$)/.test(value)) return "GT";
  if (
    value.includes("cci_images") ||
    value.includes("u15_sft") ||
    value.includes("u16_mt") ||
    value.includes("qwen-image") ||
    value.includes("ideogram") ||
    /(^|[/_])mj([_/.-]|$)/.test(value) ||
    value.includes("gpt-image") ||
    /_seed\d*/.test(value)
  ) return "GEN";
  return null;
}

function canonicalPair(left, right) {
  const labels = [left, right].sort(
    (a, b) => ["GT", "GEN", "ROLL"].indexOf(a) - ["GT", "GEN", "ROLL"].indexOf(b),
  );
  const key = `${labels[0]}_${labels[1]}`;
  return SOURCE_TYPES.has(key) ? key : null;
}

function classifyTask(task) {
  const paths = Array.isArray(task.items)
    ? task.items.map((item) => item?.image?.originalPath || "")
    : [];
  const labels = paths.slice(0, 2).map(sourceLabel);
  if (labels.length === 2 && labels.every(Boolean)) {
    const direct = canonicalPair(labels[0], labels[1]);
    if (direct) return { sourceType: direct, rule: "image_path" };
  }
  const fallback = PROJECT_FALLBACK.get(task.subjectName);
  if (fallback) return { sourceType: fallback, rule: "project_fallback" };
  return { sourceType: "UNKNOWN", rule: "unresolved" };
}

async function* taskObjectsFromGzip(sourcePath) {
  const gunzip = createGunzip();
  const input = createReadStream(sourcePath);
  const pipePromise = pipeline(input, gunzip);
  gunzip.setEncoding("utf8");
  const marker = '"tasks":[';
  let markerBuffer = "";
  let started = false;
  let finished = false;
  let objectBuffer = "";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for await (let chunk of gunzip) {
    if (finished) continue;
    if (!started) {
      markerBuffer += chunk;
      const index = markerBuffer.indexOf(marker);
      if (index < 0) {
        markerBuffer = markerBuffer.slice(-marker.length);
        continue;
      }
      chunk = markerBuffer.slice(index + marker.length);
      markerBuffer = "";
      started = true;
    }

    for (let index = 0; index < chunk.length; index += 1) {
      const character = chunk[index];
      if (depth === 0) {
        if (/\s|,/.test(character)) continue;
        if (character === "]") {
          finished = true;
          break;
        }
        if (character !== "{") throw new Error(`Unexpected task array character: ${character}`);
        objectBuffer = "{";
        depth = 1;
        inString = false;
        escaped = false;
        continue;
      }

      objectBuffer += character;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          yield JSON.parse(objectBuffer);
          objectBuffer = "";
        }
      }
    }
  }
  await pipePromise;
  if (!started || !finished || depth !== 0) throw new Error("Source JSON ended before the tasks array completed");
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

class SliceWriter {
  constructor({ dimension, sourceType }) {
    this.dimension = dimension;
    this.sourceType = sourceType;
    this.count = 0;
    this.filename = `${dimension}__${sourceType}.json.gz`;
    this.finalPath = path.join(OUTPUT_DIR, this.filename);
    this.partialPath = `${this.finalPath}.partial`;
    this.gzip = createGzip({ level: 6 });
    this.file = createWriteStream(this.partialPath, { flags: "wx" });
    this.pipePromise = pipeline(this.gzip, this.file);
    this.gzip.write(JSON.stringify({
      classificationVersion: CLASSIFICATION_VERSION,
      dimension,
      sourceType,
      sourceFile: path.basename(SOURCE_PATH),
    }).slice(0, -1) + ',"tasks":[');
  }

  async write(task) {
    const payload = `${this.count ? "," : ""}${JSON.stringify(task)}`;
    if (!this.gzip.write(payload)) await once(this.gzip, "drain");
    this.count += 1;
  }

  async close() {
    this.gzip.end("]}");
    await this.pipePromise;
    await fs.rename(this.partialPath, this.finalPath);
    const stat = await fs.stat(this.finalPath);
    return {
      dimension: this.dimension,
      sourceType: this.sourceType,
      taskCount: this.count,
      filename: this.filename,
      compressedBytes: stat.size,
      sha256: await sha256File(this.finalPath),
    };
  }
}

await fs.mkdir(OUTPUT_DIR, { recursive: false });
const writers = new Map();
const countsByRule = {};
const unknownByProject = {};
let total = 0;
let backtestCount = 0;

for await (const task of taskObjectsFromGzip(SOURCE_PATH)) {
  const dimension = task.criterion;
  if (!DIMENSIONS.has(dimension)) throw new Error(`Unexpected dimension: ${dimension}`);
  const classification = classifyTask(task);
  if (!SOURCE_TYPES.has(classification.sourceType)) {
    throw new Error(`Unexpected source type: ${classification.sourceType}`);
  }
  const key = `${dimension}__${classification.sourceType}`;
  let writer = writers.get(key);
  if (!writer) {
    writer = new SliceWriter({ dimension, sourceType: classification.sourceType });
    writers.set(key, writer);
  }
  await writer.write(task);
  total += 1;
  if (task.isBacktest) backtestCount += 1;
  countsByRule[classification.rule] = (countsByRule[classification.rule] || 0) + 1;
  if (classification.sourceType === "UNKNOWN") {
    unknownByProject[task.subjectName] = (unknownByProject[task.subjectName] || 0) + 1;
  }
  if (total % 25000 === 0) {
    process.stdout.write(`${JSON.stringify({ event: "progress", total, expected: EXPECTED_TASK_COUNT })}\n`);
  }
}

if (total !== EXPECTED_TASK_COUNT) {
  throw new Error(`Task count mismatch: ${total} != ${EXPECTED_TASK_COUNT}`);
}

const slices = [];
for (const writer of writers.values()) slices.push(await writer.close());
slices.sort((a, b) =>
  a.dimension.localeCompare(b.dimension) || a.sourceType.localeCompare(b.sourceType),
);
const sliceTotal = slices.reduce((sum, slice) => sum + slice.taskCount, 0);
if (sliceTotal !== total) throw new Error(`Slice total mismatch: ${sliceTotal} != ${total}`);

const manifest = {
  generatedAt: new Date().toISOString(),
  classificationVersion: CLASSIFICATION_VERSION,
  sourceFile: path.basename(SOURCE_PATH),
  sourceSha256: SOURCE_SHA256,
  taskCount: total,
  backtestCount,
  dimensionCount: DIMENSIONS.size,
  sourceTypeCount: SOURCE_TYPES.size,
  nonEmptySliceCount: slices.length,
  countsByRule,
  unknownByProject,
  sourceTypes: [...SOURCE_TYPES],
  dimensions: [...DIMENSIONS],
  projectFallback: Object.fromEntries(PROJECT_FALLBACK),
  pathRules: {
    GT: ["source_images_part", "s3_source_images", "original", "gt"],
    GEN: ["cci_images", "u15_sft", "u16_mt", "qwen-image", "ideogram", "mj", "gpt-image", "seed"],
    ROLL: ["rollout", "repaired", "improved"],
  },
  slices,
};
await fs.writeFile(
  path.join(OUTPUT_DIR, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { flag: "wx" },
);
process.stdout.write(`${JSON.stringify({ event: "completed", ...manifest })}\n`);

