CREATE TABLE IF NOT EXISTS user_profiles (
  channel TEXT NOT NULL CHECK (channel IN ('telegram', 'qq')),
  user_id TEXT NOT NULL,
  user_call_name TEXT,
  assistant_call_name TEXT NOT NULL DEFAULT '拾序',
  timezone TEXT NOT NULL,
  locale TEXT NOT NULL,
  daily_plan_enabled INTEGER NOT NULL DEFAULT 1 CHECK (daily_plan_enabled IN (0, 1)),
  daily_plan_time TEXT NOT NULL,
  chronotype TEXT NOT NULL DEFAULT 'unknown' CHECK (chronotype IN ('unknown', 'early', 'balanced', 'late')),
  target_wake_time TEXT,
  target_sleep_time TEXT,
  routine_coaching INTEGER NOT NULL DEFAULT 0 CHECK (routine_coaching IN (0, 1)),
  communication_style TEXT NOT NULL DEFAULT '自然、简洁、坦诚，像长期合作的个人助理',
  preferences TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel, user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_daily_plan
  ON user_profiles(daily_plan_enabled, daily_plan_time);
