



SET client_encoding = 'UTF8';


CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";





GRANT ALL PRIVILEGES ON DATABASE fengyu TO fengyu;
GRANT ALL PRIVILEGES ON SCHEMA public TO fengyu;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO fengyu;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO fengyu;


ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO fengyu;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO fengyu;


DO $$
BEGIN
    RAISE NOTICE '========================================';
    RAISE NOTICE 'Fengyu Database Initialized Successfully';
    RAISE NOTICE 'Database: fengyu';
    RAISE NOTICE 'User: fengyu';
    RAISE NOTICE 'Extensions: uuid-ossp, pgcrypto';
    RAISE NOTICE '========================================';
END $$;
