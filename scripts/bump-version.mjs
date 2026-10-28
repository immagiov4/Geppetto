import { bump } from './version.mjs';
try { bump(process.argv[2]); } catch (error) { console.error(error.message); process.exitCode = 1; }
