-- Replybek CRM, the Booking module: the team, services, time off, bookings and repeat bookings.
-- Runs after 00-core.sql and, like it, can run again and again.
-- Days and times are the business's wall clock: TIMESTAMP and DATE, never WITH TIME ZONE
-- (created_at is the one real instant, turned into the wall clock when it is read).

-- Lets one constraint compare a specialist (=) and a time range (&&) together: see crm_appointments.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ───── Services ─────
CREATE TABLE IF NOT EXISTS crm_services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name JSONB NOT NULL,                  -- "Haircut" or {"en": …, "ru": …, "uz": …}
  category TEXT NOT NULL DEFAULT '',    -- an id from the workspace's serviceCategories, or empty
  duration INT NOT NULL CHECK (duration > 0 AND duration <= 1440), -- minutes
  price BIGINT NOT NULL DEFAULT 0 CHECK (price >= 0),              -- whole soʻm
  buffer INT CHECK (buffer >= 0),       -- minutes kept free after it; NULL = the workspace's rule
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS crm_services_workspace ON crm_services (workspace_id, created_at);

-- ───── The team ─────
CREATE TABLE IF NOT EXISTS crm_staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL,
  name TEXT NOT NULL,
  role JSONB NOT NULL DEFAULT '""'::jsonb,   -- a job title: free text, or {"en": …, "ru": …, "uz": …}
  tone TEXT NOT NULL DEFAULT 't1',           -- the calendar colour, t1..t6
  hours JSONB NOT NULL,                      -- {"0": null, "1": ["10:00", "20:00"], …}, 0 = Sunday
  breaks JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{"from": "13:00", "to": "14:00"}], every working day
  service_ids UUID[] NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT true,
  -- The team member (a login) this specialist is, if any. With own_only they see and change only
  -- their own bookings.
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  own_only BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, branch_id) REFERENCES crm_branches (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS crm_staff_workspace ON crm_staff (workspace_id, created_at);
-- One login is at most one specialist of a workspace.
CREATE UNIQUE INDEX IF NOT EXISTS crm_staff_user ON crm_staff (workspace_id, user_id) WHERE user_id IS NOT NULL;

-- ───── Time off and closed days ─────
CREATE TABLE IF NOT EXISTS crm_time_off (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL,
  staff_id UUID,                        -- NULL = the whole business
  start_at TIMESTAMP NOT NULL,
  end_at TIMESTAMP NOT NULL,            -- the last minute it covers: all day = 00:00 … 23:59
  note JSONB NOT NULL DEFAULT '""'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_at >= start_at),
  FOREIGN KEY (workspace_id, branch_id) REFERENCES crm_branches (workspace_id, id),
  FOREIGN KEY (workspace_id, staff_id) REFERENCES crm_staff (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS crm_time_off_workspace ON crm_time_off (workspace_id, start_at);

-- ───── Repeat bookings ─────
-- A visit that comes back every N weeks on some weekdays. The bookings themselves are ordinary
-- rows of crm_appointments, made up to rules.maxDays ahead; a daily job makes the next ones.
CREATE TABLE IF NOT EXISTS crm_series (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  staff_id UUID NOT NULL,
  service_ids UUID[] NOT NULL DEFAULT '{}',
  time_of_day TEXT NOT NULL,            -- "09:30"
  duration INT NOT NULL CHECK (duration > 0 AND duration <= 1440),
  price BIGINT NOT NULL DEFAULT 0 CHECK (price >= 0),
  source TEXT NOT NULL DEFAULT '',
  note JSONB NOT NULL DEFAULT '""'::jsonb,
  fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  every INT NOT NULL DEFAULT 1 CHECK (every BETWEEN 1 AND 52),   -- weeks
  weekdays INT[] NOT NULL,              -- 0 = Sunday … 6 = Saturday
  start_day DATE NOT NULL,              -- weeks and `count` are counted from here
  until DATE,                           -- the last day it may fall on, or
  count INT CHECK (count > 0),          -- how many days it has in all; both NULL = no end
  -- Days up to here have been dealt with (booked, or skipped with a reason): never made twice.
  through DATE NOT NULL,
  -- Days that could not be booked: [{"day": "2026-12-01", "hard": [reason], "soft": [reason]}], newest last.
  skipped JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, branch_id) REFERENCES crm_branches (workspace_id, id),
  FOREIGN KEY (workspace_id, customer_id) REFERENCES crm_customers (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, staff_id) REFERENCES crm_staff (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS crm_series_workspace ON crm_series (workspace_id, created_at);

-- ───── Bookings ─────
CREATE TABLE IF NOT EXISTS crm_appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  staff_id UUID NOT NULL,
  service_ids UUID[] NOT NULL DEFAULT '{}',
  start_at TIMESTAMP NOT NULL,
  duration INT NOT NULL CHECK (duration > 0 AND duration <= 1440),  -- minutes
  price BIGINT NOT NULL DEFAULT 0 CHECK (price >= 0),
  status TEXT NOT NULL,                 -- the id of a step in the workspace's apptStages
  -- Whether the booking keeps its time: true in every kind of step except noshow and cancelled.
  -- The server sets it from the step's kind with every change of `status`.
  busy BOOLEAN NOT NULL DEFAULT true,
  source TEXT NOT NULL DEFAULT '',      -- an id from the workspace's sources, or "ai"
  note JSONB NOT NULL DEFAULT '""'::jsonb,
  paid BOOLEAN NOT NULL DEFAULT false,
  fields JSONB NOT NULL DEFAULT '{}'::jsonb,   -- { [fieldId]: value }, see fields.appointment
  history JSONB NOT NULL DEFAULT '[]'::jsonb,  -- what was done to it: [{ at, by, type, … }]
  series_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, branch_id) REFERENCES crm_branches (workspace_id, id),
  FOREIGN KEY (workspace_id, customer_id) REFERENCES crm_customers (workspace_id, id),
  FOREIGN KEY (workspace_id, staff_id) REFERENCES crm_staff (workspace_id, id),
  FOREIGN KEY (workspace_id, series_id) REFERENCES crm_series (workspace_id, id) ON DELETE SET NULL (series_id),
  -- Never a double booking: two rows that keep their time can't overlap for one specialist, even
  -- when two requests arrive in the same instant. [start, end): back to back is fine.
  CONSTRAINT crm_appointments_no_overlap EXCLUDE USING gist (
    staff_id WITH =,
    tsrange(start_at, start_at + make_interval(mins => duration)) WITH &&
  ) WHERE (busy)
);
-- The day of its repeat booking this row stands for. It stays when the visit itself is moved.
ALTER TABLE crm_appointments ADD COLUMN IF NOT EXISTS series_day DATE;
-- A visit ends on the day it starts (midnight at the latest). An earlier check compared times of
-- day, which let a whole-day visit from 10:00 through; this one compares the moments.
ALTER TABLE crm_appointments DROP CONSTRAINT IF EXISTS crm_appointments_one_day;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_appointments_same_day') THEN
    ALTER TABLE crm_appointments ADD CONSTRAINT crm_appointments_same_day
      CHECK (start_at + make_interval(mins => duration) <= start_at::date + 1);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS crm_appointments_workspace ON crm_appointments (workspace_id, start_at);
CREATE INDEX IF NOT EXISTS crm_appointments_customer ON crm_appointments (workspace_id, customer_id);
CREATE INDEX IF NOT EXISTS crm_appointments_series ON crm_appointments (series_id) WHERE series_id IS NOT NULL;

-- ───── Live updates ─────
SELECT crm_watch('crm_staff', 'staff');
SELECT crm_watch('crm_services', 'services');
SELECT crm_watch('crm_time_off', 'timeOff');
SELECT crm_watch('crm_appointments', 'appointments');
SELECT crm_watch('crm_series', 'series');
