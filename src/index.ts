import { config } from './config.js';
import { createApp } from './app.js';
import { checkTokens, sweep } from './core/pipeline.js';
import { log, reportError } from './lib/log.js';

createApp().listen(config.port, () => log('info', `azakana listening on :${config.port}`));

// Retries, crashed messages, stuck sends, token expiry.
setInterval(() => {
  sweep().catch((e) => reportError('sweep', e));
  checkTokens().catch((e) => reportError('token check', e));
}, config.core.retryEverySec * 1000);
