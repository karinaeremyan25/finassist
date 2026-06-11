// GET /api/analytics/summary — итоги + fundStatus (tax/reserve/gratitude/credit/profit).
import { summaryHandler } from '../../dist/server/routes/analytics.js';
import { toVercel } from '../_lib/adapter.js';

export default toVercel(summaryHandler);
