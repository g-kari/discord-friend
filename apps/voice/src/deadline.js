import { remainingLifetime } from './lifetime.js';

// A separate process keeps the absolute trial budget even if the API event loop is wedged.
const remaining = remainingLifetime(process.env.VOICE_DEADLINE);
// PID1 validates before it starts the engine, then runs this independent watchdog.
if (process.argv[2] !== '--check') setTimeout(() => process.exit(0), remaining);
