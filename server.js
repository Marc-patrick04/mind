// server.js - Main Express server
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Database connection
const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'mindapp',
});

// Test database connection
pool.connect((err, client, release) => {
    if (err) {
        console.error('Error connecting to database:', err.stack);
    } else {
        console.log('Connected to PostgreSQL database');
        release();
    }
});

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'mindapp_secret_key_2024';
const JWT_EXPIRES_IN = '7d';

// =============================================
// MIDDLEWARE FUNCTIONS
// =============================================

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid or expired token' });
        }
        req.user = user;
        next();
    });
}

function authenticateAdmin(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Admin access required' });
    }

    jwt.verify(token, JWT_SECRET, (err, admin) => {
        if (err || admin.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        req.admin = admin;
        next();
    });
}

// =============================================
// PUBLIC ROUTES
// =============================================

// Get all questions (public - only active)
app.get('/api/questions', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, question_text, question_type, options, scale_min, scale_max, display_order 
             FROM questions 
             WHERE is_active = true 
             ORDER BY display_order`
        );

        // Parse JSON options for each question
        const questions = result.rows.map(q => {
            if (q.options && typeof q.options === 'string') {
                try {
                    q.options = JSON.parse(q.options);
                } catch (e) { }
            }
            return q;
        });

        res.json(questions);
    } catch (error) {
        console.error('Error fetching questions:', error);
        res.status(500).json({ error: 'Database error fetching questions' });
    }
});

// Submit assessment
app.post('/api/assessment/submit', async (req, res) => {
    const client = await pool.connect();

    try {
        const { answers } = req.body;

        if (!answers || !Array.isArray(answers)) {
            return res.status(400).json({ error: 'Invalid answers format' });
        }

        await client.query('BEGIN');

        // Calculate total score
        let totalScore = 0;
        const scoringPromises = answers.map(async (answer) => {
            const questionResult = await client.query(
                'SELECT question_type, options, scale_min, scale_max FROM questions WHERE id = $1',
                [answer.questionId]
            );

            if (questionResult.rows.length === 0) return 0;

            const question = questionResult.rows[0];
            let points = 0;

            // Parse options if needed
            let options = question.options;
            if (options && typeof options === 'string') {
                try {
                    options = JSON.parse(options);
                } catch (e) { }
            }

            if (question.question_type === 'yesno') {
                points = options && options[answer.answer] ? options[answer.answer] : (answer.answer === 'yes' ? 3 : 0);
            } else if (question.question_type === 'scale') {
                points = parseInt(answer.answer);
            } else if (question.question_type === 'choice') {
                const selected = options.find(opt => opt.text === answer.answer);
                points = selected ? selected.points : 0;
            } else if (question.question_type === 'checklist') {
                const selectedItems = JSON.parse(answer.answer);
                points = selectedItems.reduce((sum, item) => {
                    const option = options.find(opt => opt.text === item);
                    return sum + (option ? option.points : 0);
                }, 0);
            }

            return points;
        });

        const pointsArray = await Promise.all(scoringPromises);
        totalScore = pointsArray.reduce((sum, p) => sum + p, 0);

        // Get max possible score to calculate percentage
        const questionsResult = await client.query('SELECT COUNT(*) as count FROM questions WHERE is_active = true');
        const questionCount = parseInt(questionsResult.rows[0].count);
        const maxPossibleScore = questionCount * 5;
        const scorePercentage = maxPossibleScore > 0 ? (totalScore / maxPossibleScore) * 100 : 0;

        // Determine risk level based on score percentage
        let riskLevel = 'low';
        let colorCode = '#2ECC71';
        let recommendation = '';

        const thresholdsResult = await pool.query(
            'SELECT * FROM risk_thresholds ORDER BY min_score'
        );

        for (const threshold of thresholdsResult.rows) {
            if (scorePercentage >= threshold.min_score && scorePercentage <= threshold.max_score) {
                riskLevel = threshold.risk_level;
                colorCode = threshold.color_code;
                recommendation = threshold.default_recommendation;
                break;
            }
        }

        // Create assessment session
        const sessionResult = await client.query(
            `INSERT INTO assessment_sessions (total_score, risk_level, recommendation, completed_at) 
             VALUES ($1, $2, $3, NOW()) 
             RETURNING id, session_token`,
            [totalScore, riskLevel, recommendation]
        );

        const sessionId = sessionResult.rows[0].id;
        const sessionToken = sessionResult.rows[0].session_token;

        // Save answers
        for (let i = 0; i < answers.length; i++) {
            const answer = answers[i];
            await client.query(
                `INSERT INTO answers (session_id, question_id, answer_value, points_earned) 
                 VALUES ($1, $2, $3, $4)`,
                [sessionId, answer.questionId, answer.answer.toString(), pointsArray[i]]
            );
        }

        await client.query('COMMIT');

        res.json({
            success: true,
            sessionToken,
            totalScore,
            riskLevel,
            colorCode,
            recommendation,
            scorePercentage: Math.round(scorePercentage)
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error submitting assessment:', error);
        res.status(500).json({ error: 'Database error submitting assessment' });
    } finally {
        client.release();
    }
});

// =============================================
// USER AUTHENTICATION ROUTES
// =============================================

// Register user
app.post('/api/support/register', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }

    if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const emailRegex = /^[^\s@]+@([^\s@]+\.)+[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
    }

    try {
        const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);

        if (existingUser.rows.length > 0) {
            return res.status(409).json({ error: 'User already exists' });
        }

        const passwordHash = await bcrypt.hash(password, 10);

        const result = await pool.query(
            `INSERT INTO users (email, password_hash) 
             VALUES ($1, $2) 
             RETURNING id, email, created_at`,
            [email.toLowerCase(), passwordHash]
        );

        const token = jwt.sign(
            { userId: result.rows[0].id, email: result.rows[0].email },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRES_IN }
        );

        res.status(201).json({
            success: true,
            token,
            user: {
                id: result.rows[0].id,
                email: result.rows[0].email,
                createdAt: result.rows[0].created_at
            }
        });

    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// Login user
app.post('/api/support/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }

    try {
        const result = await pool.query(
            'SELECT id, email, password_hash, created_at FROM users WHERE email = $1',
            [email.toLowerCase()]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const user = result.rows[0];
        const validPassword = await bcrypt.compare(password, user.password_hash);

        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { userId: user.id, email: user.email },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRES_IN }
        );

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                email: user.email,
                createdAt: user.created_at
            }
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// Link assessment session to user
app.post('/api/support/link-session', authenticateToken, async (req, res) => {
    const { sessionToken } = req.body;
    const userId = req.user.userId;

    if (!sessionToken) {
        return res.status(400).json({ error: 'Session token required' });
    }

    try {
        const result = await pool.query(
            `UPDATE assessment_sessions 
             SET user_id = $1 
             WHERE session_token = $2 AND user_id IS NULL
             RETURNING id, risk_level, total_score`,
            [userId, sessionToken]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Session not found or already linked' });
        }

        const session = result.rows[0];

        let supportMessage = '';
        if (session.risk_level === 'moderate' || session.risk_level === 'high') {
            await pool.query(
                `INSERT INTO support_requests (user_id, session_id, status) 
                 VALUES ($1, $2, 'pending')`,
                [userId, session.id]
            );
            supportMessage = 'A support request has been created. A counselor will contact you soon.';
        } else {
            supportMessage = 'Your assessment has been saved. Continue practicing healthy habits!';
        }

        res.json({
            success: true,
            supportMessage,
            riskLevel: session.risk_level,
            totalScore: session.total_score
        });

    } catch (error) {
        console.error('Error linking session:', error);
        res.status(500).json({ error: 'Failed to link session' });
    }
});

// Get user dashboard data
app.get('/api/user/dashboard', authenticateToken, async (req, res) => {
    const userId = req.user.userId;

    try {
        const assessmentsResult = await pool.query(
            `SELECT id, session_token, total_score, risk_level, recommendation, created_at, completed_at
             FROM assessment_sessions 
             WHERE user_id = $1 
             ORDER BY created_at DESC`,
            [userId]
        );

        const supportResult = await pool.query(
            `SELECT sr.id, sr.status, sr.created_at, sr.admin_notes,
                    s.risk_level, s.total_score
             FROM support_requests sr
             JOIN assessment_sessions s ON sr.session_id = s.id
             WHERE sr.user_id = $1
             ORDER BY sr.created_at DESC`,
            [userId]
        );

        res.json({
            assessments: assessmentsResult.rows,
            supportRequests: supportResult.rows
        });

    } catch (error) {
        console.error('Error fetching dashboard:', error);
        res.status(500).json({ error: 'Failed to fetch dashboard data' });
    }
});

// =============================================
// ADMIN ROUTES
// =============================================

// Admin login
app.post('/api/admin/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const result = await pool.query(
            'SELECT id, email, password_hash FROM admins WHERE email = $1',
            [email.toLowerCase()]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const admin = result.rows[0];
        const validPassword = await bcrypt.compare(password, admin.password_hash);

        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { adminId: admin.id, email: admin.email, role: 'admin' },
            JWT_SECRET,
            { expiresIn: '1d' }
        );

        res.json({
            success: true,
            token,
            admin: {
                id: admin.id,
                email: admin.email
            }
        });

    } catch (error) {
        console.error('Admin login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// Get admin stats
app.get('/api/admin/stats', authenticateAdmin, async (req, res) => {
    try {
        const assessmentsResult = await pool.query('SELECT COUNT(*) FROM assessment_sessions');
        const totalSupportResult = await pool.query('SELECT COUNT(*) FROM support_requests');
        const pendingResult = await pool.query('SELECT COUNT(*) FROM support_requests WHERE status = $1', ['pending']);
        const usersResult = await pool.query('SELECT COUNT(*) FROM users');

        const riskResult = await pool.query(
            'SELECT risk_level, COUNT(*) as count FROM assessment_sessions WHERE risk_level IS NOT NULL GROUP BY risk_level'
        );

        const recentResult = await pool.query(
            `SELECT s.id, s.session_token, s.total_score, s.risk_level, s.created_at,
                    u.email as user_email
             FROM assessment_sessions s
             LEFT JOIN users u ON s.user_id = u.id
             ORDER BY s.created_at DESC
             LIMIT 20`
        );

        res.json({
            totalAssessments: parseInt(assessmentsResult.rows[0].count),
            totalSupportRequests: parseInt(totalSupportResult.rows[0].count),
            pendingRequests: parseInt(pendingResult.rows[0].count),
            totalUsers: parseInt(usersResult.rows[0].count),
            riskDistribution: riskResult.rows,
            recentAssessments: recentResult.rows
        });
    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({ error: 'Failed to fetch statistics' });
    }
});

// Get all questions (admin - includes inactive)
app.get('/api/admin/questions', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, question_text, question_type, options, scale_min, scale_max, display_order, is_active 
             FROM questions 
             ORDER BY display_order`
        );

        const questions = result.rows.map(q => {
            if (q.options && typeof q.options === 'string') {
                try {
                    q.options = JSON.parse(q.options);
                } catch (e) { }
            }
            return q;
        });

        res.json(questions);
    } catch (error) {
        console.error('Error fetching questions:', error);
        res.status(500).json({ error: 'Database error fetching questions' });
    }
});

