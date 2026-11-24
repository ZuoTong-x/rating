import type { db as database } from "../postgres.ts";

type ImageQuery = Record<string, unknown>;
type ImageRow = Record<string, any>;
type CatalogDependencies = {
  escapeLike: (value: unknown) => string;
  scoreFilterKeys: Set<string>;
  parseScoreRange: (value: unknown) => [number, number];
  skippableScoreFields: string[];
  scoreStateColumn: (key: string) => string;
  db: typeof database;
  imageSelectColumns: string;
  imageListSelectColumns: string;
  imageDto: (row: ImageRow) => unknown;
  imageListDto: (row: ImageRow) => unknown;
};

export function createCatalogService({
    escapeLike, scoreFilterKeys, parseScoreRange, skippableScoreFields,
    scoreStateColumn, db, imageSelectColumns, imageListSelectColumns,
    imageDto, imageListDto,
}: CatalogDependencies) {
function buildImageFilter(query: ImageQuery) {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (query.subjectId) {
    clauses.push("subjectId = ?");
    params.push(String(query.subjectId));
  }

  if (query.category) {
    clauses.push("category = ?");
    params.push(String(query.category));
  }

  if (query.filename) {
    clauses.push("filename LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(query.filename)}%`);
  }

  if (query.scorer) {
    clauses.push("scorer = ?");
    params.push(String(query.scorer));
  }

  if (query.status === "rated") {
    clauses.push("overall IS NOT NULL");
  } else if (query.status === "unrated") {
    clauses.push("overall IS NULL");
  }

  const keys = String(query.scoreCriteria || "")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => scoreFilterKeys.has(key));

  let scoreRanges: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(String(query.scoreRanges || "{}"));
    scoreRanges = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    scoreRanges = {};
  }

  for (const key of keys) {
    const [min, max] = parseScoreRange(scoreRanges[key]);
    if (skippableScoreFields.includes(key)) {
      clauses.push(`${scoreStateColumn(key)} = 'rated'`);
    }
    clauses.push(`${key} BETWEEN ? AND ?`);
    params.push(min, max);
  }

  return {
    where: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

async function listImages(query: ImageQuery) {
  const page = Math.max(Number(query.page) || 1, 1);
  const pageSize = Math.min(Math.max(Number(query.pageSize) || 20, 1), 100);
  const { where, params } = buildImageFilter(query);
  const includeTotal = ["1", "true", "yes"].includes(
    String(query.includeTotal ?? "").toLowerCase(),
  );
  const includeDetails = ["1", "true", "yes"].includes(
    String(query.includeDetails ?? "").toLowerCase(),
  );
  const total = includeTotal
    ? (await db.prepare(`SELECT COUNT(*) AS total FROM images${where}`).get(...params)).total
    : null;
  const selectColumns = includeDetails ? imageSelectColumns : imageListSelectColumns;
  const toDto = includeDetails ? imageDto : imageListDto;
  const items = (await db
    .prepare(
      `SELECT ${selectColumns} FROM images${where} ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize))
    .map(toDto);

  return { total, page, pageSize, items };
}

async function getCategories(subjectId: unknown) {
  const rows = subjectId
    ? await db
        .prepare(
          "SELECT category FROM images WHERE subjectId = ? GROUP BY category ORDER BY LOWER(category) ASC, category ASC",
        )
        .all(String(subjectId))
    : await db
        .prepare(
          "SELECT category FROM images GROUP BY category ORDER BY LOWER(category) ASC, category ASC",
        )
        .all();
  return rows.map((row) => row.category);
}

async function getScorers(subjectId: unknown) {
  const where = subjectId
    ? "subjectId = ? AND scorer IS NOT NULL AND scorer <> '' AND overall IS NOT NULL"
    : "scorer IS NOT NULL AND scorer <> '' AND overall IS NOT NULL";
  const rows = subjectId
    ? await db
        .prepare(
          `SELECT scorer FROM images WHERE ${where} GROUP BY scorer ORDER BY LOWER(scorer) ASC, scorer ASC`,
        )
        .all(String(subjectId))
    : await db
        .prepare(
          `SELECT scorer FROM images WHERE ${where} GROUP BY scorer ORDER BY LOWER(scorer) ASC, scorer ASC`,
        )
        .all();
  return rows.map((row) => row.scorer);
}

  return { listImages, getCategories, getScorers };
}
