import { openNodeDatabase } from '../node';

/**
 * Jest alias for the Node adapter (see ../node.ts). Kept so specs read as
 * "open a test database" at the call site.
 */
export const openTestDatabase = openNodeDatabase;
