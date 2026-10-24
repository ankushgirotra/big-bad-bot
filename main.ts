import { configFromEnv, startServer } from "./server/app.ts";

await startServer(configFromEnv());
