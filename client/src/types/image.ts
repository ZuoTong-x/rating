import type { ScoreCriterionKey, ScoreRange, TaskCriterionKey } from '../constants/scoreCriteria';
import type { AvailabilityStatus } from './auth';

export type ScoreCriterionState = 'unrated' | 'rated' | 'not_applicable';
export type ScoreCriterionStates = Partial<Record<ScoreCriterionKey, ScoreCriterionState>>;

export interface ImageScore {
  overall?: number | null;
  creativity?: number | null;
  mood?: number | null;
  composition?: number | null;
  color?: number | null;
  lighting?: number | null;
  realism?: number | null;
  detail?: number | null;
  discomfort?: boolean | null;
  promptAlignment?: number | null;
  textCorrectness?: number | null;
  anatomyNormality?: number | null;
  informationClarity?: number | null;
  designQuality?: number | null;
  typography?: number | null;
  criterionStates?: ScoreCriterionStates;
  scorer?: string | null;
  comment?: string;
  ratedAt?: string;
}

export interface ImageCatalogData {
  case_id?: number | string;
  sample_index?: number;
  category_id?: string;
  category?: string;
  image_path?: string;
  image_filename?: string;
  model_folder?: string;
  prompt?: string;
  model_id?: string;
  model_name?: string;
  model_group?: string;
  is_ideogram?: boolean;
  prompt_type?: string;
  actual_input_prompt?: string;
  match_method?: string;
  width?: number;
  height?: number;
  seed?: number;
}

export interface SubjectItem {
  _id: string;
  name: string;
  originalFilename: string;
  importBatch: string;
  imageCount: number;
  categoryCount: number;
  taskTemplateCount: number;
  status: 'importing' | 'imported' | 'failed';
  taskStatus: 'task_pending' | 'scoring' | 'task_completed';
  deletionRequestedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  isLegacy?: boolean;
}

