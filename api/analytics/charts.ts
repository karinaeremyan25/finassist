// GET /api/analytics/charts — сгруппированные доход/расход по периодам.
import { chartsHandler } from '../../dist/server/routes/analytics.js';
import { toVercel } from '../_lib/adapter.js';

export default toVercel(chartsHandler);