// Get single question
app.get('/api/admin/questions/:id', authenticateAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            `SELECT id, question_text, question_type, options, scale_min, scale_max, display_order, is_active 
             FROM questions 
             WHERE id = $1`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Question not found' });
        }

        const question = result.rows[0];
        if (question.options && typeof question.options === 'string') {
            try {
                question.options = JSON.parse(question.options);
            } catch (e) { }
        }

        res.json(question);
    } catch (error) {
        console.error('Error fetching question:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// Create new question
app.post('/api/admin/questions', authenticateAdmin, async (req, res) => {
    const { question_text, question_type, options, scale_min, scale_max, display_order, is_active } = req.body;

    try {
        let optionsValue = null;
        if (options) {
            optionsValue = typeof options === 'string' ? options : JSON.stringify(options);
        }

        const result = await pool.query(
            `INSERT INTO questions (question_text, question_type, options, scale_min, scale_max, display_order, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [question_text, question_type, optionsValue, scale_min, scale_max, display_order || 0, is_active !== false]
        );

        const newQuestion = result.rows[0];
        if (newQuestion.options && typeof newQuestion.options === 'string') {
            try {
                newQuestion.options = JSON.parse(newQuestion.options);
            } catch (e) { }
        }

        res.status(201).json(newQuestion);
    } catch (error) {
        console.error('Error creating question:', error);
        res.status(500).json({ error: 'Failed to create question: ' + error.message });
    }
});

// Update question
app.put('/api/admin/questions/:id', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    const { question_text, question_type, options, scale_min, scale_max, display_order, is_active } = req.body;

    try {
        console.log('Updating question:', { id, question_type });

        let optionsValue = null;
        if (options) {
            optionsValue = typeof options === 'string' ? options : JSON.stringify(options);
            console.log('Options saved:', optionsValue);
        }

        const result = await pool.query(
            `UPDATE questions 
             SET question_text = $1, question_type = $2, options = $3, 
                 scale_min = $4, scale_max = $5, display_order = $6, is_active = $7,
                 updated_at = NOW()
             WHERE id = $8
             RETURNING *`,
            [question_text, question_type, optionsValue, scale_min, scale_max, display_order, is_active, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Question not found' });
        }

        const updatedQuestion = result.rows[0];
        if (updatedQuestion.options && typeof updatedQuestion.options === 'string') {
            try {
                updatedQuestion.options = JSON.parse(updatedQuestion.options);
            } catch (e) { }
        }

        console.log('Question updated successfully');
        res.json(updatedQuestion);
    } catch (error) {
        console.error('Error updating question:', error);
        res.status(500).json({ error: 'Failed to update question: ' + error.message });
    }
});

// Delete question
app.delete('/api/admin/questions/:id', authenticateAdmin, async (req, res) => {
    const { id } = req.params;

    try {
        const answersCheck = await pool.query('SELECT COUNT(*) FROM answers WHERE question_id = $1', [id]);
        if (parseInt(answersCheck.rows[0].count) > 0) {
            return res.status(400).json({ error: 'Cannot delete question that has existing answers' });
        }

        const result = await pool.query('DELETE FROM questions WHERE id = $1 RETURNING id', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Question not found' });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting question:', error);
        res.status(500).json({ error: 'Failed to delete question' });
    }
});

// Get all risk thresholds
app.get('/api/admin/thresholds', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, min_score, max_score, risk_level, color_code, default_recommendation FROM risk_thresholds ORDER BY min_score'
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching thresholds:', error);
        res.status(500).json({ error: 'Failed to fetch thresholds' });
    }
});

// Create new threshold
app.post('/api/admin/thresholds', authenticateAdmin, async (req, res) => {
    const { min_score, max_score, risk_level, color_code, default_recommendation } = req.body;

    try {
        const overlap = await pool.query(
            'SELECT id FROM risk_thresholds WHERE ($1 BETWEEN min_score AND max_score) OR ($2 BETWEEN min_score AND max_score)',
            [min_score, max_score]
        );
        if (overlap.rows.length > 0) {
            return res.status(400).json({ error: 'Threshold range overlaps with existing threshold' });
        }

        const result = await pool.query(
            `INSERT INTO risk_thresholds (min_score, max_score, risk_level, color_code, default_recommendation)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [min_score, max_score, risk_level, color_code, default_recommendation]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error creating threshold:', error);
        res.status(500).json({ error: 'Failed to create threshold' });
    }
});

// Update threshold
app.put('/api/admin/thresholds/:id', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    const { min_score, max_score, risk_level, color_code, default_recommendation } = req.body;

    try {
        const overlap = await pool.query(
            'SELECT id FROM risk_thresholds WHERE id != $1 AND (($2 BETWEEN min_score AND max_score) OR ($3 BETWEEN min_score AND max_score))',
            [id, min_score, max_score]
        );
        if (overlap.rows.length > 0) {
            return res.status(400).json({ error: 'Threshold range overlaps with existing threshold' });
        }

        const result = await pool.query(
            `UPDATE risk_thresholds 
             SET min_score = $1, max_score = $2, risk_level = $3, 
                 color_code = $4, default_recommendation = $5, updated_at = NOW()
             WHERE id = $6
             RETURNING *`,
            [min_score, max_score, risk_level, color_code, default_recommendation, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Threshold not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error updating threshold:', error);
        res.status(500).json({ error: 'Failed to update threshold' });
    }
});

// Delete threshold
app.delete('/api/admin/thresholds/:id', authenticateAdmin, async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query('DELETE FROM risk_thresholds WHERE id = $1 RETURNING id', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Threshold not found' });
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting threshold:', error);
        res.status(500).json({ error: 'Failed to delete threshold' });
    }
});

// Get all support requests for admin
app.get('/api/admin/support-requests', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT sr.id, sr.status, sr.created_at, sr.updated_at, sr.admin_notes,
                    u.email, u.created_at as user_since,
                    s.id as session_id, s.total_score, s.risk_level, s.recommendation
             FROM support_requests sr
             JOIN users u ON sr.user_id = u.id
             JOIN assessment_sessions s ON sr.session_id = s.id
             ORDER BY 
                 CASE sr.status 
                     WHEN 'pending' THEN 1 
                     WHEN 'contacted' THEN 2 
                     ELSE 3 
                 END,
                 sr.created_at DESC`
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching support requests:', error);
        res.status(500).json({ error: 'Failed to fetch support requests' });
    }
});

// Update support request status
app.put('/api/admin/support-requests/:id/status', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    const { status, admin_notes } = req.body;

    if (!['pending', 'contacted', 'resolved'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }

    try {
        const result = await pool.query(
            `UPDATE support_requests 
             SET status = $1, admin_notes = COALESCE($2, admin_notes), updated_at = NOW()
             WHERE id = $3
             RETURNING *`,
            [status, admin_notes, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Support request not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error updating support request:', error);
        res.status(500).json({ error: 'Failed to update support request' });
    }
});

// Get all users
app.get('/api/admin/users', authenticateAdmin, async (req, res) => {
    const { search, limit = 50, offset = 0 } = req.query;

    try {
        let query = `
            SELECT u.id, u.email, u.created_at,
                   COUNT(DISTINCT s.id) as assessment_count,
                   COUNT(DISTINCT sr.id) as support_request_count
            FROM users u
            LEFT JOIN assessment_sessions s ON u.id = s.user_id
            LEFT JOIN support_requests sr ON u.id = sr.user_id
        `;

        const params = [];
        if (search) {
            query += ` WHERE u.email ILIKE $1`;
            params.push(`%${search}%`);
        }

        query += ` GROUP BY u.id ORDER BY u.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(parseInt(limit), parseInt(offset));

        const result = await pool.query(query, params);

        let countQuery = 'SELECT COUNT(*) FROM users';
        if (search) {
            countQuery += ` WHERE email ILIKE '%${search}%'`;
        }
        const countResult = await pool.query(countQuery);

        res.json({
            users: result.rows,
            total: parseInt(countResult.rows[0].count),
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// Get assessment details
app.get('/api/admin/assessments/:id', authenticateAdmin, async (req, res) => {
    const { id } = req.params;

    try {
        const sessionResult = await pool.query(
            `SELECT s.*, u.email as user_email
             FROM assessment_sessions s
             LEFT JOIN users u ON s.user_id = u.id
             WHERE s.id = $1`,
            [id]
        );

        if (sessionResult.rows.length === 0) {
            return res.status(404).json({ error: 'Assessment not found' });
        }

        const answersResult = await pool.query(
            `SELECT a.*, q.question_text, q.question_type
             FROM answers a
             JOIN questions q ON a.question_id = q.id
             WHERE a.session_id = $1`,
            [id]
        );

        res.json({
            session: sessionResult.rows[0],
            answers: answersResult.rows
        });
    } catch (error) {
        console.error('Error fetching assessment details:', error);
        res.status(500).json({ error: 'Failed to fetch assessment details' });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`\n🚀 Server running on port ${PORT}`);
    console.log(`📱 Frontend: http://localhost:${PORT}`);
    console.log(`🔐 Admin login: http://localhost:${PORT}/admin-login`);
    console.log(`📊 Admin dashboard: http://localhost:${PORT}/admin-dashboard.html\n`);
});

module.exports = { app, pool };