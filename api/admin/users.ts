// GET|POST|PATCH|DELETE /api/admin/users — управление пользователями (owner-only).
import { adminUsersHandler } from '../../dist/server/routes/admin.js';
import { toVercel } from '../_lib/adapter.js';

export default toVercel(adminUsersHandler);
