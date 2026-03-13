import { loadConfig } from "./config.js";
import { KroosbotApp } from "./app.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = new KroosbotApp(config);
  await app.start();
}

main().catch((error) => {
  console.error("kroosbot-ts failed to start", error);
  process.exitCode = 1;
});
