const express = require('express');
const mysql = require('mysql2/promise');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const multer = require('multer');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());

// --- Database Configuration ---
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: 10000 // 10 seconds timeout
});

async function initializeDatabase() {
    try {
        // Test connection
        const connection = await pool.getConnection();
        console.log("✅ Database connection successful");
        connection.release();

        await pool.execute(`
            CREATE TABLE IF NOT EXISTS users (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT,
                name VARCHAR(120) NOT NULL,
                email VARCHAR(255) NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                role ENUM('admin','hr','recruiter','viewer') NOT NULL DEFAULT 'viewer',
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY uq_users_email (email)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);

        await pool.execute(`
            CREATE TABLE IF NOT EXISTS cvs (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                filename VARCHAR(255) NOT NULL,
                email VARCHAR(255) NULL,
                phone VARCHAR(50) NULL,
                skills JSON NULL,
                job_titles JSON NULL,
                languages JSON NULL,
                education VARCHAR(255) NULL,
                experience_years INT NULL,
                file_size BIGINT UNSIGNED NULL,
                file_url VARCHAR(1000) NULL,
                raw_content LONGTEXT NULL,
                created_by INT UNSIGNED NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                KEY idx_cvs_created_by (created_by)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        console.log("✅ Database tables verified/created");
    } catch (error) {
        console.error("❌ Database initialization failed:", error.message);
        if (error.code === 'ECONNREFUSED') {
            console.error("   Check if DB_HOST and DB_PORT are correct and accessible.");
        } else if (error.code === 'ER_ACCESS_DENIED_ERROR') {
            console.error("   Check if DB_USER and DB_PASS are correct.");
        }
    }
}

// --- R2 Configuration (Referencing donationreceipt) ---
const s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
});

const upload = multer({ storage: multer.memoryStorage() });

// --- Auth Routes ---
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, name } = req.body;
        if (!email || !password) return res.status(400).json({ error: "Email and password required" });

        const hashedPassword = await bcrypt.hash(password, 10);
        const [result] = await pool.execute(
            'INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)',
            [email, hashedPassword, name || 'User', 'viewer']
        );

        const secret = process.env.JWT_SECRET || 'your_secret_key';
        const user = { id: result.insertId, email, name: name || 'User' };
        const accessToken = jwt.sign(user, secret, { expiresIn: '7d' });
        const refreshToken = jwt.sign({ id: user.id }, secret, { expiresIn: '30d' });

        res.status(201).json({ 
            success: true, 
            accessToken, 
            refreshToken,
            expiresIn: 604800,
            user 
        });
    } catch (error) {
        console.error("Registration Error:", error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const [rows] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
        const user = rows[0];

        if (!user || !(await bcrypt.compare(password, user.password_hash))) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const secret = process.env.JWT_SECRET || 'your_secret_key';
        const accessToken = jwt.sign({ id: user.id, email: user.email, name: user.name }, secret, { expiresIn: '7d' });
        const refreshToken = jwt.sign({ id: user.id }, secret, { expiresIn: '30d' });

        res.json({ 
            success: true, 
            accessToken, 
            refreshToken,
            expiresIn: 604800,
            user: { id: user.id, email: user.email, name: user.name } 
        });
    } catch (error) {
        console.error("Login Error Details:", {
            message: error.message,
            code: error.code,
            stack: error.stack
        });
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
});

app.post('/api/auth/refresh', async (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: "No refresh token" });
    try {
        const secret = process.env.JWT_SECRET || 'your_secret_key';
        const decoded = jwt.verify(refreshToken, secret);
        const newAccessToken = jwt.sign({ id: decoded.id }, secret, { expiresIn: '7d' });
        res.json({ success: true, accessToken: newAccessToken });
    } catch (e) {
        res.status(401).json({ error: "Invalid refresh token" });
    }
});

app.post('/api/auth/logout', (req, res) => {
    res.json({ success: true, message: "Logged out" });
});

