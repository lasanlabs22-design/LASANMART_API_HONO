CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  email TEXT,
  company_name TEXT,
  company_description TEXT,
  sector TEXT,
  city TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  type TEXT NOT NULL CHECK (type IN ('service', 'custom', 'plan', 'influencer')),
  title TEXT,
  description TEXT,
  details JSONB,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'in_progress', 'closed')),
  email_sent BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_requests_contact_id ON requests(contact_id);
CREATE INDEX IF NOT EXISTS idx_requests_type ON requests(type);

-- Assignment: who on the team is handling this request
ALTER TABLE requests ADD COLUMN IF NOT EXISTS assigned_to TEXT;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;

-- Internal notes the team adds while working a request
ALTER TABLE requests ADD COLUMN IF NOT EXISTS internal_note TEXT;

-- Track when the team last touched it
ALTER TABLE requests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Useful indexes for the dashboard's most common queries
CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_assigned_to ON requests(assigned_to);