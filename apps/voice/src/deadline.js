import { remainingLifetime } from './lifetime.js';

// A separate process keeps the absolute trial budget even if the API event loop is wedged.
const remaining = remainingLifetime(process.env.VOICE_DEADLINE);
if (remaining === null) throw new Error('Missing trial deadline');
setTimeout(() => process.exit(0), remaining);
