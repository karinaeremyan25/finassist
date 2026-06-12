// GET /api/analytics/plan?month=YYYY-MM — план/факт по месяцу.
// POST /api/analytics/plan — установить план (owner-only).
import { planHandler } from '../../dist/server/routes/plan.js';
import { toVercel } from '../_lib/adapter.js';

export default toVercel(planHandler);
