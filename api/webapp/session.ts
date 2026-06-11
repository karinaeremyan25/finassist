// POST /api/webapp/session — верификация Telegram initData, профиль + фильтры.
import { sessionHandler } from '../../dist/server/routes/session.js';
import { toVercel } from '../_lib/adapter.js';

export default toVercel(sessionHandler);