export interface ProjectItem {
  _id: string;
  name: string;
  packageId: string;
  packageIds: string[];
  packages: Array<{
    _id: string;
    name: string;
    originalFilename: string;
    imageCount: number;
    categoryCount: number;
    taskTemplateCount: number;
    status: SubjectItem['status'];
    createdAt?: string;
    updatedAt?: string;
  }>;
  packageName: string;
  packageNames: string[];
  packageFilename: string;
  packageStatus: SubjectItem['status'];
  imageCount: number;
  categoryCount: number;
  taskTemplateCount: number;
  generatedTaskCount: number;
  pendingTaskCount: number;
  remainingTemplateCount: number;
  availableTaskCount: number;
  taskStatus: SubjectItem['taskStatus'];
  teams: Array<{ id: string; name: string; status?: AvailabilityStatus }>;
  deletionRequestedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScorerProjectOption {
  _id: string;
  name: string;
}

export interface ProjectPage {
  total: number;
  page: number;
  pageSize: number;
  projects: ProjectItem[];
}

export interface ImageItem {
  _id: string;
  filename: string;
  originalPath?: string;
  category: string;
  directory: string;
  isInfographic?: boolean;
  prompt?: string | null;
  catalog?: ImageCatalogData | null;
  imageUrl: string;
  thumbnailUrl?: string | null;
  subjectId?: string;
  score?: ImageScore;
}

export interface ImageQuery {
  subjectId?: string | null;
  category?: string | null;
  filename?: string | null;
  status?: 'rated' | 'unrated' | null;
  scorer?: string | null;
  scoreCriteria?: ScoreCriterionKey[] | null;
  scoreRanges?: Partial<Record<ScoreCriterionKey, ScoreRange>> | null;
  includeTotal?: boolean;
  includeDetails?: boolean;
}
export interface ImagePage { total: number | null; page: number; pageSize: number; items: ImageItem[]; }

export interface RatingTaskItem {
  imageId: string;
  position: number;
  role: 'target' | 'filler' | 'anchor_low' | 'anchor_high' | 'boundary';
  image: ImageItem;
}

export type RankingRelation = '>' | '=';
export type TaskSubmissionMode = 'direct' | 'ranked';
export type TaskSubmissionModeFilter = TaskSubmissionMode | 'untracked';

export interface RatingTask {
  id: string;
  subjectId: string;
  projectId?: string;
  subjectName?: string | null;
  taskVersion: string;
  taskType: string;
  criterion?: TaskCriterionKey | null;
  status: 'pending' | 'assigned' | 'completed';
  scorer?: string | null;
  ranking?: string[] | null;
  rankingRelations?: RankingRelation[] | null;
  excludedImageIds?: string[] | null;
  correctImageIds?: string[] | null;
  submissionMode?: TaskSubmissionMode | null;
  rankingActionCount?: number;
  dragActionCount?: number;
  orderChanged?: boolean;
  largeImageOpened?: boolean;
  largeImageOpenCount?: number;
  behaviorTracked?: boolean;
  isBacktest?: boolean;
  backtestSourceTaskId?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  durationMs?: number | null;
  firstActionMs?: number | null;
  pageBlurCount?: number;
  riskScore?: number;
  riskFlags?: string[];
  imageKey: string;
  rollbackCount?: number;
  lastRolledBackAt?: string | null;
  lastRolledBackBy?: string | null;
  createdAt: string;
  updatedAt: string;
  items: RatingTaskItem[];
}

export interface ScoringSummaryScorer {
  scorer: string;
  projectCount: number;
  totalTaskCount: number;
  undraggedSubmitCount: number;
  directSubmitCount: number;
  rankedSubmitCount: number;
  untrackedSubmitCount: number;
  undraggedSubmitRate: number;
  directSubmitRate: number;
  largeImageOpenedCount: number;
  largeImageOpenedRate: number;
  highRiskCount: number;
  highRiskRate: number;
  fastSubmitCount: number;
  fastSubmitRate: number;
  noLargeImageCount: number;
  noLargeImageRate: number;
  orderUnchangedCount: number;
  orderUnchangedRate: number;
  behaviorTrackedCount: number;
  pageBlurCountTotal: number;
  averageRiskScore: number;
  maxRiskScore: number;
  averageDurationMs: number | null;
  averageDurationSeconds: number | null;
  minDurationMs: number | null;
  minDurationSeconds: number | null;
  maxDurationMs: number | null;
  maxDurationSeconds: number | null;
  rollbackCount: number;
}

export interface ScoringManagementSummary {
  scorerCount: number;
  page: number;
  pageSize: number;
  totalTaskCount: number;
  undraggedSubmitCount: number;
  directSubmitCount: number;
  rankedSubmitCount: number;
  untrackedSubmitCount: number;
  undraggedSubmitRate: number;
  directSubmitRate: number;
  largeImageOpenedCount: number;
  largeImageOpenedRate: number;
  highRiskCount: number;
  highRiskRate: number;
  fastSubmitCount: number;
  fastSubmitRate: number;
  noLargeImageCount: number;
  noLargeImageRate: number;
  orderUnchangedCount: number;
  orderUnchangedRate: number;
  behaviorTrackedCount: number;
  pageBlurCountTotal: number;
  averageRiskScore: number;
  maxRiskScore: number;
  scorers: ScoringSummaryScorer[];
}

export interface ScoringTaskRecord {
  taskId: string;
  projectId: string;
  projectName: string;
  criterion?: TaskCriterionKey | null;
  status: RatingTask['status'];
  scorer: string;
  submissionMode?: TaskSubmissionMode | null;
  rankingActionCount: number;
  dragActionCount: number;
  orderChanged: boolean;
  largeImageOpened: boolean;
  largeImageOpenCount: number;
  behaviorTracked: boolean;
  isBacktest?: boolean;
  backtestSourceTaskId?: string | null;
  durationMs: number | null;
  durationSeconds: number | null;
  firstActionMs: number | null;
  firstActionSeconds: number | null;
  pageBlurCount: number;
  riskScore: number;
  riskFlags: string[];
  completedAt: string | null;
  editedAt: string | null;
  editCount: number;
  rollbackCount: number;
  updatedAt: string;
}

export interface ScoringTaskRecordPage {
  total: number | null;
  page: number;
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
  tasks: ScoringTaskRecord[];
}

export interface ScoringRollbackGroup {
  id: string;
  name: string;
  taskCount: number;
}

export interface ScoringRollbackPreview {
  source?: 'task_ids' | 'scorer_full';
  sourceScorers?: string[];
  projectId?: string | null;
  submissionMode?: TaskSubmissionModeFilter | null;
  requestedTaskCount: number;
  uniqueTaskCount: number;
  duplicateTaskCount: number;
  matchedTaskCount: number;
  rollbackTaskCount: number;
  ignoredTaskCount: number;
  missingTaskCount: number;
  taskIds: string[];
  scorers: ScoringRollbackGroup[];
  projects: ScoringRollbackGroup[];
  assignees?: ScoringRollbackGroup[];
  tasks: ScoringTaskRecord[];
  ignoredTasks: ScoringTaskRecord[];
  missingTaskIds: string[];
  taskPreviewLimit: number;
  ignoredPreviewLimit: number;
  hasMoreTasks: boolean;
  hasMoreIgnored: boolean;
}

export interface ScoringRollbackResult extends ScoringRollbackPreview {
  rolledBackTaskCount: number;
  reassignedTaskCount?: number;
  rolledBackAt: string;
  rolledBackBy: string;
}

export interface ScoringRollbackJob {
  jobId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  stage: string;
  progress: number;
  message: string | null;
  requestedTaskCount: number;
  uniqueTaskCount: number;
  result?: ScoringRollbackResult;
}

export type AdminExportType =
  | 'project-completed-tasks'
  | 'scorer-completed-tasks'
  | 'scoring-operation-log'
  | 'scoring-risk-report'
  | 'team-task-summary'
  | 'project-task-report';

export interface AdminExportJob {
  jobId: string;
  type: AdminExportType;
  status: 'queued' | 'running' | 'completed' | 'failed';
  stage: string;
  progress: number;
  message: string | null;
  filename: string;
  contentType: string;
  downloadUrl?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  result?: Record<string, unknown>;
}

export interface RatingTaskPage {
  total: number;
  page: number;
  pageSize: number;
  tasks: RatingTask[];
}

export interface TaskListImage {
  _id: string;
  filename: string;
  imageUrl: string;
  thumbnailUrl: string | null;
}

export interface TaskListItemImage {
  position: number;
  image: TaskListImage;
}

export interface AdminTaskListItem {
  id: string;
  criterion?: TaskCriterionKey | null;
  status: 'pending' | 'assigned' | 'completed';
  scorer?: string | null;
  isBacktest?: boolean;
  backtestSourceTaskId?: string | null;
  createdAt: string;
  items: TaskListItemImage[];
}

export interface ScorerTaskListItem {
  id: string;
  subjectId: string;
  projectId?: string;
  subjectName?: string | null;
  criterion?: TaskCriterionKey | null;
  status: 'assigned' | 'completed';
  items: TaskListItemImage[];
}

export interface TaskListPage<T> {
  total: number | null;
  page: number;
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
  tasks: T[];
}

export interface SubjectTaskReportDimension {
  key: string;
  criterion: string;
  label: string;
  total: number;
  pending: number;
  assigned: number;
  completed: number;
  completionRate: number;
}

export interface SubjectTaskReportScorerDimension {
  key: string;
  label: string;
}

export interface SubjectTaskReportScorer {
  scorer: string;
  total: number;
  pending: number;
  assigned: number;
  uncompleted: number;
  completed: number;
  completionRate: number;
  dimensions: SubjectTaskReportScorerDimension[];
  averageDurationSeconds: number | null;
}

export interface SubjectTaskReport {
  subject: { _id: string; name: string };
  imageCount: number;
  categoryCount: number;
  criterionCount: number;
  totalTasks: number;
  statusCounts: { pending: number; assigned: number; completed: number };
  completedTasks: number;
  completionRate: number;
  scorerCount: number;
  dimensions: SubjectTaskReportDimension[];
  scorers: SubjectTaskReportScorer[];
}

export interface DashboardWorkloadOption {
  id: string;
  name: string;
  status: string | null;
  totalTaskCount: number;
  userCount?: number;
}

export interface DashboardWorkloadMetrics {
  projectCount: number;
  totalTaskCount: number;
  pendingTaskCount: number;
  completedTaskCount: number;
  completionRate: number;
  averageDurationSeconds: number | null;
}

export interface DashboardScorerProjectSummary extends Omit<DashboardWorkloadMetrics, 'projectCount'> {
  projectId: string;
  projectName: string;
  taskStatus: SubjectItem['taskStatus'];
}

export interface DashboardScorerSummary extends DashboardWorkloadMetrics {
  id: string;
  name: string;
  status: string | null;
  projects: DashboardScorerProjectSummary[];
}

export interface DashboardTeamMemberSummary extends DashboardWorkloadMetrics {
  id: string;
  name: string;
  status: string | null;
}

export interface DashboardTeamSummary extends DashboardWorkloadMetrics {
  id: string;
  name: string;
  status: string | null;
  userCount: number;
  members: DashboardTeamMemberSummary[];
}

export interface AdminDashboard {
  projectCount: number;
  completedProjectCount: number;
  teamCount: number;
  scorerCount: number;
  totalTaskCount: number;
  unassignedTaskCount: number;
  assignedTaskCount: number;
  pendingTaskCount: number;
  completedTaskCount: number;
  averageDurationSeconds: number | null;
  selectedProjectId: string | null;
  projectSummary: {
    projectId: string;
    projectName: string;
    taskStatus: SubjectItem['taskStatus'];
    packageCount: number;
    imageCount: number;
    categoryCount: number;
    taskTemplateCount: number;
    totalTasks: number;
    pendingTaskCount: number;
    unassignedTaskCount: number;
    assignedTaskCount: number;
    completedTaskCount: number;
    completionRate: number;
    scorerCount: number;
    criterionCount: number;
    averageDurationSeconds: number | null;
  } | null;
  peakHours: Array<{
    hour: number;
    label: string;
    count: number;
  }>;
  progressSummary: {
    scorers: Array<{
      id: string;
      name: string;
      status: string | null;
      totalTaskCount: number;
      pendingTaskCount: number;
      completedTaskCount: number;
      completionRate: number;
      averageDurationSeconds: number | null;
    }>;
    teams: Array<{
      id: string;
      name: string;
      status: string | null;
      totalTaskCount: number;
      pendingTaskCount: number;
      completedTaskCount: number;
      completionRate: number;
      averageDurationSeconds: number | null;
    }>;
  };
  workloadSummary: {
    selectedScorerId: string | null;
    selectedTeamId: string | null;
    scorers: DashboardWorkloadOption[];
    teams: DashboardWorkloadOption[];
    scorer: DashboardScorerSummary | null;
    team: DashboardTeamSummary | null;
  };
  total: number;
  page: number;
  pageSize: number;
  tasks: RatingTask[];
}

export type AdminDashboardStats = Pick<AdminDashboard,
  'projectCount' |
  'completedProjectCount' |
  'teamCount' |
  'scorerCount' |
  'totalTaskCount' |
  'unassignedTaskCount' |
  'assignedTaskCount' |
  'pendingTaskCount' |
  'completedTaskCount'
>;
export type AdminDashboardProjectSection = Pick<AdminDashboard, 'selectedProjectId' | 'projectSummary'>;
export type AdminDashboardCharts = Pick<AdminDashboard, 'peakHours'>;
export type AdminDashboardAverageDuration = Pick<AdminDashboard, 'averageDurationSeconds'>;
export type AdminDashboardWorkloadSection = AdminDashboard['workloadSummary'];

export interface ScorerDashboard {
  pendingTasks: number;
  completedTasks: number;
  totalTasks: number;
  projectCount: number;
  progress: number;
}

export type FeedbackType = 'platform_bug' | 'scoring_rule' | 'other';
export type FeedbackStatus = 'pending' | 'processing' | 'resolved';

export interface FeedbackImage {
  path: string;
  url: string;
}

export interface FeedbackMessage {
  id: string;
  author: string;
  authorRole: 'admin' | 'scorer';
  content: string;
  createdAt: string;
}

export interface FeedbackItem {
  id: string;
  title: string;
  type: FeedbackType;
  description: string;
  status: FeedbackStatus;
  submitter: string;
  submittedAt: string;
  reply: string;
  repliedBy: string | null;
  repliedAt: string | null;
  updatedAt: string;
  messages: FeedbackMessage[];
  images: FeedbackImage[];
}

export interface FeedbackPage {
  total: number;
  page: number;
  pageSize: number;
  items: FeedbackItem[];
}
