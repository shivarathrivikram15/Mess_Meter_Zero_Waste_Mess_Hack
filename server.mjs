import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const app = createApp({
  dbFile: env.MESSMETER_DB || path.join(ROOT, 'data', 'messmeter.sqlite'),
  demo: env.MESSMETER_DEMO !== '0',
  tz: env.MESSMETER_TZ || 'Asia/Kolkata',
  studentPassword: env.MESSMETER_STUDENT_PASSWORD || undefined,
  supervisorPassword: env.MESSMETER_SUPERVISOR_PASSWORD || undefined,
  secret: env.MESSMETER_SECRET || undefined,
});
const port = Number(env.PORT) || 3000;
app.server.listen(port, '0.0.0.0', () => console.log(`MessMeter running at http://localhost:${port}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.close().then(() => process.exit(0)));
