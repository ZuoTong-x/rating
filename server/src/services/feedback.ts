import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { db as database } from "../postgres.ts";

type Statement = ReturnType<typeof database.prepare>;
type User = { username: string; role: string };
type FeedbackRow = {
  id: string;
  title: string;
  type: string;
  description: string;
  status: string;
  submitter: string;
  submittedAt: string;
  reply?: string | null;
  repliedBy?: string | null;
  repliedAt?: string | null;
  updatedAt: string;
  imagePaths?: string | null;
};
type MessageRow = { id: string; feedbackId: string; author: string; authorRole: string; content: string; createdAt: string };
type FeedbackBody = Record<string, unknown>;

export function createFeedbackService({
  db, placeholders, httpError, nowIso, feedbackImageExts,
  feedbackUploadDir, uploadDir, insertFeedbackStmt,
  selectFeedbackByIdStmt, selectFeedbackMessagesStmt,
  selectFeedbackMessageExistsStmt, insertFeedbackMessageStmt,
  updateFeedbackReplyStmt,
}: {
  db: typeof database;
  placeholders: (length: number) => string;
  httpError: (status: number, message: string) => Error;
  nowIso: () => string;
  feedbackImageExts: Set<string>;
  feedbackUploadDir: string;
  uploadDir: string;
  insertFeedbackStmt: Statement;
  selectFeedbackByIdStmt: Statement;
  selectFeedbackMessagesStmt: Statement;
  selectFeedbackMessageExistsStmt: Statement;
  insertFeedbackMessageStmt: Statement;
  updateFeedbackReplyStmt: Statement;
}) {
const feedbackTypes = new Set(["platform_bug", "scoring_rule", "other"]);
const feedbackStatuses = new Set(["pending", "processing", "resolved"]);

function parseFeedbackText(value: unknown, label: string, maxLength: number) {
  const text = String(value ?? "").trim();
  if (!text) throw httpError(400, `${label}不能为空`);
  if (text.length > maxLength)
    throw httpError(400, `${label}不能超过 ${maxLength} 个字符`);
  return text;
}

function parseFeedbackType(value: unknown) {
  const type = String(value ?? "").trim();
  if (!feedbackTypes.has(type)) throw httpError(400, "问题类型不正确");
  return type;
}

function parseFeedbackStatus(value: unknown) {
  const status = String(value ?? "").trim();
  if (!feedbackStatuses.has(status)) throw httpError(400, "处理状态不正确");
  return status;
}

function parseFeedbackImagePaths(value: unknown) {
  try {
    const paths: unknown = JSON.parse(String(value || "[]"));
    return Array.isArray(paths)
      ? paths.filter(
          (item) => typeof item === "string" && item.startsWith("feedback/"),
        )
      : [];
  } catch {
    return [];
  }
}

async function feedbackDto(row: FeedbackRow | undefined, messages: MessageRow[] | null = null) {
  if (!row) return null;
  const imagePaths = parseFeedbackImagePaths(row.imagePaths);
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    description: row.description,
    status: row.status,
    submitter: row.submitter,
    submittedAt: row.submittedAt,
    reply: row.reply ?? "",
    repliedBy: row.repliedBy ?? null,
    repliedAt: row.repliedAt ?? null,
    updatedAt: row.updatedAt,
    messages: (messages ?? (await selectFeedbackMessagesStmt.all(row.id) as MessageRow[])).map((message) => ({
      id: message.id,
      author: message.author,
      authorRole: message.authorRole,
      content: message.content,
      createdAt: message.createdAt,
    })),
    images: imagePaths.map((imagePath) => ({
      path: imagePath,
      url: `/files/${imagePath}`,
    })),
  };
}

async function feedbackMessagesByIds(ids: string[]) {
  if (!ids.length) return new Map<string, MessageRow[]>();
  const rows = await db
    .prepare(`
      SELECT id, feedbackId, author, authorRole, content, createdAt
      FROM feedback_messages
      WHERE feedbackId IN (${placeholders(ids.length)})
      ORDER BY feedbackId ASC, createdAt ASC, id ASC
    `)
    .all(...ids) as MessageRow[];
  const messagesByFeedbackId = new Map<string, MessageRow[]>();
  rows.forEach((message) => {
    const messages = messagesByFeedbackId.get(message.feedbackId) || [];
    messages.push(message);
    messagesByFeedbackId.set(message.feedbackId, messages);
  });
  return messagesByFeedbackId;
}

