import app, { runStartupMaintenance } from "./app.js";

const port = Number(process.env.PORT || 3000);

const server = app.listen(port, () => {
  console.log(`API listening on ${port}`);
  void runStartupMaintenance();
});

server.on("error", (error) => {
  console.error(`API failed to listen on ${port}`, error);
  process.exitCode = 1;
});
