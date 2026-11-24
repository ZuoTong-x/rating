type ScoreState = "unrated" | "rated" | "not_applicable";
type ScoreRow = Record<string, unknown>;
type ScoreDependencies = {
  httpError: (status: number, message: string) => Error;
  scoreNumericFields: string[];
  skippableScoreFields: string[];
  nowIso: () => string;
};

export function createScoreService({ httpError, scoreNumericFields, skippableScoreFields, nowIso }: ScoreDependencies) {
  function clampScore(value: unknown, fallback: number) {
    if (value === null || value === undefined || value === "") return fallback;
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    const rounded = Math.round(number);
    return Math.max(1, Math.min(10, rounded));
  }

  function parseScoreValue(value: unknown, key: string): number | null {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    if (
      !Number.isFinite(number) ||
      !Number.isInteger(number) ||
      number < 1 ||
      number > 10
    ) {
      throw httpError(400, `${key} 必须是 1-10 的整数`);
    }
    return number;
  }

  function scoreStateColumn(key: string) {
    return `${key}State`;
  }

  function parseScoreState(value: unknown, key: string): ScoreState | null {
    if (value === null || value === undefined || value === "") return null;
    const state = String(value);
    if (state !== "unrated" && state !== "rated" && state !== "not_applicable") {
      throw httpError(400, `${key} 状态不正确`);
    }
    return state;
  }

  function parseScoreRange(value: unknown): [number, number] {
    if (!Array.isArray(value)) return [1, 10];
    const min = clampScore(value[0], 1);
    const max = clampScore(value[1], 10);
    return [Math.min(min, max), Math.max(min, max)];
  }

  function parseNullableBoolean(value: unknown): 0 | 1 | null {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (value === 1 || value === "1" || value === "true") return 1;
    if (value === 0 || value === "0" || value === "false") return 0;
    throw httpError(400, "不舒适字段格式不正确");
  }

  function parseComment(value: unknown) {
    if (value === null || value === undefined) return "";
    const text = String(value).trim();
    if (text.length > 2000) throw httpError(400, "备注不能超过 2000 字");
    return text;
  }

  function escapeLike(value: unknown) {
    return String(value).replace(/[\\%_]/g, "\\$&");
  }

  function parseScorerName(value: unknown) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    if (!text) return null;
    if (text.length > 100) throw httpError(400, "打分人不能超过 100 字");
    return text;
  }

  function normalizeScorePayload(body: ScoreRow) {
    const payload: ScoreRow = {};
    const criterionStates =
      body.criterionStates && typeof body.criterionStates === "object"
        ? body.criterionStates as ScoreRow
        : {};

    for (const key of scoreNumericFields) {
      const isSkippable = skippableScoreFields.includes(key);
      const stateKey = scoreStateColumn(key);
      const requestedState = isSkippable
        ? parseScoreState(criterionStates[key] ?? body[stateKey], key)
        : null;

      if (requestedState === "not_applicable") {
        payload[key] = null;
        payload[stateKey] = "not_applicable";
        continue;
      }

      payload[key] = parseScoreValue(body[key], key);
      if (isSkippable) {
        payload[stateKey] = payload[key] === null ? "unrated" : "rated";
      }
    }
    payload.discomfort = parseNullableBoolean(body.discomfort);
    payload.comment = parseComment(body.comment);
    payload.scorer = parseScorerName(body.scorer);
    payload.ratedAt = nowIso();
    return payload;
  }

  function scoreFromRow(row: ScoreRow | null | undefined) {
    if (!row) return null;
    const criterionStates = Object.fromEntries(
      skippableScoreFields.map((key) => {
        const state = row[scoreStateColumn(key)];
        return [
          key,
          state === "unrated" || state === "rated" || state === "not_applicable"
            ? state
            : row[key] == null
              ? "unrated"
              : "rated",
        ];
      }),
    );

    return {
      overall: row.overall,
      creativity: row.creativity,
      mood: row.mood,
      composition: row.composition,
      color: row.color,
      lighting: row.lighting,
      realism: row.realism,
      detail: row.detail,
      discomfort:
        row.discomfort === null || row.discomfort === undefined
          ? null
          : Boolean(row.discomfort),
      promptAlignment: row.promptAlignment,
      textCorrectness: row.textCorrectness,
      anatomyNormality: row.anatomyNormality,
      informationClarity: row.informationClarity,
      designQuality: row.designQuality,
      typography: row.typography,
      criterionStates,
      scorer: row.scorer ?? null,
      comment: row.comment ?? "",
      ratedAt: row.ratedAt ?? null,
    };
  }

  return {
    clampScore, parseScoreValue, scoreStateColumn, parseScoreState,
    parseScoreRange, parseNullableBoolean, parseComment, escapeLike,
    parseScorerName, normalizeScorePayload, scoreFromRow,
  };
}