app.get('/api/auth/me', authenticate, async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT id, email, name FROM users WHERE id = ?', [req.user.id]);
        if (rows.length === 0) return res.status(404).json({ error: "User not found" });
        res.json({ success: true, user: rows[0] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- Auth Middleware ---
const authenticate = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        console.warn("Auth failed: No Authorization header");
        return res.status(401).json({ error: "Unauthorized: No token provided" });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
        console.warn("Auth failed: Malformed Authorization header");
        return res.status(401).json({ error: "Unauthorized: Malformed token" });
    }

    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch (e) {
        console.warn("Auth failed: Invalid or expired token", e.message);
        res.status(401).json({ error: "Invalid token" });
    }
};

// --- CV Upload Route ---
app.post('/api/cvs/upload', authenticate, upload.single('file'), async (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });

    const fileName = `${Date.now()}_${file.originalname}`;
    
    try {
        // 1. Upload to R2
        const command = new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: fileName,
            Body: file.buffer,
            ContentType: file.mimetype,
        });
        await s3Client.send(command);

        // 2. Save to Database
        const [result] = await pool.execute(
            'INSERT INTO cvs (filename, file_url, file_size, created_by) VALUES (?, ?, ?, ?)',
            [fileName, fileName, file.size, req.user.id]
        );

        res.json({ 
            success: true, 
            cv: {
              id: result.insertId,
              name: fileName,
              filename: fileName,
              fileSize: file.size,
              fileUrl: fileName,
              createdAt: new Date().toISOString(),
              fields: {} // Fields are currently empty in this simplified version
            }
        });
    } catch (error) {
        console.error("R2 Upload Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- Get Signed URL Route ---
app.get('/api/cvs/:filename/url', authenticate, async (req, res) => {
    try {
        const command = new GetObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: req.params.filename,
        });
        const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        res.json({ success: true, url });
    } catch (error) {
        console.error("R2 Get URL Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- CV List Route ---
app.get('/api/cvs', authenticate, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 20;
        const skip = parseInt(req.query.skip) || 0;
        
        const [rows] = await pool.execute(
            `SELECT id, filename, file_url, created_at, 
             email, phone, skills, job_titles, languages, education, experience_years, file_size, raw_content
             FROM cvs ORDER BY created_at DESC LIMIT ? OFFSET ?`,
            [limit, skip]
        );

        const [countResult] = await pool.execute('SELECT COUNT(*) as total FROM cvs');
        
        // Map to frontend-friendly format if needed, but currently frontend maps it in cv-list-service.ts
        res.json({ 
            success: true, 
            data: rows,
            pagination: { total: countResult[0].total, limit, skip }
        });
    } catch (error) {
        console.error("Fetch CVs Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- CV Detail Route ---
app.get('/api/cvs/:id', authenticate, async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT * FROM cvs WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ error: "CV not found" });
        res.json({ success: true, data: rows[0] });
    } catch (error) {
        console.error("Fetch CV Detail Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- CV Delete Route ---
app.delete('/api/cvs/:id', authenticate, async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT file_url FROM cvs WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ error: "CV not found" });

        const fileUrl = rows[0].file_url;
        if (fileUrl) {
            const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
            await s3Client.send(new DeleteObjectCommand({
                Bucket: process.env.R2_BUCKET_NAME,
                Key: fileUrl,
            }));
        }

        await pool.execute('DELETE FROM cvs WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: "CV deleted successfully" });
    } catch (error) {
        console.error("Delete CV Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- Dashboard Stats Route ---
app.get('/api/stats', authenticate, async (req, res) => {
    try {
        const [totalRows] = await pool.execute('SELECT COUNT(*) as total, SUM(file_size) as totalStorage FROM cvs');
        const [lastUploadRows] = await pool.execute('SELECT created_at FROM cvs ORDER BY created_at DESC LIMIT 1');

        res.json({
            success: true,
            total: totalRows[0].total,
            overview: {
                totalStorage: totalRows[0].totalStorage || 0,
                avgFileSize: totalRows[0].total ? Math.round(totalRows[0].totalStorage / totalRows[0].total) : 0,
                lastUploadDate: lastUploadRows[0]?.created_at || null
            }
        });
    } catch (error) {
        console.error("Stats Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- Dummy Search & Detailed Stats (To prevent Frontend errors) ---
app.get('/api/search', authenticate, (req, res) => {
    res.json({ success: true, data: [] });
});

app.get('/api/stats/:type', authenticate, (req, res) => {
    res.json({ success: true, data: {} });
});

// --- Health Check ---
app.get('/api/status', (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Simplified Server running on port ${PORT}`);
    // Initialize DB in background
    initializeDatabase();
});
