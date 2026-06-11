// GET /api/analytics/funds — список фондов + последние движения (экран «Фонды» Mini App).
import { fundsHandler } from '../../dist/server/routes/funds.js';
import { toVercel } from '../_lib/adapter.js';

export default toVercel(fundsHandler);
