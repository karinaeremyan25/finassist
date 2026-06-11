// GET /api/analytics/transactions — постраничный список транзакций.
import { transactionsHandler } from '../../dist/server/routes/analytics.js';
import { toVercel } from '../_lib/adapter.js';

export default toVercel(transactionsHandler);
