// GET /api/analytics/insights — текстовые инсайты по фондам/нагрузке.
import { insightsHandler } from '../../dist/server/routes/analytics.js';
import { toVercel } from '../_lib/adapter.js';

export default toVercel(insightsHandler);
