import { config } from './config.js';
import { createApp } from './app.js';
import { checkTokens, sweep } from './core/pipeline.js';
import { log, reportError } from './lib/log.js';
import { refreshTokens } from './oauth/routes.js';

createApp().listen(config.port, () => log('info', `azakana listening on :${config.port}`));

// Retries, crashed messages, stuck sends, token expiry.
setInterval(() => {
  sweep().catch((e) => reportError('sweep', e));
  checkTokens().catch((e) => reportError('token check', e));
}, config.core.retryEverySec * 1000);

// Instagram tokens last 60 days: refresh the ones close to expiry, every 6 hours.
const refresh = () => refreshTokens().then((r) => r.refreshed + r.failed && log('info', 'token refresh', r)).catch((e) => reportError('token refresh', e));
setTimeout(refresh, 60_000);
setInterval(refresh, 6 * 3600_000);
