import { h, type VNodeChild } from "vue";
import { NIcon } from "naive-ui";

export interface AdminNavItem {
  label: string;
  key: string;
  keywords: string;
  icon: () => VNodeChild;
}

function createIcon(pathData: string): () => VNodeChild {
  return () =>
    h(NIcon, null, {
      default: () =>
        h(
          "svg",
          {
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            "stroke-width": "1.8",
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
            "aria-hidden": "true",
          },
          [h("path", { d: pathData })],
        ),
    });
}

const archiveIcon = createIcon("M3 7h6l2 2h10v10H3z M3 7l2-3h5l2 3");
const dashboardIcon = createIcon("M4 5h7v7H4z M13 5h7v4h-7z M13 11h7v8h-7z M4 14h7v5H4z");
const taskIcon = createIcon("M6 6h12M6 12h12M6 18h12M6 6v12");
const imageFlowIcon = createIcon("M4 5h16v11H4z M8 20h8 M12 16v4 M7 12l3-3 3 3 2-2 3 3");
const scoringIcon = createIcon("M4 19V5M4 19h16M8 15l3-3 3 2 5-6");
const feedbackIcon = createIcon("M5 5h14v10H8l-3 3z M8 9h8");
const logIcon = createIcon("M5 4h14v16H5z M8 8h8 M8 12h8 M8 16h5");
const userIcon = createIcon(
  "M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm-7 8c0-3.314 3.134-6 7-6s7 2.686 7 6",
);
const teamIcon = createIcon(
  "M8 11a3 3 0 1 0-3-3 3 3 0 0 0 3 3zm8 0a3 3 0 1 0-3-3 3 3 0 0 0 3 3zM3 20c0-3 2.5-5 5-5s5 2 5 5M11 20c0-2.5 2.2-4 5-4s5 1.5 5 4",
);

export const adminNavItems: AdminNavItem[] = [
  {
    label: "仪表盘",
    key: "/admin",
    keywords: "首页 仪表盘 工作台 dashboard overview",
    icon: dashboardIcon,
  },
  {
    label: "图包管理",
    key: "/admin/packages",
    keywords: "图包 图片 zip upload package",
    icon: archiveIcon,
  },
  {
    label: "项目管理",
    key: "/admin/projects",
    keywords: "项目 project team 标注团队",
    icon: dashboardIcon,
  },
  {
    label: "任务管理",
    key: "/admin/tasks",
    keywords: "任务 task scoring",
    icon: taskIcon,
  },
  {
    label: "缩略图任务流",
    key: "/admin/thumbnails",
    keywords: "缩略图 队列 图片 worker thumbnail queue priority pause",
    icon: imageFlowIcon,
  },
  {
    label: "打分管理",
    key: "/admin/scoring",
    keywords: "打分 质量 记录 回退 direct ranked scoring review rollback",
    icon: scoringIcon,
  },
  {
    label: "账号管理",
    key: "/admin/accounts",
    keywords: "账号 用户 打分人 account user",
    icon: userIcon,
  },
  {
    label: "团队管理",
    key: "/admin/teams",
    keywords: "团队 分组 team group 启用 禁用",
    icon: teamIcon,
  },
  {
    label: "问题反馈",
    key: "/admin/feedbacks",
    keywords: "问题 反馈 答复 bug feedback issue",
    icon: feedbackIcon,
  },
  {
    label: "线上日志",
    key: "/admin/logs",
    keywords: "线上 日志 错误 error log api PostgreSQL worker",
    icon: logIcon,
  },
];

export const scorerNavItems: AdminNavItem[] = [
  {
    label: "任务列表",
    key: "/",
    keywords: "任务 打分 标注 task scoring",
    icon: taskIcon,
  },
  {
    label: "问题反馈",
    key: "/feedbacks",
    keywords: "问题 反馈 bug feedback issue",
    icon: feedbackIcon,
  },
];

export function filterNavItems(items: AdminNavItem[], keyword: string) {
  const text = keyword.trim().toLowerCase();
  return items.filter(
    (item) =>
      !text ||
      `${item.label} ${item.key} ${item.keywords}`.toLowerCase().includes(text),
  );
}

export function filterAdminNavItems(keyword: string) {
  return filterNavItems(adminNavItems, keyword);
}

export function resolveAdminActiveKey(path: string) {
  if (path.startsWith("/admin/logs")) return "/admin/logs";
  if (path.startsWith("/admin/feedbacks")) return "/admin/feedbacks";
  if (path.startsWith("/admin/teams")) return "/admin/teams";
  if (path.startsWith("/admin/accounts")) return "/admin/accounts";
  if (path.startsWith("/admin/scoring")) return "/admin/scoring";
  if (path.startsWith("/admin/tasks")) return "/admin/tasks";
  if (path.startsWith("/admin/thumbnails")) return "/admin/thumbnails";
  if (path.startsWith("/admin/packages")) return "/admin/packages";
  if (path.startsWith("/admin/projects/") && path.endsWith("/tasks"))
    return "/admin/tasks";
  if (path.startsWith("/admin/projects")) return "/admin/projects";
  return "/admin";
}

export function resolveScorerActiveKey(path: string) {
  if (path.startsWith("/feedbacks")) return "/feedbacks";
  return "/";
}
