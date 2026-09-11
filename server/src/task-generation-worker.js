import { runWithDatabaseContext } from "./postgres.js";

process.env.TASK_GENERATION_WORKER = "1";

const { generateSubjectTasks } = await import("./app.js");

let started = false;

function sendParentMessage(message) {
  if (!process.connected) return Promise.resolve();
  return new Promise((resolve) => {
    process.send(message, (error) => {
      if (error) console.error("Task generation worker IPC send failed", error);
      resolve();
    });
  });
}

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
    await sendParentMessage({ type: "completed", result });
    setImmediate(() => process.exit(0));
  } catch (error) {
    console.error("Task generation worker failed", error);
    await sendParentMessage({
      type: "failed",
      message: error?.message || "任务生成失败",
    });
    setImmediate(() => process.exit(1));
  }
});
