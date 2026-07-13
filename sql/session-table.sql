-- Canonical session table for connect-pg-simple, for reference / manual
-- migrations. installSessions() passes createTableIfMissing:true, so apps
-- normally do not need to run this by hand. Substitute the app's schema.
create table if not exists APP_SCHEMA.session (
  sid varchar primary key,
  sess json not null,
  expire timestamp(6) not null
);
create index if not exists session_expire_idx on APP_SCHEMA.session (expire);
