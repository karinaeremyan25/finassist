// GET /api/webapp/users — список активных пользователей с last_seen.
import { usersHandler } from '../../dist/server/routes/users.js';
import { toVercel } from '../_lib/adapter.js';

export default toVercel(usersHandler);
