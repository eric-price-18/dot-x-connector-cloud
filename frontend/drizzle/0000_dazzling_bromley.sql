CREATE TABLE `service_identity` (
	`id` integer PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`public_jwk` text NOT NULL,
	`private_jwk` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` text NOT NULL
);
