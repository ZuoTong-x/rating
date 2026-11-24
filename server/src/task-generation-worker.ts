process.env.TASK_GENERATION_WORKER = "1";

import type { Assignment } from "./services/task-generation-execution.ts";

const { runWithDatabaseContext } = await import("./postgres.ts");
const { generateSubjectTasks } = await import("./app.ts");

let started = false;

type WorkerMessage = {
  type: "start";
  subjectId: string;
  assignment: Assignment;
};

function sendParentMessage(message: Record<string, unknown>): Promise<void> {
  if (!process.connected) return Promise.resolve();
  return new Promise<void>((resolve) => {
    process.send?.(message, (error) => {
      if (error) console.error("Task generation worker IPC send failed", error);
      resolve();
    });
  });
}

process.on("message", async (message: unknown) => {
  if (started || !message || typeof message !== "object" || (message as WorkerMessage).type !== "start") return;
  started = true;
  const { subjectId, assignment } = message as WorkerMessage;

  try {
    const result = await runWithDatabaseContext(() =>
      generateSubjectTasks(
        subjectId,
        assignment,
        ({ stage, progress }: { stage: string; progress: number }) => {
          if (process.connected) process.send?.({ type: "progress", stage, progress });
        },
      ),
    );
    await sendParentMessage({ type: "completed", result });
    setImmediate(() => process.exit(0));
  } catch (error) {
    console.error("Task generation worker failed", error);
    await sendParentMessage({
      type: "failed",
      message: error instanceof Error ? error.message : "任务生成失败",
      needsReconciliation: Boolean(error && typeof error === "object" && "needsReconciliation" in error && error.needsReconciliation),
    });
    setImmediate(() => process.exit(1));
  }
});
