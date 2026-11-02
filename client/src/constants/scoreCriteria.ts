export const scoreCriteria = [
  { key: "overall", label: "整体美感总分", group: "整体美感总分" },
  { key: "creativity", label: "辨识度与创意感", group: "艺术类" },
  { key: "mood", label: "情绪与意境传达", group: "艺术类" },
  { key: "composition", label: "构图与视觉层级", group: "艺术类" },
  { key: "color", label: "色彩配比", group: "艺术类" },
  { key: "saturation", label: "饱和度", group: "艺术类" },
  { key: "lighting", label: "光照/光影", group: "艺术类" },
  { key: "realism", label: "（肖像/摄像）真实感", group: "艺术类" },
  { key: "detail", label: "细节与逻辑分辨率", group: "艺术类" },
  { key: "promptAlignment", label: "Prompt alignment", group: "技术类" },
  { key: "textCorrectness", label: "文字：正确性", group: "技术类" },
  { key: "anatomyNormality", label: "肢体：正常性", group: "技术类" },
  {
    key: "informationClarity",
    label: "信息传达是否突出/明确",
    group: "信息图类评分追加",
  },
  { key: "designQuality", label: "整体设计感", group: "信息图类评分追加" },
  { key: "typography", label: "文字设计感", group: "信息图类评分追加" },
  { key: "highInfoAes", label: "高密度信息图美感", group: "信息图类评分追加" },
] as const;

export const taskCriteria = [
  { key: "overall", label: "整体美感总分", group: "整体美感总分" },
  { key: "creativity", label: "辨识度与创意感", group: "艺术类" },
  { key: "mood", label: "情绪与意境传达", group: "艺术类" },
  { key: "composition", label: "构图与视觉层级", group: "艺术类" },
  { key: "color", label: "色彩配比", group: "艺术类" },
  { key: "saturation", label: "饱和度", group: "艺术类" },
  { key: "lighting", label: "光照/光影", group: "艺术类" },
  { key: "realism", label: "（肖像/摄像）真实感", group: "艺术类" },
  { key: "detail", label: "细节与逻辑分辨率", group: "艺术类" },
  { key: "promptAlignment", label: "Prompt alignment", group: "技术类" },
  { key: "textCorrectness", label: "文字：正确性", group: "技术类" },
  { key: "anatomyNormality", label: "肢体：正常性", group: "技术类" },
  {
    key: "informationClarity",
    label: "信息传达是否突出/明确",
    group: "信息图类评分追加",
  },
  { key: "designQuality", label: "整体设计感", group: "信息图类评分追加" },
  { key: "typography", label: "文字设计感", group: "信息图类评分追加" },
  { key: "highInfoAes", label: "高密度信息图美感", group: "信息图类评分追加" },
] as const;

export type TaskCriterionKey = (typeof taskCriteria)[number]["key"];

export type ScoreCriterionKey = (typeof scoreCriteria)[number]["key"];
export type ScoreRange = [number, number];

export const notApplicableScoreCriterionKeys = [
  "promptAlignment",
  "textCorrectness",
  "anatomyNormality",
  "informationClarity",
  "designQuality",
  "typography",
] as const satisfies readonly ScoreCriterionKey[];

export type NotApplicableScoreCriterionKey =
  (typeof notApplicableScoreCriterionKeys)[number];

const notApplicableScoreCriterionSet: ReadonlySet<ScoreCriterionKey> = new Set(
  notApplicableScoreCriterionKeys,
);

export function canMarkNotApplicable(
  key: ScoreCriterionKey,
): key is NotApplicableScoreCriterionKey {
  return notApplicableScoreCriterionSet.has(key);
}
