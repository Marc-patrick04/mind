const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// FORCE use Neon database - hardcoded for deployment
// IMPORTANT: After testing, move these to Vercel environment variables
const connectionString = 'postgresql://neondb_owner:npg_DZXz0RNUJ7ac@ep-mute-mode-a43dlte2-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require';

const pool = new Pool({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false
  },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});

// Test connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection error:', err.message);
  } else {
    console.log('✅ Connected to Neon PostgreSQL successfully');
    release();
  }
});

const JWT_SECRET = 'mindapp_secret_2024';

// ============= PUBLIC ROUTES =============

app.get('/api/questions', async (req, res) => {
  try {
    console.log('Fetching questions...');
    const result = await pool.query(
      `SELECT id, question_text, question_type, options, scale_min, scale_max, display_order 
       FROM questions WHERE is_active = true ORDER BY display_order`
    );
    console.log(`Found ${result.rows.length} questions`);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching questions:', err.message);
    res.status(500).json({ error: 'Database error: ' + err.message });
  }
});

app.post('/api/assessment/submit', async (req, res) => {
  const client = await pool.connect();
  try {
    const { answers } = req.body;
    await client.query('BEGIN');

    let totalScore = 0;
    for (const answer of answers) {
      const q = await client.query('SELECT question_type, options FROM questions WHERE id = $1', [answer.questionId]);
      if (q.rows.length === 0) continue;

      let points = 0;
      const question = q.rows[0];
      let opts = question.options;
      if (typeof opts === 'string') opts = JSON.parse(opts);

      if (question.question_type === 'yesno') {
        points = answer.answer === 'yes' ? (opts?.yes || 3) : (opts?.no || 0);
      } else if (question.question_type === 'scale') {
        points = parseInt(answer.answer);
      } else if (question.question_type === 'choice') {
        const selected = opts.find(o => o.text === answer.answer);
        points = selected?.points || 0;
      } else if (question.question_type === 'checklist') {
        const items = JSON.parse(answer.answer);
        points = items.reduce((sum, item) => {
          const opt = opts.find(o => o.text === item);
          return sum + (opt?.points || 0);
        }, 0);
      }
      totalScore += points;
    }

    const questionsCount = await client.query('SELECT COUNT(*) FROM questions WHERE is_active = true');
    const maxScore = parseInt(questionsCount.rows[0].count) * 5;
    const percentage = maxScore > 0 ? (totalScore / maxScore) * 100 : 0;

    let riskLevel = 'low', colorCode = '#2ECC71', recommendation = '';
    const thresholds = await client.query('SELECT * FROM risk_thresholds ORDER BY min_score');
    for (const t of thresholds.rows) {
      if (percentage >= t.min_score && percentage <= t.max_score) {
        riskLevel = t.risk_level;
        colorCode = t.color_code;
        recommendation = t.default_recommendation;
        break;
      }
    }

    const session = await client.query(
      `INSERT INTO assessment_sessions (total_score, risk_level, recommendation, completed_at) 
       VALUES ($1, $2, $3, NOW()) RETURNING id, session_token`,
      [totalScore, riskLevel, recommendation]
    );

    for (let i = 0; i < answers.length; i++) {
      await client.query(
        `INSERT INTO answers (session_id, question_id, answer_value) VALUES ($1, $2, $3)`,
        [session.rows[0].id, answers[i].questionId, answers[i].answer.toString()]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, sessionToken: session.rows[0].session_token, totalScore, riskLevel, colorCode, recommendation });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error submitting assessment:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ============= ADMIN ROUTES =============

function authAdmin(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  jwt.verify(token, JWT_SECRET, (err, admin) => {
    if (err || admin.role !== 'admin') return res.status(403).json({ error: 'Invalid token' });
    req.admin = admin;
    next();
  });
}

app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT id, email, password_hash FROM admins WHERE email = $1', [email.toLowerCase()]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, result.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ adminId: result.rows[0].id, email: result.rows[0].email, role: 'admin' }, JWT_SECRET, { expiresIn: '1d' });
    res.json({ success: true, token, admin: { id: result.rows[0].id, email: result.rows[0].email } });
  } catch (err) {
    console.error('Admin login error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/stats', authAdmin, async (req, res) => {
  try {
    const assessments = await pool.query('SELECT COUNT(*) FROM assessment_sessions');
    const support = await pool.query('SELECT COUNT(*) FROM support_requests');
    const pending = await pool.query('SELECT COUNT(*) FROM support_requests WHERE status = $1', ['pending']);
    const risk = await pool.query('SELECT risk_level, COUNT(*) FROM assessment_sessions GROUP BY risk_level');
    const recent = await pool.query(
      `SELECT s.id, s.session_token, s.total_score, s.risk_level, s.created_at, u.email as user_email
       FROM assessment_sessions s LEFT JOIN users u ON s.user_id = u.id ORDER BY s.created_at DESC LIMIT 20`
    );
    res.json({
      totalAssessments: parseInt(assessments.rows[0].count),
      totalSupportRequests: parseInt(support.rows[0].count),
      pendingRequests: parseInt(pending.rows[0].count),
      riskDistribution: risk.rows,
      recentAssessments: recent.rows
    });
  } catch (err) {
    console.error('Error fetching stats:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/questions', authAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM questions ORDER BY display_order');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching questions:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/questions', authAdmin, async (req, res) => {
  const { question_text, question_type, options, scale_min, scale_max, display_order, is_active } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO questions (question_text, question_type, options, scale_min, scale_max, display_order, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [question_text, question_type, options ? JSON.stringify(options) : null, scale_min, scale_max, display_order || 0, is_active !== false]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error creating question:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/questions/:id', authAdmin, async (req, res) => {
  const { id } = req.params;
  const { question_text, question_type, options, scale_min, scale_max, display_order, is_active } = req.body;
  try {
    const result = await pool.query(
      `UPDATE questions SET question_text=$1, question_type=$2, options=$3, scale_min=$4, scale_max=$5, display_order=$6, is_active=$7, updated_at=NOW()
       WHERE id=$8 RETURNING *`,
      [question_text, question_type, options ? JSON.stringify(options) : null, scale_min, scale_max, display_order, is_active, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating question:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/questions/:id', authAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM questions WHERE id=$1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting question:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/thresholds', authAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM risk_thresholds ORDER BY min_score');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching thresholds:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/support-requests', authAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT sr.id, sr.status, sr.created_at, u.email, s.total_score, s.risk_level, s.recommendation
       FROM support_requests sr JOIN users u ON sr.user_id = u.id JOIN assessment_sessions s ON sr.session_id = s.id
       ORDER BY CASE sr.status WHEN 'pending' THEN 1 WHEN 'contacted' THEN 2 ELSE 3 END, sr.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching support requests:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/support-requests/:id/status', authAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    await pool.query('UPDATE support_requests SET status=$1, updated_at=NOW() WHERE id=$2', [status, id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error updating status:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve static files
const path = require('path');
app.use(express.static(path.join(__dirname, '../public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

module.exports = app;