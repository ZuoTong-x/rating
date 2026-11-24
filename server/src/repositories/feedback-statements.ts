import type { db as database } from "../postgres.ts";

export function createFeedbackStatements(db: typeof database) {
const insertFeedbackStmt = db.prepare(`
  INSERT INTO feedbacks (
    id, title, type, description, imagePaths, status,
    submitter, submittedAt, reply, repliedBy, repliedAt, updatedAt
  ) VALUES (
    @id, @title, @type, @description, @imagePaths, 'pending',
    @submitter, @submittedAt, NULL, NULL, NULL, @updatedAt
  )
`);
const selectFeedbackByIdStmt = db.prepare(
  "SELECT * FROM feedbacks WHERE id = ?",
);
const selectFeedbackMessagesStmt = db.prepare(`
  SELECT id, feedbackId, author, authorRole, content, createdAt
  FROM feedback_messages
  WHERE feedbackId = ?
  ORDER BY createdAt ASC, id ASC
`);
const selectFeedbackMessageExistsStmt = db.prepare(
  "SELECT 1 FROM feedback_messages WHERE feedbackId = ? LIMIT 1",
);
const insertFeedbackMessageStmt = db.prepare(`
  INSERT INTO feedback_messages (id, feedbackId, author, authorRole, content, createdAt)
  VALUES (@id, @feedbackId, @author, @authorRole, @content, @createdAt)
`);
const updateFeedbackReplyStmt = db.prepare(`
  UPDATE feedbacks
  SET status = @status,
      reply = @reply,
      repliedBy = @repliedBy,
      repliedAt = @repliedAt,
      updatedAt = @updatedAt
  WHERE id = @id
`);
  return { insertFeedbackStmt, selectFeedbackByIdStmt, selectFeedbackMessagesStmt, selectFeedbackMessageExistsStmt, insertFeedbackMessageStmt, updateFeedbackReplyStmt };
}
