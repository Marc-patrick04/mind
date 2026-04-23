-- =============================================
-- DATABASE: MindApp Mental Health Assessment System
-- =============================================

-- Drop existing tables if they exist (in correct order to avoid foreign key conflicts)
DROP TABLE IF EXISTS answers CASCADE;
DROP TABLE IF EXISTS support_requests CASCADE;
DROP TABLE IF EXISTS assessment_sessions CASCADE;
DROP TABLE IF EXISTS rating_rules CASCADE;
DROP TABLE IF EXISTS risk_thresholds CASCADE;
DROP TABLE IF EXISTS questions CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS admins CASCADE;

-- =============================================
-- 1. USERS TABLE (for registered users)
-- =============================================
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for faster email lookups
CREATE INDEX idx_users_email ON users(email);

-- =============================================
-- 2. ADMINS TABLE
-- =============================================
CREATE TABLE admins (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default admin (password: admin123)
-- You can change this after first login
INSERT INTO admins (email, password_hash) 
VALUES ('admin@gmail.com', '$2b$10$pvwyIQEvICL/6yU5mZVQ.eyrYxWpVFAPeHlVL2sjuoz7zMXWngJC2');

-- =============================================
-- 3. QUESTIONS TABLE
-- =============================================
CREATE TABLE questions (
    id SERIAL PRIMARY KEY,
    question_text TEXT NOT NULL,
    question_type VARCHAR(20) NOT NULL CHECK (question_type IN ('yesno', 'scale', 'checklist', 'choice')),
    options JSONB,  -- Stores options with points for checklist/choice, or points for yes/no
    scale_min INTEGER,  -- For scale questions
    scale_max INTEGER,  -- For scale questions
    display_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for ordering questions
CREATE INDEX idx_questions_display_order ON questions(display_order);
CREATE INDEX idx_questions_is_active ON questions(is_active);

-- =============================================
-- 4. ASSESSMENT SESSIONS TABLE
-- =============================================
CREATE TABLE assessment_sessions (
    id SERIAL PRIMARY KEY,
    session_token UUID DEFAULT gen_random_uuid() UNIQUE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    total_score INTEGER DEFAULT 0,
    risk_level VARCHAR(20) CHECK (risk_level IN ('low', 'moderate', 'high')),
    recommendation TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP
);

-- Indexes for session lookups
CREATE INDEX idx_sessions_token ON assessment_sessions(session_token);
CREATE INDEX idx_sessions_user_id ON assessment_sessions(user_id);
CREATE INDEX idx_sessions_created_at ON assessment_sessions(created_at);

-- =============================================
-- 5. ANSWERS TABLE
-- =============================================
CREATE TABLE answers (
    id SERIAL PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES assessment_sessions(id) ON DELETE CASCADE,
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    answer_value TEXT NOT NULL,
    points_earned INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for answer queries
CREATE INDEX idx_answers_session_id ON answers(session_id);
CREATE INDEX idx_answers_question_id ON answers(question_id);
CREATE UNIQUE INDEX idx_answers_session_question ON answers(session_id, question_id);

-- =============================================
-- 6. RISK THRESHOLDS TABLE
-- =============================================
CREATE TABLE risk_thresholds (
    id SERIAL PRIMARY KEY,
    min_score INTEGER NOT NULL,
    max_score INTEGER NOT NULL,
    risk_level VARCHAR(20) NOT NULL CHECK (risk_level IN ('low', 'moderate', 'high')),
    color_code VARCHAR(7) DEFAULT '#2ECC71',
    default_recommendation TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Ensure thresholds don't overlap
    CONSTRAINT valid_range CHECK (min_score <= max_score)
);

-- Insert default risk thresholds
INSERT INTO risk_thresholds (min_score, max_score, risk_level, color_code, default_recommendation) VALUES
(0, 29, 'low', '#2ECC71', 'Maintain healthy habits. Continue monitoring your behavior and practice responsible decision-making.'),
(30, 59, 'moderate', '#F39C12', 'You may be developing risky behavior patterns. Consider reducing gambling activities and joining our support groups for early intervention.'),
(60, 100, 'high', '#E74C3C', 'You are at high risk. We strongly recommend immediate professional support. A counselor will contact you soon.');

-- =============================================
-- 7. SUPPORT REQUESTS TABLE
-- =============================================
CREATE TABLE support_requests (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id INTEGER NOT NULL REFERENCES assessment_sessions(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'contacted', 'resolved')),
    admin_notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for support requests
CREATE INDEX idx_support_requests_user_id ON support_requests(user_id);
CREATE INDEX idx_support_requests_status ON support_requests(status);
CREATE INDEX idx_support_requests_created_at ON support_requests(created_at);

-- =============================================
-- 8. RATING RULES TABLE (for flexible scoring)
-- =============================================
CREATE TABLE rating_rules (
    id SERIAL PRIMARY KEY,
    rule_name VARCHAR(100) NOT NULL,
    question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
    answer_value TEXT NOT NULL,
    points INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for rating rules
CREATE INDEX idx_rating_rules_question_id ON rating_rules(question_id);

-- =============================================
-- SAMPLE QUESTIONS DATA
-- =============================================

-- Yes/No Questions with different point values
INSERT INTO questions (question_text, question_type, options, display_order, is_active) VALUES
('Do you find yourself thinking about gambling often?', 'yesno', '{"yes": 3, "no": 0}', 1, true),
('Have you tried to cut back on gambling but couldn''t?', 'yesno', '{"yes": 4, "no": 0}', 2, true),
('Do you gamble to escape problems or relieve stress?', 'yesno', '{"yes": 3, "no": 0}', 3, true),
('Have you lied to family or friends about your gambling?', 'yesno', '{"yes": 5, "no": 0}', 4, true),
('Do you chase losses by gambling more money?', 'yesno', '{"yes": 5, "no": 0}', 5, true);

-- Scale Questions (1-5)
INSERT INTO questions (question_text, question_type, scale_min, scale_max, display_order, is_active) VALUES
('How often do you gamble in a typical week?', 'scale', 1, 5, 10, true),
('How difficult would it be to stop gambling for a month?', 'scale', 1, 5, 11, true),
('How much does gambling affect your daily life?', 'scale', 1, 5, 12, true),
('How stressed do you feel about your gambling habits?', 'scale', 1, 5, 13, true);

-- Checklist Question (Select all that apply)
INSERT INTO questions (question_text, question_type, options, display_order, is_active) VALUES
('Which of the following have you experienced? (Select all that apply)', 'checklist', 
 '[{"text": "Borrowed money to gamble", "points": 3}, {"text": "Sold personal items to gamble", "points": 4}, {"text": "Neglected work/studies due to gambling", "points": 3}, {"text": "Had arguments about gambling", "points": 2}, {"text": "Felt guilty after gambling", "points": 2}]', 
 20, true);

-- Multiple Choice Question (Select one)
INSERT INTO questions (question_text, question_type, options, display_order, is_active) VALUES
('How much money do you typically spend on gambling per month?', 'choice', 
 '[{"text": "$0 - $50", "points": 0}, {"text": "$51 - $200", "points": 2}, {"text": "$201 - $500", "points": 4}, {"text": "More than $500", "points": 5}]', 
 21, true);

INSERT INTO questions (question_text, question_type, options, display_order, is_active) VALUES
('How would you describe your gambling behavior?', 'choice', 
 '[{"text": "I don''t gamble", "points": 0}, {"text": "I gamble occasionally for fun", "points": 1}, {"text": "I gamble regularly but in control", "points": 2}, {"text": "I feel I''m losing control", "points": 4}, {"text": "I need help to stop gambling", "points": 5}]', 
 22, true);

-- =============================================
-- FUNCTIONS AND TRIGGERS
-- =============================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply updated_at triggers
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_questions_updated_at BEFORE UPDATE ON questions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_risk_thresholds_updated_at BEFORE UPDATE ON risk_thresholds FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_support_requests_updated_at BEFORE UPDATE ON support_requests FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_rating_rules_updated_at BEFORE UPDATE ON rating_rules FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =============================================
-- VIEW FOR EASY REPORTING
-- =============================================

-- View for assessment summary with user info
CREATE VIEW assessment_summary AS
SELECT 
    s.id as session_id,
    s.session_token,
    s.total_score,
    s.risk_level,
    s.recommendation,
    s.created_at as assessment_date,
    u.id as user_id,
    u.email as user_email,
    CASE WHEN u.id IS NOT NULL THEN 'Registered' ELSE 'Anonymous' END as user_type,
    COUNT(a.id) as questions_answered
FROM assessment_sessions s
LEFT JOIN users u ON s.user_id = u.id
LEFT JOIN answers a ON s.id = a.session_id
GROUP BY s.id, u.id, u.email;

-- View for support dashboard
CREATE VIEW support_dashboard AS
SELECT 
    sr.id as request_id,
    sr.status,
    sr.created_at as request_date,
    u.email as user_email,
    s.risk_level,
    s.total_score,
    s.recommendation,
    s.created_at as assessment_date
FROM support_requests sr
JOIN users u ON sr.user_id = u.id
JOIN assessment_sessions s ON sr.session_id = s.id
ORDER BY 
    CASE sr.status 
        WHEN 'pending' THEN 1 
        WHEN 'contacted' THEN 2 
        ELSE 3 
    END,
    sr.created_at DESC;

-- =============================================
-- HELPER QUERIES
-- =============================================

-- Get statistics function
CREATE OR REPLACE FUNCTION get_assessment_stats()
RETURNS TABLE(
    total_assessments BIGINT,
    total_support_requests BIGINT,
    pending_requests BIGINT,
    low_risk_count BIGINT,
    moderate_risk_count BIGINT,
    high_risk_count BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        (SELECT COUNT(*) FROM assessment_sessions)::BIGINT,
        (SELECT COUNT(*) FROM support_requests)::BIGINT,
        (SELECT COUNT(*) FROM support_requests WHERE status = 'pending')::BIGINT,
        (SELECT COUNT(*) FROM assessment_sessions WHERE risk_level = 'low')::BIGINT,
        (SELECT COUNT(*) FROM assessment_sessions WHERE risk_level = 'moderate')::BIGINT,
        (SELECT COUNT(*) FROM assessment_sessions WHERE risk_level = 'high')::BIGINT;
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- NOTES FOR SETUP
-- =============================================

/*
To set up this database:

1. Create a PostgreSQL database:
   CREATE DATABASE mindapp;

2. Run this entire script in your database

3. Update your .env file with database credentials:
   DB_USER=your_username
   DB_PASSWORD=your_password
   DB_HOST=localhost
   DB_PORT=5432
   DB_NAME=mindapp

4. For the admin password, generate a bcrypt hash:
   - Use bcrypt.hash('admin123', 10) in Node.js
   - Replace the placeholder hash in the admin insert statement

5. Sample admin login:
   Email: admin@mindapp.com
   Password: admin123 (after setting proper hash)
*/