async function listFeedbacks(query: FeedbackBody = {}) {
  const page = Math.max(Number(query.page) || 1, 1);
  const pageSize = Math.min(Math.max(Number(query.pageSize) || 10, 1), 100);
  const clauses: string[] = [];
  const params: unknown[] = [];
  const status = query.status ? parseFeedbackStatus(query.status) : null;

  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }

  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const total = (await db
    .prepare(`SELECT COUNT(*) AS total FROM feedbacks${where}`)
    .get(...params)).total;
  const rows = await db
    .prepare(
      `SELECT * FROM feedbacks${where} ORDER BY submittedAt DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize) as FeedbackRow[];
  const messagesByFeedbackId = await feedbackMessagesByIds(rows.map((row) => row.id));
  const items = await Promise.all(rows.map(
    async row => await feedbackDto(row, messagesByFeedbackId.get(row.id) || [])
  ));
  return { total, page, pageSize, items };
}

async function createFeedback(user: User, body: FeedbackBody = {}, files: Express.Multer.File[] = []) {
  const title = parseFeedbackText(body.title, "问题标题", 200);
  const type = parseFeedbackType(body.type);
  const description = parseFeedbackText(body.description, "问题描述", 5000);
  const id = crypto.randomUUID();
  const submittedAt = nowIso();
  const storedPaths: string[] = [];

  try {
    for (const file of files) {
      const extension = path.extname(file.originalname || "").toLowerCase();
      if (!feedbackImageExts.has(extension))
        throw httpError(400, "反馈图片仅支持 JPG、PNG、WebP 格式");
      try {
        await sharp(file.buffer).metadata();
      } catch {
        throw httpError(400, "反馈图片文件无法识别");
      }
      const filename = `${crypto.randomUUID()}${extension}`;
      const relativePath = `feedback/${filename}`;
      await fs.writeFile(path.join(feedbackUploadDir, filename), file.buffer);
      storedPaths.push(relativePath);
    }

    await insertFeedbackStmt.run({
      id,
      title,
      type,
      description,
      imagePaths: JSON.stringify(storedPaths),
      submitter: user.username,
      submittedAt,
      updatedAt: submittedAt,
    });
    return await feedbackDto(await selectFeedbackByIdStmt.get(id) as FeedbackRow | undefined);
  } catch (error) {
    await Promise.all(
      storedPaths.map((relativePath) =>
        fs.unlink(path.join(uploadDir, relativePath)).catch(() => {}),
      ),
    );
    throw error;
  }
}

function assertFeedbackAccess(feedback: FeedbackRow | undefined, user: User): asserts feedback is FeedbackRow {
  if (!feedback) throw httpError(404, "问题反馈不存在");
  if (user?.role !== "admin" && feedback.submitter !== user?.username) {
    throw httpError(403, "无权访问该反馈");
  }
}

async function addFeedbackMessage(id: string, body: FeedbackBody, user: User) {
  const feedback = await selectFeedbackByIdStmt.get(id) as FeedbackRow | undefined;
  if (!feedback) throw httpError(404, "问题反馈不存在");
  if (feedback.status === "resolved") {
    throw httpError(409, "该反馈已解决，不能继续回复");
  }
  const content = parseFeedbackText(
    body?.content ?? body?.reply,
    "回复内容",
    5000,
  );
  const requestedStatus = body?.status
    ? parseFeedbackStatus(body.status)
    : null;
  if (requestedStatus === "pending") {
    throw httpError(400, "反馈回复后不能恢复为未处理");
  }
  const status =
    requestedStatus ||
    (feedback.status === "pending" ? "processing" : feedback.status);
  const repliedAt = nowIso();
  await db.exec("BEGIN");
  try {
    await insertFeedbackMessageStmt.run({
      id: crypto.randomUUID(),
      feedbackId: feedback.id,
      author: user.username,
      authorRole: user.role,
      content,
      createdAt: repliedAt,
    });
    await updateFeedbackReplyStmt.run({
      id,
      status,
      reply: content,
      repliedBy: user.username,
      repliedAt,
      updatedAt: repliedAt,
    });
    await db.exec("COMMIT");
  } catch (error) {
    try {
      await db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
  return await feedbackDto(await selectFeedbackByIdStmt.get(id) as FeedbackRow | undefined);
}

async function updateFeedbackStatus(id: string, statusValue: unknown, user: User) {
  const feedback = await selectFeedbackByIdStmt.get(id) as FeedbackRow | undefined;
  assertFeedbackAccess(feedback, user);
  const status = parseFeedbackStatus(statusValue);
  if (status === "pending") throw httpError(400, "反馈状态不能恢复为未处理");
  if (
    status === "resolved" &&
    feedback.status !== "resolved" &&
    !(await selectFeedbackMessageExistsStmt.get(feedback.id))
  ) {
    throw httpError(400, "至少回复一次后才能标记为已解决");
  }
  const updatedAt = nowIso();
  await db.prepare("UPDATE feedbacks SET status = ?, updatedAt = ? WHERE id = ?").run(status, updatedAt, id);
  return await feedbackDto(await selectFeedbackByIdStmt.get(id) as FeedbackRow | undefined);
}

  return { listFeedbacks, createFeedback, addFeedbackMessage, updateFeedbackStatus };
}
