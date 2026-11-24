import app, { runStartupMaintenance } from "./app.ts";
import { startThumbnailStatsBackfill } from "./thumbnail-stats-backfill.ts";

const port = Number(process.env.PORT || 3000);

const server = app.listen(port, () => {
  console.log(`API listening on ${port}`);
  void runStartupMaintenance();
  startThumbnailStatsBackfill();
});

server.on("error", (error: Error) => {
  console.error(`API failed to listen on ${port}`, error);
  process.exitCode = 1;
});
