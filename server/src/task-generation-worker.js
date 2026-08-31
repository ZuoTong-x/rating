import { generateSubjectTasks } from "./app.js";
import { runWithDatabaseContext } from "./postgres.js";

let started = false;

process.on("message", async (message) => {
  if (started || message?.type !== "start") return;
  started = true;

  try {
    const result = await runWithDatabaseContext(() =>
      generateSubjectTasks(
        message.subjectId,
        message.assignment,
        ({ stage, progress }) => {
          if (process.connected) process.send({ type: "progress", stage, progress });
        },
      ),
    );
    if (process.connected) process.send({ type: "completed", result });
    setImmediate(() => process.exit(0));
  } catch (error) {
    if (process.connected) {
      process.send({
        type: "failed",
        message: error?.message || "任务生成失败",
      });
    }
    setImmediate(() => process.exit(1));
  }
});
