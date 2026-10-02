import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';
export const serviceIdentity=sqliteTable('service_identity',{
 id:integer('id').primaryKey(),
 ownerId:text('owner_id').notNull(),
 publicJwk:text('public_jwk').notNull(),
 privateJwk:text('private_jwk').notNull(),
 fingerprint:text('fingerprint').notNull(),
 createdAt:text('created_at').notNull(),
});
