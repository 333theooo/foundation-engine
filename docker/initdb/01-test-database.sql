-- The test suites use their own databases so a test run can never destroy
-- development data. Created here so `docker compose up` is the only setup step.
CREATE DATABASE atrium_test OWNER atrium;
CREATE DATABASE atrium_e2e OWNER atrium;
